import path from 'node:path'
import { access } from 'node:fs/promises'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { RuntimeConfig } from './config.js'
import type { InstallationRecord, RollbackInput, VersionsInput } from './contracts.js'
import { EvolutionError } from './errors.js'
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

async function artifactAvailable(record: InstallationRecord): Promise<boolean> {
  if (!record.installSpec.startsWith('file:')) return true
  const candidate = record.installSpec.slice('file:'.length)
  if (!path.isAbsolute(candidate)) return false
  return await access(candidate).then(() => true, () => false)
}

/** Order same-package records along predecessor/superseded links, roots first by creation time. */
export function versionChain(records: InstallationRecord[]): InstallationRecord[] {
  const byId = new Map(records.map((record) => [record.id, record]))
  const childByParent = new Map<string, InstallationRecord>()
  const roots: InstallationRecord[] = []
  for (const record of records) {
    const parent = record.predecessorInstallationId ? byId.get(record.predecessorInstallationId) : undefined
    if (parent && parent.supersededByInstallationId === record.id) {
      childByParent.set(parent.id, record)
    } else {
      roots.push(record)
    }
  }
  const byCreatedAt = (left: InstallationRecord, right: InstallationRecord) => left.createdAt.localeCompare(right.createdAt)
  roots.sort(byCreatedAt)
  const ordered: InstallationRecord[] = []
  const seen = new Set<string>()
  const visit = (record: InstallationRecord): void => {
    if (seen.has(record.id)) return
    seen.add(record.id)
    ordered.push(record)
    const child = childByParent.get(record.id)
    if (child) visit(child)
  }
  for (const root of roots) visit(root)
  for (const record of [...records].sort(byCreatedAt)) visit(record)
  return ordered
}

export async function listCapabilityVersions(
  deps: Pick<VersionTrackingDeps, 'store' | 'config' | 'launcher'>,
  input: VersionsInput,
): Promise<CapabilityVersionList> {
  const anchor = input.installationId ? await deps.store.getInstallation(input.installationId) : undefined
  const packageName = input.packageName ?? anchor?.packageName ?? undefined
  if (!packageName) {
    throw new EvolutionError('invalid_input', 'capability_versions requires a package_name or an installation_id with a package identity')
  }
  const records = (await deps.store.listInstallations())
    .filter((record) => record.packageName === packageName && !record.removed)
  const liveSpecByProfile = new Map<string, string | undefined>()
  const liveSpec = async (profile: string): Promise<string | undefined> => {
    if (!liveSpecByProfile.has(profile)) {
      const spec = deps.launcher.profileDependencySpec
        ? await deps.launcher.profileDependencySpec(deps.config.dshHome, profile, packageName).catch(() => undefined)
        : undefined
      liveSpecByProfile.set(profile, spec)
    }
    return liveSpecByProfile.get(profile)
  }
  const versions: CapabilityVersionEntry[] = []
  for (const record of versionChain(records)) {
    versions.push({
      installationId: record.id,
      installSpec: record.installSpec,
      createdAt: record.createdAt,
      ...(record.installOutcome ? { installOutcome: record.installOutcome } : {}),
      ...(record.origin ? { origin: record.origin } : {}),
      verified: record.verified,
      removed: record.removed,
      active: (await liveSpec(record.targetProfile)) === record.installSpec,
      artifactAvailable: await artifactAvailable(record),
      ...(record.predecessorInstallationId ? { predecessorInstallationId: record.predecessorInstallationId } : {}),
      ...(record.supersededByInstallationId ? { supersededByInstallationId: record.supersededByInstallationId } : {}),
    })
  }
  return { packageName, versions }
}

export async function rollbackInstallation(
  deps: VersionTrackingDeps,
  input: RollbackInput,
  exec: ToolRunContext,
): Promise<InstallationRecord> {
  const current = await deps.store.getInstallation(input.installationId)
  if (current.removed) {
    throw new EvolutionError('invalid_input', 'The current installation receipt is already removed; nothing rolls back from it')
  }
  const packageName = current.packageName
  if (!packageName) {
    throw new EvolutionError('invalid_input', 'The current installation receipt has no package identity')
  }
  const targetId = input.targetInstallationId ?? current.predecessorInstallationId
  if (!targetId) {
    throw new EvolutionError('invalid_input', 'No rollback target: the current installation has no predecessor receipt')
  }
  const target = await deps.store.getInstallation(targetId).catch(() => undefined)
  if (!target || target.packageName !== packageName || target.targetProfile !== current.targetProfile) {
    throw new EvolutionError('invalid_input', 'The rollback target is not a same-package receipt for this profile')
  }
  if (target.removed) {
    throw new EvolutionError('invalid_input', 'The rollback target receipt is removed; its install cannot be reconstructed')
  }
  if (!target.reviewId) {
    throw new EvolutionError('review_rejected', 'The rollback target has no linked review; adopted installations cannot be rolled back to')
  }
  if (!await artifactAvailable(target)) {
    throw new EvolutionError('command_failed', 'The rollback target artifact is no longer available on disk')
  }
  const liveSpec = deps.launcher.profileDependencySpec
    ? await deps.launcher.profileDependencySpec(deps.config.dshHome, current.targetProfile, packageName).catch(() => undefined)
    : undefined
  if (!liveSpec || liveSpec !== current.installSpec) {
    throw new EvolutionError('invalid_input', 'The live profile dependency spec does not match the given current installation; pass the active installation_id', {
      expected: current.installSpec,
      actual: liveSpec ?? null,
    })
  }
  const installer = deps.createRollbackInstaller()
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
