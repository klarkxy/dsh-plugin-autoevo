import { mkdir, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { RuntimeConfig } from '../config.js'
import type { InstallationRecord, RemoveInput } from '../contracts.js'
import { EvolutionError } from '../errors.js'
import { copy } from '../i18n.js'
import { assertSafePackageName } from '../package-name.js'
import { sha256 } from '../state/hashes.js'
import type { StateStore } from '../state/store.js'
import { assertOwnedTrialPath, type DshLauncher } from './launcher.js'
import { disableBuiltinMount, parseBuiltinReceiptSpec } from './enable-builtin.js'

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
  const approval = ctx.get('approval')
  if (!approval || !exec.agent) {
    throw new EvolutionError('approval_required', 'A live DSH approval service and Agent turn are required')
  }
  const requirement = await removalRequirement(store, record)
  const outcome = await approval.request({
    agent: exec.agent,
    toolName: 'plugin_remove',
    callId: exec.callId,
    reason: removalApprovalReason(requirement, record),
    signal: exec.signal,
  })
  if (outcome !== 'allowed-once') {
    throw new EvolutionError('approval_required', `The removal was not approved (${outcome})`, { outcome })
  }
}

async function removalRequirement(store: StateStore, record: InstallationRecord): Promise<string> {
  try {
    if (record.reviewId) return (await store.getReview(record.reviewId)).requirement
  } catch {
    // Fall through to the workflow receipt below.
  }
  if (!record.workflowId) return ''
  try {
    return (await store.getWorkflow(record.workflowId)).requirement
  } catch {
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

  /**
   * Uninstalls exactly one installation receipt.
   * Never deletes a managed source repository under the workspace sources dir.
   */
  async remove(input: RemoveInput, exec: ToolRunContext): Promise<RemovalResult> {
    const record = await this.store.getInstallation(input.installationId)
    if (record.removed) {
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
    if (record.retention === 'persistent') {
      await this.assertPersistentOwner(record)
      if (!builtin) {
        if (!this.launcher.profileDependencySpec) {
          throw new EvolutionError('invalid_input', 'This remover host cannot read the exact live profile dependency spec')
        }
        const liveSpec = await this.launcher.profileDependencySpec(
          record.dshHome,
          record.targetProfile,
          packageName!,
        )
        if (liveSpec !== undefined && liveSpec !== record.installSpec) {
          throw new EvolutionError('review_expired', 'Live profile dependency spec changed after this receipt; refusing removal')
        }
      }
    }
    await requestRemovalApproval(this.ctx, this.store, exec, record)
    const cwd = exec.agent?.session.header.cwd ?? process.cwd()
    if (record.retention === 'persistent') {
      if (builtin) {
        await disableBuiltinMount({
          launcher: this.launcher,
          dshHome: record.dshHome,
          targetProfile: record.targetProfile,
          packageName: packageName!,
          spec: builtin,
          cwd,
          ...(exec.signal ? { signal: exec.signal } : {}),
        })
      } else {
        const liveSpec = await this.launcher.profileDependencySpec!(
          record.dshHome,
          record.targetProfile,
          packageName!,
        )
        if (liveSpec !== undefined && liveSpec !== record.installSpec) {
          throw new EvolutionError('review_expired', 'Live profile dependency spec changed after approval; refusing removal')
        }
        if (liveSpec !== undefined) {
          const result = await this.launcher.remove(record.dshHome, record.targetProfile, packageName!, cwd, exec.signal)
          const remainingSpec = await this.launcher.profileDependencySpec!(
            record.dshHome,
            record.targetProfile,
            packageName!,
          )
          if (remainingSpec !== undefined) {
            throw new EvolutionError('command_failed', 'DSH could not remove the persistent plugin dependency', {
              exitCode: result.exitCode,
              diagnosticHash: sha256(result.stderr),
            })
          }
        }
      }
      if (record.ownedArtifactRoot) {
        const artifactsRoot = path.join(this.store.root, 'artifacts')
        await mkdir(artifactsRoot, { recursive: true })
        try {
          const owned = await assertOwnedTrialPath(record.ownedArtifactRoot, artifactsRoot)
          await rm(owned, { recursive: true, force: false })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
    } else {
      const trialsRoot = path.join(this.store.root, 'trials')
      await mkdir(trialsRoot, { recursive: true })
      try {
        const owned = await assertOwnedTrialPath(this.store.trialRoot(record.id), trialsRoot)
        await rm(owned, { recursive: true, force: false })
      } catch (error) {
        // A crash can happen after deleting the owned trial but before the
        // receipt update. Treat an already-absent owned path as recovered.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    const updated: InstallationRecord = { ...record, removed: true }
    await this.store.put('installations', updated)
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
