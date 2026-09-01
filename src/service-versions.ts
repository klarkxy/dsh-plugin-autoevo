import path from 'node:path'
import { access } from 'node:fs/promises'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { RuntimeConfig } from './config.js'
import type { InstallationRecord, RollbackInput, VersionsInput } from './contracts.js'
import { EvolutionError } from './errors.js'
import {
  deriveInstallationLineage,
  installationIdentity,
  normalizedInstallationHome,
} from './installation-lineage.js'
import type { PluginInstaller } from './lifecycle/install.js'
import type { DshLauncher } from './lifecycle/launcher.js'
import { dependencySpecDigest } from './resolver/installed-origin.js'
import type { StateStore } from './state/store.js'

export interface VersionTrackingDeps {
  store: StateStore
  config: RuntimeConfig
  launcher: DshLauncher
  /** Rollback installs through the standard installer; approval still runs inside install(). */
  createRollbackInstaller: () => PluginInstaller
}

export interface CapabilityVersionEntry {
  installationId: string
  installSpec: string
  createdAt: string
  installOutcome?: string
  origin?: InstallationRecord['origin']
  verified: boolean
  removed: boolean
  active: boolean
  artifactAvailable: boolean
  predecessorInstallationId?: string
  supersededByInstallationId?: string
}

export interface CapabilityVersionList {
  packageName: string
  versions: CapabilityVersionEntry[]
}

async function artifactAvailable(record: InstallationRecord, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted()
  if (!record.installSpec.startsWith('file:')) return true
  const candidate = record.installSpec.slice('file:'.length)
  if (!path.isAbsolute(candidate)) return false
  try {
    await access(candidate)
  } catch (error) {
    if (signal?.aborted) throw signal.reason
    return false
  }
  signal?.throwIfAborted()
  return true
}

/** Order same-package records from canonical committed child-to-parent links. */
export function versionChain(records: InstallationRecord[]): InstallationRecord[] {
  return deriveInstallationLineage(records).ordered
}

export async function listCapabilityVersions(
  deps: Pick<VersionTrackingDeps, 'store' | 'config' | 'launcher'>,
  input: VersionsInput,
  signal?: AbortSignal,
): Promise<CapabilityVersionList> {
  signal?.throwIfAborted()
  let anchor: InstallationRecord | undefined
  if (input.installationId) {
    try {
      anchor = await deps.store.getInstallation(input.installationId)
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      throw error
    }
    signal?.throwIfAborted()
  }
  const packageName = input.packageName ?? anchor?.packageName ?? undefined
  if (!packageName) {
    throw new EvolutionError('invalid_input', 'capability_versions requires a package_name or an installation_id with a package identity')
  }
  let listed: InstallationRecord[]
  try {
    listed = await deps.store.listInstallationsStrict()
  } catch (error) {
    if (signal?.aborted) throw signal.reason
    throw error
  }
  signal?.throwIfAborted()
  const records = listed.filter((record) => record.packageName === packageName)
  const lineage = deriveInstallationLineage(records)
  const liveInstallationByIdentity = new Map<string, string | undefined>()
  const liveInstallation = async (record: InstallationRecord): Promise<string | undefined> => {
    const identity = installationIdentity(record)
    if (!identity) return undefined
    if (!liveInstallationByIdentity.has(identity)) {
      signal?.throwIfAborted()
      let spec: string | undefined
      if (deps.launcher.profileDependencySpec) {
        try {
          spec = await deps.launcher.profileDependencySpec(record.dshHome, record.targetProfile, packageName)
        } catch (error) {
          if (signal?.aborted) throw signal.reason
          throw new EvolutionError('command_failed', 'Could not read the live profile dependency state while listing capability versions')
        }
        signal?.throwIfAborted()
      }
      const live = lineage.uniqueLiveLeaf(record, spec)
      if (live.status === 'ambiguous') {
        throw new EvolutionError('command_failed', 'Capability version lineage is ambiguous for the live profile; refusing to report multiple active receipts', {
          recoveryRequired: true,
          stage: 'versions',
          ambiguousCount: live.records.length,
        })
      }
      liveInstallationByIdentity.set(identity, live.status === 'unique' ? live.record.id : undefined)
    }
    return liveInstallationByIdentity.get(identity)
  }
  const versions: CapabilityVersionEntry[] = []
  for (const record of lineage.ordered) {
    signal?.throwIfAborted()
    const activeInstallationId = await liveInstallation(record)
    signal?.throwIfAborted()
    const available = await artifactAvailable(record, signal)
    signal?.throwIfAborted()
    const parent = lineage.parentByChild.get(record.id)
    const successor = lineage.uniqueChild(record.id)
    versions.push({
      installationId: record.id,
      installSpec: record.installSpec,
      createdAt: record.createdAt,
      ...(record.installOutcome ? { installOutcome: record.installOutcome } : {}),
      ...(record.origin ? { origin: record.origin } : {}),
      verified: record.verified,
      removed: record.removed,
      active: activeInstallationId === record.id,
      artifactAvailable: available,
      ...(parent ? { predecessorInstallationId: parent.id } : {}),
      ...(successor ? { supersededByInstallationId: successor.id } : {}),
    })
  }
  return { packageName, versions }
}

export async function rollbackInstallation(
  deps: VersionTrackingDeps,
  input: RollbackInput,
  exec: ToolRunContext,
): Promise<InstallationRecord> {
  exec.signal?.throwIfAborted()
  let current: InstallationRecord
  try {
    current = await deps.store.getInstallation(input.installationId)
    exec.signal?.throwIfAborted()
  } catch (error) {
    if (exec.signal?.aborted) throw exec.signal.reason
    throw error
  }
  if (current.removed) {
    throw new EvolutionError('invalid_input', 'The current installation receipt is already removed; nothing rolls back from it')
  }
  const packageName = current.packageName
  if (!packageName) {
    throw new EvolutionError('invalid_input', 'The current installation receipt has no package identity')
  }
  if (normalizedInstallationHome(current.dshHome) !== normalizedInstallationHome(deps.config.dshHome)) {
    throw new EvolutionError('review_expired', 'The current installation receipt targets a different DSH home; refusing rollback')
  }
  let listed: InstallationRecord[]
  try {
    listed = await deps.store.listInstallationsStrict()
    exec.signal?.throwIfAborted()
  } catch (error) {
    if (exec.signal?.aborted) throw exec.signal.reason
    throw error
  }
  const records = listed.filter((record) => record.packageName === packageName)
  const lineage = deriveInstallationLineage(records)
  const listedCurrent = records.find((record) => record.id === current.id)
  if (!listedCurrent) {
    throw new EvolutionError('invalid_input', 'The current installation is absent from the readable installation lineage')
  }
  const directParent = lineage.parentByChild.get(current.id)
  const targetId = input.targetInstallationId ?? directParent?.id
  if (!targetId) {
    throw new EvolutionError('invalid_input', 'No rollback target: the current installation has no predecessor receipt')
  }
  if (targetId === current.id || !lineage.isAncestor(targetId, current.id)) {
    throw new EvolutionError('invalid_input', 'The rollback target is not an ancestor of the current canonical installation')
  }
  const target = records.find((record) => record.id === targetId)
  if (!target || target.packageName !== packageName || target.targetProfile !== current.targetProfile) {
    throw new EvolutionError('invalid_input', 'The rollback target is not a same-package receipt for this profile')
  }
  if (target.removed) {
    throw new EvolutionError('invalid_input', 'The rollback target receipt is removed; its install cannot be reconstructed')
  }
  if (!target.reviewId) {
    throw new EvolutionError('review_rejected', 'The rollback target has no linked review; adopted installations cannot be rolled back to')
  }
  let targetReview
  try {
    targetReview = await deps.store.getReview(target.reviewId)
    exec.signal?.throwIfAborted()
  } catch (error) {
    if (exec.signal?.aborted) throw exec.signal.reason
    throw new EvolutionError('review_rejected', 'The rollback target linked review is unavailable; review the exact source again before rollback')
  }
  if (!target.artifactSha256
    || !targetReview.artifact
    || target.packageName !== targetReview.manifest.packageName
    || target.installSpec !== targetReview.installSpec
    || target.artifactSha256 !== targetReview.artifact.sha256) {
    throw new EvolutionError(
      'review_rejected',
      'The rollback target receipt no longer matches its frozen linked review; review the exact source again before rollback',
    )
  }
  const available = await artifactAvailable(target, exec.signal)
  exec.signal?.throwIfAborted()
  if (!available) {
    throw new EvolutionError('command_failed', 'The rollback target artifact is no longer available on disk')
  }
  let liveSpec: string | undefined
  if (deps.launcher.profileDependencySpec) {
    try {
      liveSpec = await deps.launcher.profileDependencySpec(deps.config.dshHome, current.targetProfile, packageName)
      exec.signal?.throwIfAborted()
    } catch (error) {
      if (exec.signal?.aborted) throw exec.signal.reason
      liveSpec = undefined
    }
  }
  if (!liveSpec || liveSpec !== current.installSpec) {
    throw new EvolutionError('invalid_input', 'The live profile dependency spec does not match the given current installation; pass the active installation_id', {
      expected: current.installSpec,
      actual: liveSpec ?? null,
    })
  }
  const live = lineage.uniqueLiveLeaf(current, liveSpec)
  if (live.status !== 'unique' || live.record.id !== current.id) {
    throw new EvolutionError('invalid_input', 'The given installation is not the unique canonical live receipt for this profile')
  }
  exec.signal?.throwIfAborted()
  const installer = deps.createRollbackInstaller()
  exec.signal?.throwIfAborted()
  return await installer.install({
    reviewId: target.reviewId,
    targetProfile: current.targetProfile,
    retention: 'persistent',
    replacement: {
      profile: current.targetProfile,
      packageName,
      oldSpecDigest: dependencySpecDigest(liveSpec),
      oldDependencySpec: liveSpec,
      predecessorInstallationId: current.id,
    },
  }, exec)
}
