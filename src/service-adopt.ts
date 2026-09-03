import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { RuntimeConfig } from './config.js'
import type { AdoptInput, InstallationRecord } from './contracts.js'
import { EvolutionError } from './errors.js'
import {
  deriveInstallationLineage,
  installationIdentity,
  type DerivedInstallationLineage,
  type UniqueLiveLeaf,
} from './installation-lineage.js'
import { isRecord } from './internal-utils.js'
import { assertSafePackageName } from './package-name.js'
import { parseExactGithubDependency } from './resolver/installed-origin.js'
import { resolveProfilePluginCapabilities } from './resolver/profile.js'
import { projectInstallation } from './installation-lifecycle.js'
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
  adoptable?: false
  adoptionReason?: string
  repository?: string
  commit?: string
}

export interface OrphanScan {
  profile: string
  orphans: OrphanedInstallation[]
}

type ExactProfileEvidence =
  | { status: 'found'; evidence: OrphanedInstallation }
  | { status: 'unsupported'; evidence: OrphanedInstallation }
  | { status: 'absent' }
  | { status: 'unreadable' }

const OPAQUE_DEPENDENCY_SPEC = /\[(?:local|remote)-reference\]/u

function isOpaqueDependencySpec(dependencySpec: string): boolean {
  return OPAQUE_DEPENDENCY_SPEC.test(dependencySpec)
}

function orphanedInstallation(
  packageName: string,
  dependencySpec: string,
  configuredBundle: boolean,
): OrphanedInstallation {
  const parsed = parseExactGithubDependency(dependencySpec)
  return {
    packageName,
    dependencySpec,
    configuredBundle,
    ...(isOpaqueDependencySpec(dependencySpec)
      ? {
          adoptable: false as const,
          adoptionReason: 'The profile resolver redacted this source reference, so AutoEvo cannot prove an exact adoption identity.',
        }
      : {}),
    ...(parsed ? { repository: parsed.repository, commit: parsed.commit } : {}),
  }
}

function normalizedDshHome(dshHome: string): string {
  const normalized = path.resolve(dshHome)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function adoptedInstallationId(dshHome: string, profile: string, packageName: string): string {
  return `installation_${hashObject({
    kind: 'adopted',
    dshHome: normalizedDshHome(dshHome),
    profile: profile.normalize('NFKC').toLowerCase(),
    packageName: packageName.normalize('NFKC').toLowerCase(),
  }).slice(0, 24)}`
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/** Await `work`; if the signal aborted meanwhile, surface the exact abort reason instead of the read's own error. */
async function awaitOrAbort<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  try {
    const value = await work()
    signal?.throwIfAborted()
    return value
  } catch (error) {
    if (signal?.aborted) throw signal.reason
    throw error
  }
}

/** Only ever rejects with the abort reason; every read failure is reported as `unreadable`. */
async function exactProfileEvidence(
  deps: AdoptDeps,
  profile: string,
  packageName: string,
  signal?: AbortSignal,
): Promise<ExactProfileEvidence> {
  signal?.throwIfAborted()
  let candidates
  try {
    candidates = await resolveProfilePluginCapabilities({
      dshHome: deps.config.dshHome,
      profile,
      requirement: packageName,
      match: () => 1,
    })
  } catch (error) {
    if (signal?.aborted) throw signal.reason
    return { status: 'unreadable' }
  }
  signal?.throwIfAborted()
  const match = candidates.find((candidate) => candidate.profileEvidence?.packageName === packageName)?.profileEvidence
  if (match) {
    const evidence = orphanedInstallation(packageName, match.dependencySpec, match.configuredBundle)
    return {
      status: isOpaqueDependencySpec(match.dependencySpec) ? 'unsupported' : 'found',
      evidence,
    }
  }
  try {
    const home = await realpath(path.resolve(deps.config.dshHome))
    signal?.throwIfAborted()
    const profileRoot = await realpath(path.join(home, 'profiles', profile))
    if (!within(home, profileRoot)) return { status: 'unreadable' }
    const manifestPath = await realpath(path.join(profileRoot, 'package.json'))
    if (!within(profileRoot, manifestPath)) return { status: 'unreadable' }
    const manifest: unknown = JSON.parse(await readFile(manifestPath, { encoding: 'utf8', signal }))
    signal?.throwIfAborted()
    if (!isRecord(manifest)) return { status: 'unreadable' }
    const dependencies = manifest.dependencies
    if (!isRecord(dependencies)) return { status: 'unreadable' }
    return Object.prototype.hasOwnProperty.call(dependencies, packageName)
      ? { status: 'unreadable' }
      : { status: 'absent' }
  } catch (error) {
    if (signal?.aborted) throw signal.reason
    return { status: 'unreadable' }
  }
}

function trackedInstallation(
  installations: readonly InstallationRecord[],
  lineage: DerivedInstallationLineage,
  dshHome: string,
  profile: string,
  packageName: string,
  liveSpec: string,
): UniqueLiveLeaf {
  const targetIdentity = installationIdentity({
    dshHome,
    targetProfile: profile,
    packageName,
  })
  const identityRecord = installations.find((record) => installationIdentity(record) === targetIdentity)
  if (!identityRecord) return { status: 'none' }
  return lineage.uniqueLiveLeaf(identityRecord, liveSpec)
}

export async function scanOrphanedInstallations(
  deps: AdoptDeps,
  options: { signal?: AbortSignal } = {},
): Promise<OrphanScan> {
  options.signal?.throwIfAborted()
  const profile = await awaitOrAbort(() => deps.currentProfile(), options.signal)
  const candidates = await awaitOrAbort(() => resolveProfilePluginCapabilities({
    dshHome: deps.config.dshHome,
    profile,
    requirement: '',
    match: () => 1,
  }), options.signal)
  const installations = await awaitOrAbort(() => deps.store.listInstallationsStrict(), options.signal)
  const lineage = deriveInstallationLineage(installations)
  const orphans: OrphanedInstallation[] = []
  for (const candidate of candidates) {
    options.signal?.throwIfAborted()
    const evidence = candidate.profileEvidence
    if (!evidence) continue
    const tracked = trackedInstallation(
      installations,
      lineage,
      deps.config.dshHome,
      profile,
      evidence.packageName,
      evidence.dependencySpec,
    )
    if (tracked.status !== 'none') continue
    orphans.push(orphanedInstallation(
      evidence.packageName,
      evidence.dependencySpec,
      evidence.configuredBundle,
    ))
  }
  return { profile, orphans }
}

export async function adoptInstallation(
  deps: AdoptDeps,
  input: AdoptInput,
  options: { signal?: AbortSignal; expectedProfile?: string } = {},
): Promise<InstallationRecord> {
  options.signal?.throwIfAborted()
  const packageName = input.packageName?.trim()
  if (!packageName) {
    throw new EvolutionError('invalid_input', 'capability_adopt requires a package_name from the orphan scan')
  }
  assertSafePackageName(packageName)
  const initialProfile = await awaitOrAbort(() => deps.currentProfile(), options.signal)
  if (options.expectedProfile !== undefined && initialProfile !== options.expectedProfile) {
    throw new EvolutionError('review_expired', 'The live profile owner changed before adoption; scan again')
  }
  const initialEvidence = await exactProfileEvidence(deps, initialProfile, packageName, options.signal)
  options.signal?.throwIfAborted()
  if (initialEvidence.status === 'unsupported') {
    throw new EvolutionError('invalid_input', 'This package source is redacted and cannot be adopted as an exact identity', {
      profile: initialProfile,
      dependencySpec: initialEvidence.evidence.dependencySpec,
      unsupported: true,
    })
  }
  if (initialEvidence.status !== 'found') {
    throw new EvolutionError('invalid_input', 'This package is not installed in the current profile; nothing to adopt', {
      profile: initialProfile,
    })
  }
  const id = adoptedInstallationId(deps.config.dshHome, initialProfile, packageName)
  const expectedIdentity = installationIdentity({
    dshHome: deps.config.dshHome,
    targetProfile: initialProfile,
    packageName,
  })
  const installations = await awaitOrAbort(() => deps.store.listInstallationsStrict(), options.signal)
  const lineage = deriveInstallationLineage(installations)
  const tracked = trackedInstallation(
    installations,
    lineage,
    deps.config.dshHome,
    initialProfile,
    packageName,
    initialEvidence.evidence.dependencySpec,
  )
  if (tracked.status === 'ambiguous') {
    throw new EvolutionError('invalid_input', 'The live installation lineage is ambiguous; refusing adoption', {
      recoveryRequired: true,
      ambiguousCount: tracked.records.length,
    })
  }
  if (tracked.status === 'unique' && tracked.record.id !== id) {
    throw new EvolutionError('invalid_input', 'This package is already tracked by a Host installation receipt', {
      installationId: tracked.record.id,
    })
  }
  let existingFinal: InstallationRecord | undefined
  try {
    existingFinal = await deps.store.getInstallation(id)
    options.signal?.throwIfAborted()
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason
    if (!(error instanceof EvolutionError) || error.code !== 'not_found') throw error
  }
  if (existingFinal) {
    if (tracked.status !== 'unique'
      || tracked.record.id !== id
      || existingFinal.origin !== 'adopted'
      || installationIdentity(existingFinal) !== expectedIdentity
      || existingFinal.retention !== 'persistent'
      || existingFinal.installSpec !== initialEvidence.evidence.dependencySpec
      || existingFinal.installPhase !== 'completed'
      || existingFinal.installState !== 'installed'
      || !existingFinal.installed
      || existingFinal.removed
    ) {
      throw new EvolutionError('invalid_input', 'The deterministic adoption receipt is owned by a different or non-final target')
    }
    return existingFinal
  }

  // Only Host store reads happened since the entry evidence read; the claim
  // below is the commit point and the post-claim re-read is the authoritative
  // drift check against it.
  let claim
  try {
    claim = await deps.store.claimAdoption({
      installationId: id,
      dshHome: normalizedDshHome(deps.config.dshHome),
      profile: initialProfile,
      packageName,
      observedSpec: initialEvidence.evidence.dependencySpec,
      configuredBundle: initialEvidence.evidence.configuredBundle,
    })
  } catch (error) {
    if (options.signal?.aborted && !(error instanceof EvolutionError && error.code === 'invalid_input')) {
      throw options.signal.reason
    }
    throw error
  }
  // The append-only claim is the commit point. Immediate cancellation leaves
  // only that claim for a later matching helper.
  options.signal?.throwIfAborted()

  let ownerAfterClaim: string
  try {
    ownerAfterClaim = await deps.currentProfile()
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason
    throw new EvolutionError('command_failed', 'The live profile owner became unreadable after the adoption claim', {
      installationId: id,
      recoveryRequired: true,
    })
  }
  options.signal?.throwIfAborted()
  const evidenceAfterClaim: ExactProfileEvidence = ownerAfterClaim === initialProfile
    ? await exactProfileEvidence(deps, initialProfile, packageName, options.signal)
    : { status: 'unreadable' }
  options.signal?.throwIfAborted()
  if (evidenceAfterClaim.status === 'absent') {
    throw new EvolutionError('not_found', 'The package disappeared after the adoption claim; no installation receipt was created', {
      installationId: id,
    })
  }
  if (evidenceAfterClaim.status !== 'found'
    || evidenceAfterClaim.evidence.dependencySpec !== claim.claim.observedSpec
    || evidenceAfterClaim.evidence.configuredBundle !== claim.claim.configuredBundle) {
    throw new EvolutionError('command_failed', 'The exact live source changed or became unreadable after the adoption claim', {
      installationId: id,
      recoveryRequired: true,
    })
  }

  // The profile claim is append-only, but another writer may have committed a
  // canonical installation while this helper was revalidating live evidence.
  // Re-read strict history immediately before the append-only final receipt.
  const installationsAfterClaim = await awaitOrAbort(() => deps.store.listInstallationsStrict(), options.signal)
  const trackedAfterClaim = trackedInstallation(
    installationsAfterClaim,
    deriveInstallationLineage(installationsAfterClaim),
    deps.config.dshHome,
    initialProfile,
    packageName,
    claim.claim.observedSpec,
  )
  if (trackedAfterClaim.status === 'ambiguous') {
    throw new EvolutionError('invalid_input', 'The live installation lineage became ambiguous after the adoption claim', {
      installationId: id,
      recoveryRequired: true,
      ambiguousCount: trackedAfterClaim.records.length,
    })
  }
  if (trackedAfterClaim.status === 'unique' && trackedAfterClaim.record.id !== id) {
    throw new EvolutionError('invalid_input', 'Another Host installation receipt tracked this package after the adoption claim', {
      installationId: trackedAfterClaim.record.id,
      recoveryRequired: true,
    })
  }

  const completed: InstallationRecord = projectInstallation({
    schemaVersion: 2,
    id,
    createdAt: claim.claim.createdAt,
    origin: 'adopted',
    targetProfile: initialProfile,
    retention: 'persistent',
    dshHome: deps.config.dshHome,
    packageName,
    installSpec: claim.claim.observedSpec,
    installPhase: 'completed',
    installState: 'installed',
    installOutcome: 'awaiting_user_test',
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
      reason: 'Adopted from the exact live profile source; the Host has not verified this installation.',
    },
  })
  let final
  try {
    final = await deps.store.createInstallationExclusive(completed)
  } catch (error) {
    if (options.signal?.aborted && !(error instanceof EvolutionError && error.code === 'invalid_input')) {
      throw options.signal.reason
    }
    throw error
  }
  options.signal?.throwIfAborted()
  const persisted = final.installation
  if (persisted.origin !== 'adopted'
    || installationIdentity(persisted) !== expectedIdentity
    || persisted.retention !== 'persistent'
    || persisted.installSpec !== claim.claim.observedSpec
    || persisted.installPhase !== 'completed'
    || persisted.installState !== 'installed'
    || !persisted.installed
    || persisted.removed
  ) {
    throw new EvolutionError('invalid_input', 'A different adoption result already owns the deterministic installation receipt')
  }

  let ownerAfterFinal: string
  try {
    ownerAfterFinal = await deps.currentProfile()
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason
    throw new EvolutionError('command_failed', 'The live profile owner became unreadable after adoption finalized', {
      installationId: id,
      recoveryRequired: true,
    })
  }
  options.signal?.throwIfAborted()
  const evidenceAfterFinal: ExactProfileEvidence = ownerAfterFinal === initialProfile
    ? await exactProfileEvidence(deps, initialProfile, packageName, options.signal)
    : { status: 'unreadable' }
  options.signal?.throwIfAborted()
  if (evidenceAfterFinal.status !== 'found'
    || evidenceAfterFinal.evidence.dependencySpec !== persisted.installSpec
    || evidenceAfterFinal.evidence.configuredBundle !== claim.claim.configuredBundle) {
    throw new EvolutionError('command_failed', 'The live source drifted after the adopted receipt finalized', {
      installationId: id,
      recoveryRequired: true,
    })
  }
  return persisted
}
