import { mkdir, realpath, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { RuntimeConfig } from '../config.js'
import type { InstallationRecord, RemoveInput } from '../contracts.js'
import { EvolutionError } from '../errors.js'
import { copy } from '../i18n.js'
import { deriveInstallationLineage } from '../installation-lineage.js'
import { assertSafePackageName } from '../package-name.js'
import { sha256 } from '../state/hashes.js'
import type { StateStore } from '../state/store.js'
import { assertOwnedTrialPath, type DshLauncher } from './launcher.js'
import { builtinMountPresent, disableBuiltinMount, parseBuiltinReceiptSpec, type BuiltinReceiptSpec } from './enable-builtin.js'

async function canonicalPath(candidate: string): Promise<string> {
  const resolved = path.resolve(candidate)
  const canonical = await realpath(resolved).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return resolved
    throw error
  })
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

function validateProfile(profile: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u.test(profile)) {
    throw new EvolutionError('invalid_input', 'Installation receipt contains an unsafe target profile')
  }
}

export function removalApprovalReason(requirement: string, record: InstallationRecord): string {
  return copy(
    requirement,
    `Remove reviewed installation ${record.id} from profile ${record.targetProfile} (${record.retention}).`,
    `将已审查的安装 ${record.id} 从 profile ${record.targetProfile} 移除（${record.retention}）。`,
  )
}

async function requestRemovalApproval(
  ctx: Context,
  store: StateStore,
  exec: ToolRunContext,
  record: InstallationRecord,
): Promise<void> {
  exec.signal?.throwIfAborted()
  const approval = ctx.get('approval')
  if (!approval || !exec.agent) {
    throw new EvolutionError('approval_required', 'A live DSH approval service and Agent turn are required')
  }
  const requirement = await removalRequirement(store, record, exec.signal)
  exec.signal?.throwIfAborted()
  let outcome: string
  try {
    outcome = await approval.request({
      agent: exec.agent,
      toolName: 'plugin_remove',
      callId: exec.callId,
      reason: removalApprovalReason(requirement, record),
      signal: exec.signal,
    })
  } catch (error) {
    if (exec.signal?.aborted) throw exec.signal.reason
    throw error
  }
  exec.signal?.throwIfAborted()
  if (outcome !== 'allowed-once') {
    throw new EvolutionError('approval_required', `The removal was not approved (${outcome})`, { outcome })
  }
}

async function removalRequirement(store: StateStore, record: InstallationRecord, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  try {
    if (record.reviewId) return (await store.getReview(record.reviewId)).requirement
  } catch (error) {
    if (signal?.aborted) throw signal.reason
    // Fall through to the workflow receipt below.
  }
  signal?.throwIfAborted()
  if (!record.workflowId) return ''
  try {
    return (await store.getWorkflow(record.workflowId)).requirement
  } catch (error) {
    if (signal?.aborted) throw signal.reason
    return ''
  }
}

export interface RemovalResult {
  installationId: string
  removed: boolean
  stillVisible: boolean
  cleanup: string
  restartRequired: boolean
}

export class PluginRemover {
  constructor(
    private readonly ctx: Context,
    private readonly config: RuntimeConfig,
    private readonly store: StateStore,
    private readonly launcher: DshLauncher,
    private readonly resolveDestinationProfile?: () => Promise<string>,
  ) {}

  private async assertPersistentOwner(record: InstallationRecord): Promise<void> {
    validateProfile(record.targetProfile)
    if (await canonicalPath(record.dshHome) !== await canonicalPath(this.config.dshHome)) {
      throw new EvolutionError('review_expired', 'Installation receipt no longer targets the configured DSH home; refusing removal')
    }
    if (this.resolveDestinationProfile) {
      const currentProfile = await this.resolveDestinationProfile()
      if (currentProfile !== record.targetProfile) {
        throw new EvolutionError('review_expired', 'Installation receipt no longer targets the live DSH profile; refusing removal')
      }
    }
  }

  private recoveryRequired(record: InstallationRecord, message: string, cause?: unknown): EvolutionError {
    return new EvolutionError('command_failed', message, {
      installationId: record.id,
      recoveryRequired: true,
      stage: 'remove',
      ...(cause ? { diagnosticHash: sha256(cause instanceof Error ? cause.message : String(cause)) } : {}),
    })
  }

  private async assertCanonicalLiveReceipt(
    record: InstallationRecord,
    builtin: BuiltinReceiptSpec | undefined,
    packageName: string,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted()
    let records: InstallationRecord[]
    try {
      records = await this.store.listInstallationsStrict()
      signal?.throwIfAborted()
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      throw error
    }
    const lineage = deriveInstallationLineage(records)
    let liveSpec: string | undefined
    if (builtin) {
      liveSpec = record.installSpec
    } else {
      if (!this.launcher.profileDependencySpec) {
        throw new EvolutionError('invalid_input', 'This remover host cannot read the exact live profile dependency spec')
      }
      try {
        liveSpec = await this.launcher.profileDependencySpec(
          record.dshHome,
          record.targetProfile,
          packageName,
        )
        signal?.throwIfAborted()
      } catch (error) {
        if (signal?.aborted) throw signal.reason
        throw error
      }
    }
    const live = lineage.uniqueLiveLeaf(record, liveSpec)
    if (live.status === 'ambiguous') {
      throw new EvolutionError('command_failed', 'Installation lineage is ambiguous; refusing removal from a non-unique live receipt', {
        installationId: record.id,
        recoveryRequired: true,
        stage: 'remove',
        ambiguousCount: live.records.length,
      })
    }
    if (live.status !== 'unique' || live.record.id !== record.id) {
      throw new EvolutionError('review_expired', 'The selected installation is not the unique canonical live receipt; refusing removal')
    }
  }

  private async cleanupOwned(record: InstallationRecord): Promise<void> {
    if (record.retention === 'persistent') {
      if (!record.ownedArtifactRoot) return
      const artifactsRoot = path.join(this.store.root, 'artifacts')
      await mkdir(artifactsRoot, { recursive: true })
      try {
        const owned = await assertOwnedTrialPath(record.ownedArtifactRoot, artifactsRoot)
        await rm(owned, { recursive: true, force: false })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      return
    }
    const trialsRoot = path.join(this.store.root, 'trials')
    await mkdir(trialsRoot, { recursive: true })
    try {
      const owned = await assertOwnedTrialPath(this.store.trialRoot(record.id), trialsRoot)
      await rm(owned, { recursive: true, force: false })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  private async persistInterruptedRemoval(record: InstallationRecord): Promise<void> {
    try {
      await this.store.put('installations', this.removedRecord(record))
    } catch (cause) {
      throw this.recoveryRequired(
        record,
        'Removal completed during cancellation, but the removed receipt could not be persisted; the old receipt remains the recovery anchor',
        cause,
      )
    }
  }

  private removedRecord(record: InstallationRecord): InstallationRecord {
    return {
      ...record,
      installState: 'not_installed',
      installed: false,
      loaded: record.retention === 'persistent' ? record.loaded : false,
      verified: false,
      restartRequired: record.retention === 'persistent',
      removed: true,
    }
  }

  private canonicalRemovalTombstone(record: InstallationRecord): boolean {
    return record.removed === true
      && record.installed === false
      && record.installState === 'not_installed'
      && record.verified === false
      && (!record.loaded || record.restartRequired)
  }

  private async reconcileLegacyRemovalTombstone(record: InstallationRecord, exec: ToolRunContext): Promise<void> {
    exec.signal?.throwIfAborted()
    if (record.retention === 'temporary') {
      try {
        await stat(this.store.trialRoot(record.id))
        throw new EvolutionError('invalid_input', 'Legacy removed receipt still has an owned trial; refusing to trust the tombstone')
      } catch (error) {
        if (exec.signal?.aborted) throw exec.signal.reason
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    } else if (record.retention === 'persistent') {
      await this.assertPersistentOwner(record)
      exec.signal?.throwIfAborted()
      const packageName = assertSafePackageName(record.packageName)
      const builtin = parseBuiltinReceiptSpec(record.installSpec)
      let absent = false
      try {
        if (builtin) {
          absent = !await builtinMountPresent({
            dshHome: record.dshHome,
            targetProfile: record.targetProfile,
            mountId: builtin.mountId,
            packageName,
          })
        } else {
          if (!this.launcher.profileDependencySpec) {
            throw new EvolutionError('invalid_input', 'This remover host cannot reconcile a legacy removed receipt')
          }
          absent = await this.launcher.profileDependencySpec(
            record.dshHome,
            record.targetProfile,
            packageName,
          ) === undefined
        }
        exec.signal?.throwIfAborted()
      } catch (error) {
        if (exec.signal?.aborted) throw exec.signal.reason
        throw error
      }
      if (!absent) {
        throw new EvolutionError('invalid_input', 'Legacy removed receipt still has a live profile dependency; refusing to trust the tombstone')
      }
    } else {
      throw new EvolutionError('invalid_input', 'Legacy removed receipt has invalid retention')
    }
    exec.signal?.throwIfAborted()
    await this.store.put('installations', this.removedRecord(record))
    exec.signal?.throwIfAborted()
  }

  private async settleInterruptedRemoval(input: {
    record: InstallationRecord
    builtin: BuiltinReceiptSpec | undefined
    packageName: string | undefined
    cwd: string
  }): Promise<void> {
    const { record, builtin, packageName, cwd } = input
    if (record.retention === 'persistent' && builtin) {
      try {
        await disableBuiltinMount({
          launcher: this.launcher,
          dshHome: record.dshHome,
          targetProfile: record.targetProfile,
          packageName: packageName!,
          spec: builtin,
          cwd,
          allowAbsent: true,
        })
      } catch (cause) {
        throw this.recoveryRequired(
          record,
          'Cancellation interrupted built-in removal and the exact owned mount state could not be reconciled',
          cause,
        )
      }
    } else if (record.retention === 'persistent') {
      let liveSpec: string | undefined
      try {
        liveSpec = await this.launcher.profileDependencySpec(
          record.dshHome,
          record.targetProfile,
          packageName!,
        )
      } catch (cause) {
        throw this.recoveryRequired(
          record,
          'Cancellation interrupted removal and the live profile dependency could not be read safely',
          cause,
        )
      }
      if (liveSpec === record.installSpec) return
      if (liveSpec !== undefined) {
        throw this.recoveryRequired(
          record,
          'Cancellation interrupted removal and a different live dependency now owns the package; replacement was preserved',
        )
      }
    }
    try {
      await this.cleanupOwned(record)
    } catch (cause) {
      throw this.recoveryRequired(record, 'Removal completed during cancellation, but owned cleanup could not be confirmed', cause)
    }
    await this.persistInterruptedRemoval(record)
  }

  /**
   * Uninstalls exactly one installation receipt.
   * Never deletes a managed source repository under the workspace sources dir.
   */
  async remove(input: RemoveInput, exec: ToolRunContext): Promise<RemovalResult> {
    exec.signal?.throwIfAborted()
    try {
      const initial = await this.store.getInstallation(input.installationId)
      exec.signal?.throwIfAborted()
      if (initial.removed === true && !this.canonicalRemovalTombstone(initial)) {
        await this.reconcileLegacyRemovalTombstone(initial, exec)
      }
    } catch (error) {
      if (exec.signal?.aborted) throw exec.signal.reason
      if (!(error instanceof EvolutionError && error.code === 'not_found')) throw error
    }
    let record: InstallationRecord
    try {
      const records = await this.store.listInstallationsStrict()
      exec.signal?.throwIfAborted()
      const exact = records.find((item) => item.id === input.installationId)
      if (!exact) {
        throw new EvolutionError('not_found', 'Unknown installation id', { id: input.installationId })
      }
      record = exact
    } catch (error) {
      if (exec.signal?.aborted) throw exec.signal.reason
      throw error
    }
    if (record.removed) {
      if (!this.canonicalRemovalTombstone(record)) {
        throw new EvolutionError('invalid_input', 'Removed receipt is not a canonical tombstone; refusing removal success')
      }
      return {
        installationId: record.id,
        removed: true,
        stillVisible: false,
        cleanup: 'The installation receipt was already marked removed.',
        restartRequired: record.retention === 'persistent',
      }
    }
    const packageName = record.retention === 'persistent'
      ? assertSafePackageName(record.packageName)
      : undefined
    const builtin = record.retention === 'persistent' ? parseBuiltinReceiptSpec(record.installSpec) : undefined
    const persistentCleanupOnly = record.retention === 'persistent'
      && ((!record.installed
          && record.installState === 'not_installed'
          && record.installOutcome === 'failed_absent')
        || Boolean(builtin && !builtin.wrote))
    try {
      exec.signal?.throwIfAborted()
      if (record.retention === 'persistent') {
        await this.assertPersistentOwner(record)
        exec.signal?.throwIfAborted()
        if (!persistentCleanupOnly) {
          await this.assertCanonicalLiveReceipt(record, builtin, packageName!, exec.signal)
          exec.signal?.throwIfAborted()
        }
      }
      await requestRemovalApproval(this.ctx, this.store, exec, record)
      exec.signal?.throwIfAborted()
    } catch (error) {
      if (exec.signal?.aborted) throw exec.signal.reason
      throw error
    }
    const cwd = exec.agent?.session.header.cwd ?? process.cwd()
    let effectError: unknown
    try {
      exec.signal?.throwIfAborted()
      if (record.retention === 'persistent') {
        if (!persistentCleanupOnly) {
          await this.assertCanonicalLiveReceipt(record, builtin, packageName!, exec.signal)
          exec.signal?.throwIfAborted()
        }
        if (persistentCleanupOnly) {
          // Proven no profile effect: cleanup below is confined to the exact
          // Host-owned artifact root and cannot remove a replacement package.
        } else if (builtin) {
          await disableBuiltinMount({
            launcher: this.launcher,
            dshHome: record.dshHome,
            targetProfile: record.targetProfile,
            packageName: packageName!,
            spec: builtin,
            cwd,
            allowAbsent: true,
            ...(exec.signal ? { signal: exec.signal } : {}),
          })
        } else {
          const result = await this.launcher.remove(record.dshHome, record.targetProfile, packageName!, cwd, exec.signal)
          exec.signal?.throwIfAborted()
          const remainingSpec = await this.launcher.profileDependencySpec(
            record.dshHome,
            record.targetProfile,
            packageName!,
          )
          exec.signal?.throwIfAborted()
          if (remainingSpec !== undefined) {
            throw new EvolutionError('command_failed', 'DSH could not remove the persistent plugin dependency', {
              exitCode: result.exitCode,
              diagnosticHash: sha256(result.stderr),
            })
          }
        }
      } else {
        await this.cleanupOwned(record)
      }
    } catch (error) {
      effectError = error
    }
    if (exec.signal?.aborted) {
      await this.settleInterruptedRemoval({ record, builtin, packageName, cwd })
      throw exec.signal.reason
    }
    if (effectError) throw effectError
    if (record.retention === 'persistent') {
      try {
        await this.cleanupOwned(record)
      } catch (error) {
        if (exec.signal?.aborted) {
          await this.settleInterruptedRemoval({ record, builtin, packageName, cwd })
          throw exec.signal.reason
        }
        throw error
      }
    }
    if (exec.signal?.aborted) {
      await this.settleInterruptedRemoval({ record, builtin, packageName, cwd })
      throw exec.signal.reason
    }
    const updated = this.removedRecord(record)
    try {
      await this.store.put('installations', updated)
    } catch (error) {
      if (exec.signal?.aborted) {
        throw this.recoveryRequired(
          record,
          'Removal completed during cancellation, but the removed receipt could not be persisted; the old receipt remains the recovery anchor',
          error,
        )
      }
      throw error
    }
    if (exec.signal?.aborted) throw exec.signal.reason
    return {
      installationId: record.id,
      removed: true,
      stillVisible: record.retention === 'persistent',
      cleanup: record.retention === 'temporary'
        ? 'The owned isolated DSH trial directory was removed.'
        : 'The profile manifest was updated; a running profile may retain the old bundle until restart.',
      restartRequired: record.retention === 'persistent',
    }
  }
}
