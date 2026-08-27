import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { RuntimeConfig } from './config.js'
import type { AdoptInput, InstallationRecord } from './contracts.js'
import { EvolutionError } from './errors.js'
import { parseExactGithubDependency } from './resolver/installed-origin.js'
import { resolveProfilePluginCapabilities } from './resolver/profile.js'
import { hashObject } from './state/hashes.js'
import type { StateStore } from './state/store.js'

export interface AdoptDeps {
  store: StateStore
  config: RuntimeConfig
  /** Owner of the live DSH process; adopted receipts always target the current profile. */
  currentProfile: () => Promise<string>
}

export interface OrphanedInstallation {
  packageName: string
  dependencySpec: string
  configuredBundle: boolean
  repository?: string
  commit?: string
}

export interface OrphanScan {
  profile: string
  orphans: OrphanedInstallation[]
}

function normalizedDshHome(dshHome: string): string {
  const normalized = path.resolve(dshHome)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isActiveTrackedInstallation(
  record: InstallationRecord,
  dshHome: string,
  profile: string,
  packageName: string,
): boolean {
  return !record.removed
    && !record.supersededByInstallationId
    && record.packageName === packageName
    && normalizedDshHome(record.dshHome) === normalizedDshHome(dshHome)
    && record.targetProfile === profile
}

export async function scanOrphanedInstallations(deps: AdoptDeps): Promise<OrphanScan> {
  const profile = await deps.currentProfile()
  const candidates = await resolveProfilePluginCapabilities({
    dshHome: deps.config.dshHome,
    profile,
    requirement: '',
    match: () => 1,
  })
  const installations = await deps.store.listInstallations()
  const orphans: OrphanedInstallation[] = []
  for (const candidate of candidates) {
    const evidence = candidate.profileEvidence
    if (!evidence || installations.some((record) => isActiveTrackedInstallation(
      record,
      deps.config.dshHome,
      profile,
      evidence.packageName,
    ))) continue
    const parsed = parseExactGithubDependency(evidence.dependencySpec)
    orphans.push({
      packageName: evidence.packageName,
      dependencySpec: evidence.dependencySpec,
      configuredBundle: evidence.configuredBundle,
      ...(parsed ? { repository: parsed.repository, commit: parsed.commit } : {}),
    })
  }
  return { profile, orphans }
}

export async function adoptInstallation(deps: AdoptDeps, input: AdoptInput): Promise<InstallationRecord> {
  const packageName = input.packageName?.trim()
  if (!packageName) {
    throw new EvolutionError('invalid_input', 'capability_adopt requires a package_name from the orphan scan')
  }
  const scan = await scanOrphanedInstallations(deps)
  const tracked = (await deps.store.listInstallations())
    .find((record) => isActiveTrackedInstallation(record, deps.config.dshHome, scan.profile, packageName))
  if (tracked) {
    throw new EvolutionError('invalid_input', 'This package is already tracked by a Host installation receipt', {
      installationId: tracked.id,
    })
  }
  const orphan = scan.orphans.find((item) => item.packageName === packageName)
  if (!orphan) {
    throw new EvolutionError('invalid_input', 'This package is not installed in the current profile; nothing to adopt', {
      profile: scan.profile,
    })
  }
  const createdAt = new Date().toISOString()
  const record: InstallationRecord = {
    schemaVersion: 1,
    id: `installation_${hashObject({ packageName, spec: orphan.dependencySpec, at: createdAt, nonce: randomUUID() }).slice(0, 24)}`,
    createdAt,
    origin: 'adopted',
    targetProfile: scan.profile,
    retention: 'persistent',
    dshHome: deps.config.dshHome,
    packageName,
    installSpec: orphan.dependencySpec,
    installState: 'installed',
    installed: true,
    loaded: false,
    verified: false,
    restartRequired: false,
    removed: false,
    verification: {
      attempted: false,
      expectedTools: [],
      calledTools: [],
      resultTools: [],
      failedTools: [],
      sessionFiles: [],
      taskResultObserved: false,
      reason: 'Adopted from the live profile; the Host has not verified this installation.',
    },
  }
  await deps.store.put('installations', record)
  return record
}
