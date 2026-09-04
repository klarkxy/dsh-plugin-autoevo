import { randomUUID } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { RuntimeConfig } from '../config.js'
import type {
  InstallFailureRecovery,
  InstallationState,
  InstallInput,
  InstallationRecord,
  InstallOutcome,
  ReplacementJournal,
  ReplacementTarget,
  ReviewRecord,
  VerificationEvidence,
  VerificationLayerKind,
  VerificationStatus,
} from '../contracts.js'
import { validateGithubRepository } from '../github/discovery.js'
import { managedSnapshotRootReview } from '../resolver/lineage.js'
import { EvolutionError, errorMessage } from '../errors.js'
import {
  deriveInstallationLineage,
  installationIdentity,
} from '../installation-lineage.js'
import { projectInstallation } from '../installation-lifecycle.js'
import { copy } from '../i18n.js'
import {
  hostLayerSuccess,
  sanitizeHostVerificationEvidence,
  selectInstallVerificationLayer,
} from '../host-verification-driver.js'
import { assertSafePackageName } from '../package-name.js'
import { assertDirectUseAllowed, type InstallCommitmentBinding, type ReviewCandidateContext } from '../review/direct-use.js'
import { hashObject, sha256 } from '../state/hashes.js'
import type { StateStore } from '../state/store.js'
import { boundedAgentText } from '../workflow/sanitize.js'
import type { DshLauncher } from './launcher.js'
import { hotLoadInstalledBundle, type HotReloadAttempt } from './hot-load.js'

export type InstallAuthorizer = (
  review: ReviewRecord,
  exec: ToolRunContext,
  binding?: InstallCommitmentBinding,
) => void | Promise<void>
export type ProfileHotLoader = (input: {
  ctx: Context
  dshHome: string
  profile: string
  packageName: string
  expectedTools: readonly string[]
  agent?: ToolRunContext['agent']
  signal?: AbortSignal
}) => Promise<HotReloadAttempt>

export interface PluginInstallerOptions {
  ctx: Context
  config: RuntimeConfig
  store: StateStore
  launcher: DshLauncher
  /** Workflow-bound authorization. Absent means the review's own direct-use gate decides. */
  authorizeInstall?: InstallAuthorizer
  hotLoader?: ProfileHotLoader
  /** Live DSH profile owner; install refuses to mutate a profile the Host does not own. */
  resolveDestinationProfile?: () => Promise<string>
}

function validateProfile(profile: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(profile)) {
    throw new EvolutionError('invalid_input', 'targetProfile must be a simple DSH profile name')
  }
}

function pendingVerification(expectedTools: readonly string[]): VerificationEvidence {
  return {
    attempted: false,
    expectedTools: [...expectedTools],
    calledTools: [],
    resultTools: [],
    failedTools: [],
    sessionFiles: [],
    taskResultObserved: false,
    reason: 'Provisional receipt: installation and verification have not completed.',
  }
}

function interruptedVerification(
  expectedTools: readonly string[],
  layer: VerificationLayerKind,
): VerificationEvidence {
  return sanitizeHostVerificationEvidence({
    attempted: true,
    layer,
    status: 'uncertain',
    expectedTools,
    exitCode: null,
    reason: 'Host verification could not complete; the same fixture digest will not be retried.',
  })
}

function manualRuntimeEvidence(expectedTools: readonly string[], reason: string): VerificationEvidence {
  return sanitizeHostVerificationEvidence({
    attempted: false,
    layer: 'manual_runtime',
    status: 'pending_user_test',
    expectedTools,
    sourceMatched: true,
    reason,
  })
}

function sourceMismatchEvidence(expectedTools: readonly string[]): VerificationEvidence {
  return sanitizeHostVerificationEvidence({
    attempted: false,
    layer: 'manual_runtime',
    status: 'blocked_precondition',
    expectedTools,
    sourceMatched: false,
    reason: 'The install command finished, but the target profile did not record the exact reviewed source as an active bundle.',
  })
}

type InstallFailure = NonNullable<InstallationRecord['installFailure']>
/** Stages this installer produces. `preflight` remains readable on legacy receipts only. */
type InstallFailureStage = Exclude<NonNullable<InstallFailure['stage']>, 'preflight'>
type RecoveryInstallOptions = {
  minimumReleaseAgeExcludes?: string[]
  expectedProfileStoreFingerprint?: string
}

function parsedInstallRecovery(value: unknown): InstallFailureRecovery | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const item = value as Record<string, unknown>
  if (item.kind === 'profile_store_mismatch'
    && item.owner === 'pnpm'
    && item.code === 'ERR_PNPM_UNEXPECTED_STORE') {
    return {
      kind: 'profile_store_mismatch',
      owner: 'pnpm',
      code: 'ERR_PNPM_UNEXPECTED_STORE',
      scope: 'unknown',
      reuseEligible: false,
    }
  }
  if (item.kind !== 'minimum_release_age'
    || item.owner !== 'pnpm'
    || item.code !== 'ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION'
    || item.policyKey !== 'minimumReleaseAge'
    || !Array.isArray(item.entries)
    || item.entries.length < 1
    || item.entries.length > 8) return undefined
  const entries = item.entries.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const record = entry as Record<string, unknown>
    if (typeof record.packageName !== 'string'
      || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/iu.test(record.packageName)
      || typeof record.version !== 'string'
      || !/^[0-9a-z][0-9a-z.+_-]*$/iu.test(record.version)
      || typeof record.reason !== 'string') return []
    const reason = boundedAgentText(record.reason, 220)
    return reason ? [{ packageName: record.packageName, version: record.version, reason }] : []
  })
  if (entries.length !== item.entries.length
    || new Set(entries.map((entry) => `${entry.packageName.toLowerCase()}@${entry.version}`)).size !== entries.length) return undefined
  return {
    kind: 'minimum_release_age',
    owner: 'pnpm',
    code: 'ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION',
    policyKey: 'minimumReleaseAge',
    entries,
    scope: 'unknown',
    exceptionEligible: false,
  }
}

function repairHintsFor(stage: InstallFailureStage): string[] {
  switch (stage) {
    case 'install':
      return [
        'Inspect the displayed DSH/pnpm diagnostic summary and current profile dependency; use diagnosticHash only to correlate the failure evidence.',
        'Repair the reviewed source or profile configuration explicitly, then resume the workflow before retrying.',
      ]
    case 'load':
      return [
        'Restart or repair the current profile before attempting another mutation.',
        'Confirm the exact receipt source is still present before retrying activation.',
      ]
    case 'verify':
      return [
        'Inspect the verification status and expected tool or bundle evidence recorded on this receipt.',
        'Repair and re-review the source before retrying automatic verification.',
      ]
    case 'persist':
      return [
        'Recover this installation by its installationId before starting another install.',
        'Inspect AutoEvo state storage health, then reconcile the exact live profile source.',
      ]
  }
}

function normalizedSummary(text: string): string {
  return text.normalize('NFKC').replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim().slice(0, 400)
}

function lifecycleFailure(
  stage: InstallFailureStage,
  code: string,
  summary: string,
  retryable = true,
): InstallFailure {
  const message = normalizedSummary(summary)
  return {
    stage,
    code,
    summary: message,
    message,
    retryable,
    repairHints: repairHintsFor(stage),
  }
}

function installFailure(error: unknown, stage: InstallFailureStage): InstallFailure {
  if (error instanceof EvolutionError) {
    const message = normalizedSummary(error.message)
    const exitCode = typeof error.details.exitCode === 'number' || error.details.exitCode === null
      ? error.details.exitCode
      : undefined
    const diagnosticHash = typeof error.details.diagnosticHash === 'string'
      && /^[a-f0-9]{64}$/u.test(error.details.diagnosticHash)
      ? error.details.diagnosticHash
      : undefined
    const diagnosticSummary = typeof error.details.diagnosticSummary === 'string'
      ? boundedAgentText(error.details.diagnosticSummary, 400)
      : undefined
    const recovery = parsedInstallRecovery(error.details.recovery)
    return {
      stage,
      code: error.code,
      summary: diagnosticSummary || message,
      message,
      retryable: error.code === 'command_failed',
      repairHints: repairHintsFor(stage),
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(diagnosticHash ? { diagnosticHash } : {}),
      ...(recovery ? { recovery } : {}),
    }
  }
  return lifecycleFailure(stage, 'command_failed', normalizedSummary(errorMessage(error)) || 'Unknown installation failure')
}

function failedInstallation(
  expectedTools: readonly string[],
  outcome: InstallOutcome,
  failure: InstallFailure,
): VerificationEvidence {
  const diagnostic = failure.diagnosticHash ? ` Diagnostic sha256: ${failure.diagnosticHash}.` : ''
  return {
    attempted: false,
    expectedTools: [...expectedTools],
    calledTools: [],
    resultTools: [],
    failedTools: [],
    sessionFiles: [],
    taskResultObserved: false,
    reason: (outcome === 'failed_absent'
      ? 'The DSH installation command did not complete successfully and profile reconciliation confirmed the dependency is absent.'
      : 'The DSH installation command did not complete successfully and the target is present, unknown, or unverifiable; recovery is required before retrying.')
      + ` ${failure.summary ?? failure.message}.${diagnostic}`,
  }
}

function installApprovalReason(input: {
  requirement: string
  packageName: string
  targetProfile: string
  riskPrefix: string
  fit: string
  securityRisk: string
  compatibility: string
  scripts: string
  findings: string
  releaseAgeExcludes?: string[]
  reuseProfileStore?: boolean
}): string {
  const actionPlan = copy(
    input.requirement,
    `Install the exact reviewed ${input.packageName} into profile ${input.targetProfile}`,
    `将已审查的 ${input.packageName} 安装到 profile ${input.targetProfile}`,
  )
  const policyNotice = input.releaseAgeExcludes?.length
    ? copy(
        input.requirement,
        ` This one install command will exempt only these existing profile lock entries from pnpm minimumReleaseAge: ${input.releaseAgeExcludes.join(', ')}. No profile or global pnpm policy file will be changed.`,
        ` 本次安装命令只会对这些既有 profile 锁文件条目应用 pnpm minimumReleaseAge 精确例外：${input.releaseAgeExcludes.join('、')}。不会修改 profile 或全局 pnpm 策略文件。`,
      )
    : ''
  const storeNotice = input.reuseProfileStore
    ? copy(
        input.requirement,
        ' This retry will reuse the pnpm store already recorded by the target profile for this install command only. No profile or global pnpm configuration file will be changed.',
        ' 本次重试只会在这一条安装命令中复用目标 profile 已记录的 pnpm store，不会修改 profile 或全局 pnpm 配置文件。',
      )
    : ''
  return copy(
    input.requirement,
    `${input.riskPrefix}${actionPlan} (persistent). Review: fit=${input.fit}, risk=${input.securityRisk}, compatibility=${input.compatibility}, lifecycleScripts=${input.scripts}, findings=${input.findings}.${policyNotice}${storeNotice}`,
    `${input.riskPrefix}${actionPlan}（persistent）。审查：匹配=${input.fit}，风险=${input.securityRisk}，兼容性=${input.compatibility}，生命周期脚本=${input.scripts}，发现=${input.findings}。${policyNotice}${storeNotice}`,
  )
}

async function requestApproval(
  ctx: Context,
  exec: ToolRunContext,
  reason: string,
  toolName: string,
): Promise<void> {
  const approval = ctx.get('approval')
  if (!approval || !exec.agent) {
    throw new EvolutionError('approval_required', 'A live DSH approval service and Agent turn are required')
  }
  const outcome = await approval.request({
    agent: exec.agent,
    toolName,
    callId: exec.callId,
    reason,
    signal: exec.signal,
  })
  if (outcome !== 'allowed-once') {
    throw new EvolutionError('approval_required', `The requested change was not approved (${outcome})`, { outcome })
  }
}

export function assertStrictInstallSpec(review: ReviewRecord): string {
  if (!review.artifact || !/^[a-f0-9]{64}$/u.test(review.artifact.sha256)
    || !Number.isSafeInteger(review.artifact.bytes) || review.artifact.bytes <= 0
    || !Number.isSafeInteger(review.artifact.entryCount) || review.artifact.entryCount !== review.inspectedFiles.length) {
    throw new EvolutionError(
      'review_rejected',
      'This review predates frozen package artifacts or is missing artifact provenance; review the exact source again before installation.',
    )
  }
  if (!review.installSpec?.startsWith('file:')) {
    throw new EvolutionError('review_rejected', 'Reviewed installations must use the Host-owned frozen file artifact', {
      actual: review.installSpec,
    })
  }
  const artifactPath = path.resolve(ownedArtifactPath(review.installSpec))
  const ownedRoot = path.resolve(review.artifact.ownedRoot)
  const relative = path.relative(ownedRoot, artifactPath)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new EvolutionError('unsafe_path', 'Reviewed package artifact is outside its Host-owned artifact root', {
      artifactPath,
      ownedRoot,
    })
  }
  return review.installSpec
}

function outcomeAfterCommandFailure(installState: InstallationState): InstallOutcome {
  return installState === 'not_installed' ? 'failed_absent' : 'recovery_required'
}

function lockfileContainsExactPackage(lockfile: string, packageSpec: string): boolean {
  return lockfile.split(/\r?\n/gu).some((line) => {
    const key = line.trim()
    return key === `${packageSpec}:` || key === `'${packageSpec}':` || key === `"${packageSpec}":`
  })
}

function qualifyInstallRecovery(
  failure: InstallFailure,
  lockfileBefore: string | undefined,
  profileStoreFingerprint: string | undefined,
): InstallFailure {
  const recovery = failure.recovery
  if (recovery?.kind === 'minimum_release_age') {
    const exactPackages = recovery.entries.map((entry) => `${entry.packageName}@${entry.version}`)
    const exceptionEligible = Boolean(
      lockfileBefore
      && exactPackages.length > 0
      && exactPackages.every((item) => lockfileContainsExactPackage(lockfileBefore, item)),
    )
    return {
      ...failure,
      retryable: true,
      recovery: {
        ...recovery,
        scope: exceptionEligible ? 'host_profile' : 'unknown',
        exceptionEligible,
      },
    }
  }
  if (recovery?.kind !== 'profile_store_mismatch') return failure
  const reuseEligible = Boolean(profileStoreFingerprint && /^[a-f0-9]{64}$/u.test(profileStoreFingerprint))
  return {
    ...failure,
    retryable: true,
    recovery: {
      ...recovery,
      ...(reuseEligible && profileStoreFingerprint ? { profileStoreFingerprint } : {}),
      scope: reuseEligible ? 'host_profile' : 'unknown',
      reuseEligible,
    },
  }
}

function ownedArtifactPath(installSpec: string): string {
  if (!installSpec.startsWith('file:')) {
    throw new EvolutionError('review_rejected', 'Reviewed installation lost its Host-owned file artifact specification')
  }
  const candidate = installSpec.slice('file:'.length)
  if (!path.isAbsolute(candidate)) {
    throw new EvolutionError('unsafe_path', 'Reviewed installation artifact is not an absolute path')
  }
  return candidate
}

async function readOwnedReviewedArtifact(
  review: ReviewRecord,
  installSpec: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  signal?.throwIfAborted()
  if (!review.artifact) throw new EvolutionError('review_rejected', 'Review is missing frozen artifact provenance')
  const artifactPath = ownedArtifactPath(installSpec)
  const info = await lstat(artifactPath)
  signal?.throwIfAborted()
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new EvolutionError('unsafe_path', 'Reviewed package artifact is no longer a regular Host-owned file')
  }
  const [resolvedRoot, resolvedArtifact] = await Promise.all([
    realpath(review.artifact.ownedRoot),
    realpath(artifactPath),
  ])
  signal?.throwIfAborted()
  const relative = path.relative(resolvedRoot, resolvedArtifact)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new EvolutionError('unsafe_path', 'Reviewed package artifact escaped its Host-owned root')
  }
  const artifact = await readFile(resolvedArtifact, { signal })
  signal?.throwIfAborted()
  return artifact
}

type InstallAttemptContext = {
  input: InstallInput
  exec: ToolRunContext
  binding: InstallCommitmentBinding | undefined
  review: ReviewRecord
  packageName: string
  upstreamRepository: string | undefined
  recoveryInstallOptions: RecoveryInstallOptions
  frozenLayer: VerificationLayerKind
  scripts: string
  findings: string
  riskPrefix: string
  id: string
  createdAt: string
  dshHome: string
  cwd: string
  installSpec: string
  artifactSha256?: string
  provisional?: InstallationRecord
  destinationJournal?: InstallationRecord
  lockfileBefore?: string | undefined
  sourceMatched?: boolean
  verification?: VerificationEvidence
  selectedLayer?: VerificationLayerKind
  verified?: boolean
  activated?: boolean
  awaitingUserTest?: boolean
  nonFailure?: boolean
  mechanicallyLoaded?: boolean
  hotReloadAttempt?: HotReloadAttempt | undefined
  runtimeRecoveryRequired?: boolean
}

export class PluginInstaller {
  private readonly ctx: Context
  private readonly config: RuntimeConfig
  private readonly store: StateStore
  private readonly launcher: DshLauncher
  private readonly authorizeInstall: InstallAuthorizer | undefined
  private readonly hotLoader: ProfileHotLoader
  private readonly resolveDestinationProfile: (() => Promise<string>) | undefined

  constructor(options: PluginInstallerOptions) {
    this.ctx = options.ctx
    this.config = options.config
    this.store = options.store
    this.launcher = options.launcher
    this.authorizeInstall = options.authorizeInstall
    this.hotLoader = options.hotLoader ?? hotLoadInstalledBundle
    this.resolveDestinationProfile = options.resolveDestinationProfile
  }

  private async assertDestination(
    input: InstallInput,
    packageName: string,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted()
    if (this.resolveDestinationProfile) {
      const owner = await this.resolveDestinationProfile()
      signal?.throwIfAborted()
      if (owner !== input.targetProfile) {
        throw new EvolutionError(
          'invalid_input',
          `Install target ${input.targetProfile} no longer matches the live DSH profile ${owner}; refusing profile mutation`,
        )
      }
    }
    if (input.replacement) {
      await this.assertReplacementBinding(input.replacement, input.targetProfile, packageName)
      signal?.throwIfAborted()
      return
    }
    const absent = await this.launcher.profileTargetAbsent(
      this.config.dshHome,
      input.targetProfile,
      packageName,
    )
    signal?.throwIfAborted()
    if (!absent) {
      throw new EvolutionError(
        'invalid_input',
        `Profile ${input.targetProfile} already owns ${packageName}; refusing to overwrite or remove a user-owned installation`,
      )
    }
  }

  private async assertReplacementBinding(
    replacement: ReplacementTarget,
    targetProfile: string,
    packageName: string,
  ): Promise<void> {
    if (replacement.packageName !== packageName) {
      throw new EvolutionError('invalid_input', 'Replacement package does not match the reviewed package')
    }
    if (replacement.profile !== targetProfile) {
      throw new EvolutionError('invalid_input', 'Replacement profile does not match the frozen installed target')
    }
    const liveSpec = await this.launcher.profileDependencySpec(
      this.config.dshHome,
      targetProfile,
      packageName,
    )
    if (liveSpec !== replacement.oldDependencySpec) {
      throw new EvolutionError(
        'invalid_input',
        'Live profile dependency spec drifted from the frozen installed target; refusing replacement',
      )
    }
  }

  private async upstreamRepository(review: ReviewRecord): Promise<string | undefined> {
    if (review.sourceSnapshot.kind === 'github') return validateGithubRepository(review.sourceSnapshot.repository)
    const reviews = await this.store.listReviews(review.resolutionId)
    const root = managedSnapshotRootReview(review, new Map(reviews.map((item) => [item.id, item])))
    return root?.sourceSnapshot.kind === 'github'
      ? validateGithubRepository(root.sourceSnapshot.repository)
      : undefined
  }

  private async assertRecoveryPlanBinding(
    input: InstallInput,
    review: ReviewRecord,
    workflow?: ReviewCandidateContext,
  ): Promise<RecoveryInstallOptions> {
    const grant = input.recoveryPlan
    if (!grant) return {}
    if (!workflow || !workflow.lastInstallationId || workflow.lastInstallationId !== grant.sourceInstallationId) {
      throw new EvolutionError('invalid_input', 'Recovery plan is not bound to the workflow latest failed installation')
    }
    const prior = await this.store.getInstallation(grant.sourceInstallationId)
    const recovery = prior.installFailure?.recovery
    if (prior.workflowId !== workflow.id
      || prior.reviewId !== review.id
      || prior.targetProfile !== input.targetProfile
      || prior.installOutcome !== 'failed_absent'
      || prior.installed
      || prior.verification.attempted !== false
      || grant.operation !== 'retry_install'
      || grant.effectScope !== 'single_install_command'
      || prior.installFailure?.diagnosticHash !== grant.diagnosticHash) {
      throw new EvolutionError('invalid_input', 'Recovery plan no longer matches the sealed failed receipt')
    }
    if (grant.strategy === 'minimum_release_age_exception') {
      const exactPackages = recovery?.kind === 'minimum_release_age'
        ? recovery.entries.map((entry) => `${entry.packageName}@${entry.version}`).sort()
        : []
      const expectedRecoveryId = `recovery_${hashObject({
        workflowId: workflow.id,
        installationId: prior.id,
        reviewId: review.id,
        diagnosticHash: prior.installFailure?.diagnosticHash,
        exactPackages,
      }).slice(0, 24)}`
      if (grant.id !== expectedRecoveryId
        || recovery?.kind !== 'minimum_release_age'
        || recovery.scope !== 'host_profile'
        || !recovery.exceptionEligible
        || grant.exactPackages.length < 1
        || grant.exactPackages.length > 8
        || JSON.stringify([...grant.exactPackages].sort()) !== JSON.stringify(exactPackages)) {
        throw new EvolutionError('invalid_input', 'Recovery plan no longer matches the sealed failed receipt')
      }
      return { minimumReleaseAgeExcludes: exactPackages }
    }
    const expectedRecoveryId = `recovery_${hashObject({
      workflowId: workflow.id,
      installationId: prior.id,
      reviewId: review.id,
      diagnosticHash: prior.installFailure?.diagnosticHash,
      profileStoreFingerprint: recovery?.kind === 'profile_store_mismatch'
        ? recovery.profileStoreFingerprint
        : undefined,
    }).slice(0, 24)}`
    const currentFingerprint = await this.launcher.profileStoreFingerprint(this.config.dshHome, input.targetProfile)
    if (grant.strategy !== 'profile_store_reuse'
      || grant.id !== expectedRecoveryId
      || recovery?.kind !== 'profile_store_mismatch'
      || recovery.scope !== 'host_profile'
      || !recovery.reuseEligible
      || !recovery.profileStoreFingerprint
      || grant.profileStoreFingerprint !== recovery.profileStoreFingerprint
      || currentFingerprint !== recovery.profileStoreFingerprint) {
      throw new EvolutionError('invalid_input', 'Recovery plan no longer matches the sealed failed receipt')
    }
    return { expectedProfileStoreFingerprint: recovery.profileStoreFingerprint }
  }

  private async resolvePredecessor(
    replacement: ReplacementTarget,
    currentInstallationId: string,
  ): Promise<InstallationRecord | undefined> {
    const records = await this.store.listInstallationsStrictExcluding(currentInstallationId)
    const targetIdentity = installationIdentity({
      dshHome: this.config.dshHome,
      targetProfile: replacement.profile,
      packageName: replacement.packageName,
    })
    const identityRecord = records.find((item) => installationIdentity(item) === targetIdentity)
    if (!identityRecord) return undefined
    const live = deriveInstallationLineage(records).uniqueLiveLeaf(
      identityRecord,
      replacement.oldDependencySpec,
    )
    return live.status === 'unique' ? live.record : undefined
  }

  private async reconcileReplacement(input: {
    dshHome: string
    packageName: string
    replacement: ReplacementTarget
    newInstallSpec: string
    preparedAt: string
  }): Promise<ReplacementJournal> {
    const newPresent = await this.launcher.profileSourceMatches(
      input.dshHome,
      input.replacement.profile,
      input.packageName,
      input.newInstallSpec,
    ).catch(() => false)
    let liveSpec: string | undefined
    let liveSpecReadSucceeded = false
    try {
      liveSpec = await this.launcher.profileDependencySpec(
        input.dshHome,
        input.replacement.profile,
        input.packageName,
      )
      liveSpecReadSucceeded = true
    } catch {
      // Post-effect reconciliation: an unreadable profile is recorded as `unknown`.
    }
    let state: ReplacementJournal['state']
    if (newPresent) state = 'new_present'
    else if (!liveSpecReadSucceeded) state = 'unknown'
    else if (liveSpec === input.replacement.oldDependencySpec) state = 'old_present'
    else if (liveSpec === undefined) state = 'absent'
    else state = 'unknown'
    return {
      state,
      oldSpecDigest: input.replacement.oldSpecDigest,
      newInstallSpec: input.newInstallSpec,
      preparedAt: input.preparedAt,
      reconciledAt: new Date().toISOString(),
    }
  }

  async install(
    input: InstallInput,
    exec: ToolRunContext,
    binding?: InstallCommitmentBinding,
  ): Promise<InstallationRecord> {
    let attempt: InstallAttemptContext
    try {
      exec.signal?.throwIfAborted()
      attempt = await this.beginInstallAttempt(input, exec, binding)
      exec.signal?.throwIfAborted()
      await this.assertReviewedArtifactUnchanged(attempt)
      await this.requestInstallApproval(attempt)
      await this.assertArtifactUnchangedAfterApproval(attempt)
      await this.writeProvisionalReceipt(attempt)
      // The provisional receipt is now the durable recovery anchor. Cancellation
      // before the install command is still pre-effect.
      exec.signal?.throwIfAborted()
      await this.prepareDestinationMutation(attempt)
    } catch (error) {
      // Pre-effect: cancellation identity wins over whatever the aborted step threw.
      if (exec.signal?.aborted) throw exec.signal.reason
      throw error
    }
    const installFailureRecord = await this.runDestinationInstall(attempt)
    if (installFailureRecord) return installFailureRecord
    try {
      await this.verifyInstalledSource(attempt)
    } catch (error) {
      if (exec.signal?.aborted) {
        if (attempt.verification) {
          await this.activateInstalledBundle(attempt)
          throw exec.signal.reason
        }
        await this.settleInterruptedAttempt(attempt, 'destination')
        throw exec.signal.reason
      }
      throw error
    }
    await this.activateInstalledBundle(attempt)
    return await this.persistInstallOutcome(attempt)
  }

  private async beginInstallAttempt(
    input: InstallInput,
    exec: ToolRunContext,
    binding?: InstallCommitmentBinding,
  ): Promise<InstallAttemptContext> {
    exec.signal?.throwIfAborted()
    validateProfile(input.targetProfile)
    if (input.retention !== 'persistent') {
      throw new EvolutionError('invalid_input', 'Every adopted capability is installed persistently; temporary trials are not supported')
    }
    const review = await this.store.getReview(input.reviewId)
    exec.signal?.throwIfAborted()
    const packageName = assertSafePackageName(review.manifest.packageName)
    const upstreamRepository = await this.upstreamRepository(review)
    exec.signal?.throwIfAborted()
    if (this.authorizeInstall) {
      await this.authorizeInstall(review, exec, binding)
      exec.signal?.throwIfAborted()
    } else {
      assertDirectUseAllowed(review)
    }

    const strictSpec = assertStrictInstallSpec(review)
    const recoveryInstallOptions = await this.assertRecoveryPlanBinding(input, review, binding?.workflow)
    exec.signal?.throwIfAborted()
    const frozenLayer: VerificationLayerKind = review.runtimeSurface?.verificationLayer ?? 'manual_runtime'
    await this.assertDestination(input, packageName, exec.signal)
    exec.signal?.throwIfAborted()
    const scripts = review.manifest.scripts.length > 0 ? review.manifest.scripts.join(', ') : 'none'
    const riskFindings = review.findings
      .filter((finding) => finding.severity === 'block' || review.securityRisk === 'high')
      .slice(0, 8)
      .map((finding) => `${finding.code}:${finding.severity}`)
    const findings = review.findings.length > 0
      ? review.findings.slice(0, 8).map((finding) => `${finding.code}:${finding.severity}`).join(', ')
      : 'none'
    const riskPrefix = review.securityRisk === 'high'
      ? copy(
          review.requirement,
          `HIGH RISK (${riskFindings.join(', ') || review.securityRisk}). `,
          `高风险（${riskFindings.join('、') || review.securityRisk}）。`,
        )
      : ''
    const id = input.installationId
      ?? `installation_${hashObject({ reviewId: review.id, at: new Date().toISOString(), nonce: randomUUID() }).slice(0, 24)}`
    exec.signal?.throwIfAborted()
    try {
      await this.store.getInstallation(id)
      throw new EvolutionError('invalid_input', 'The prelinked installation receipt already exists; recover it instead of reinstalling', {
        installationId: id,
      })
    } catch (error) {
      if (!(error instanceof EvolutionError) || error.code !== 'not_found') throw error
    }
    exec.signal?.throwIfAborted()
    return {
      input,
      exec,
      binding,
      review,
      packageName,
      upstreamRepository,
      recoveryInstallOptions,
      frozenLayer,
      scripts,
      findings,
      riskPrefix,
      id,
      createdAt: new Date().toISOString(),
      dshHome: this.config.dshHome,
      cwd: exec.agent?.session.header.cwd ?? process.cwd(),
      installSpec: strictSpec,
    }
  }

  private async assertReviewedArtifactUnchanged(attempt: InstallAttemptContext): Promise<void> {
    const { review, installSpec, input, exec } = attempt
    exec.signal?.throwIfAborted()
    const artifactSha256 = review.artifact!.sha256
    const currentArtifactBytes = await readOwnedReviewedArtifact(review, installSpec, exec.signal)
    exec.signal?.throwIfAborted()
    const currentArtifactSha256 = sha256(currentArtifactBytes)
    if (currentArtifactBytes.byteLength !== review.artifact!.bytes) {
      throw new EvolutionError('review_expired', 'The frozen reviewed package size changed before installation', {
        expectedArtifactBytes: review.artifact!.bytes,
        actualArtifactBytes: currentArtifactBytes.byteLength,
      })
    }
    if (currentArtifactSha256 !== artifactSha256) {
      throw new EvolutionError('review_expired', 'The frozen reviewed package bytes changed before installation', {
        expectedArtifactSha256: artifactSha256,
        actualArtifactSha256: currentArtifactSha256,
      })
    }
    if (input.expectedArtifactSha256 && artifactSha256 !== input.expectedArtifactSha256) {
      throw new EvolutionError('review_rejected', 'Managed source receipt does not match the reviewed frozen package', {
        expectedArtifactSha256: input.expectedArtifactSha256,
        actualArtifactSha256: artifactSha256,
      })
    }
    attempt.artifactSha256 = artifactSha256
  }

  private async requestInstallApproval(attempt: InstallAttemptContext): Promise<void> {
    const { input, exec, review, packageName, recoveryInstallOptions, riskPrefix, scripts, findings } = attempt
    exec.signal?.throwIfAborted()
    await requestApproval(
      this.ctx,
      exec,
      installApprovalReason({
        requirement: review.requirement,
        packageName,
        targetProfile: input.targetProfile,
        riskPrefix,
        fit: review.fit,
        securityRisk: review.securityRisk,
        compatibility: review.compatibility.status,
        scripts,
        findings,
        ...(recoveryInstallOptions.minimumReleaseAgeExcludes?.length
          ? { releaseAgeExcludes: recoveryInstallOptions.minimumReleaseAgeExcludes }
          : {}),
        ...(recoveryInstallOptions.expectedProfileStoreFingerprint ? { reuseProfileStore: true } : {}),
      }),
      'capability_workflow_resume',
    )
    // Approval implementations may ignore their signal. Recheck before any
    // approved bytes can execute.
    exec.signal?.throwIfAborted()
  }

  private async assertArtifactUnchangedAfterApproval(attempt: InstallAttemptContext): Promise<void> {
    const { review, installSpec, artifactSha256, exec } = attempt
    exec.signal?.throwIfAborted()
    // Approval can remain open while the filesystem changes. Recheck before
    // the reviewed bytes can execute.
    const approvedArtifactBytes = await readOwnedReviewedArtifact(review, installSpec, exec.signal)
    exec.signal?.throwIfAborted()
    const approvedArtifactSha256 = sha256(approvedArtifactBytes)
    if (approvedArtifactBytes.byteLength !== review.artifact!.bytes || approvedArtifactSha256 !== artifactSha256) {
      throw new EvolutionError('review_expired', 'The frozen reviewed package changed after user approval and before installation', {
        expectedArtifactBytes: review.artifact!.bytes,
        actualArtifactBytes: approvedArtifactBytes.byteLength,
        expectedArtifactSha256: artifactSha256,
        actualArtifactSha256: approvedArtifactSha256,
      })
    }
  }

  private async writeProvisionalReceipt(attempt: InstallAttemptContext): Promise<void> {
    const {
      input,
      binding,
      review,
      id,
      createdAt,
      packageName,
      installSpec,
      artifactSha256,
      dshHome,
      exec,
    } = attempt
    exec.signal?.throwIfAborted()
    const provisional: InstallationRecord = {
      schemaVersion: 2,
      id,
      createdAt,
      reviewId: review.id,
      ...(binding?.workflow ? { workflowId: binding.workflow.id } : {}),
      targetProfile: input.targetProfile,
      retention: 'persistent',
      dshHome,
      packageName,
      installSpec,
      artifactSha256: artifactSha256!,
      installPhase: 'prepared',
      installState: 'unknown',
      installOutcome: 'pending',
      installed: false,
      loaded: false,
      verified: false,
      restartRequired: false,
      removed: false,
      verification: pendingVerification(review.manifest.expectedTools),
      ...(input.recoveryPlan ? {
        recoveryAttempt: {
          id: input.recoveryPlan.id,
          strategy: input.recoveryPlan.strategy,
          sourceInstallationId: input.recoveryPlan.sourceInstallationId,
        },
      } : {}),
      ...(input.replacement ? {
        predecessorInstallationId: input.replacement.predecessorInstallationId,
        replacement: {
          state: 'prepared' as const,
          oldSpecDigest: input.replacement.oldSpecDigest,
          newInstallSpec: installSpec,
          preparedAt: createdAt,
        },
      } : {}),
    }
    await this.store.put('installations', provisional)
    attempt.provisional = provisional
    attempt.destinationJournal = provisional
    exec.signal?.throwIfAborted()
  }

  private async settleInterruptedAttempt(
    attempt: InstallAttemptContext,
    stage: 'destination' | 'hotload',
  ): Promise<InstallationRecord> {
    const {
      input,
      review,
      packageName,
      installSpec,
      dshHome,
      provisional,
      destinationJournal,
    } = attempt
    let installState: InstallationState = 'unknown'
    let replacementJournal = destinationJournal?.replacement

    if (input.replacement) {
      try {
        replacementJournal = await this.reconcileReplacement({
          dshHome,
          packageName,
          replacement: input.replacement,
          newInstallSpec: installSpec,
          preparedAt: destinationJournal?.replacement?.preparedAt ?? attempt.createdAt,
        })
        installState = replacementJournal.state === 'absent'
          ? 'not_installed'
          : replacementJournal.state === 'unknown'
            ? 'unknown'
            : 'installed'
      } catch {
        replacementJournal = {
          state: 'unknown',
          oldSpecDigest: input.replacement.oldSpecDigest,
          newInstallSpec: installSpec,
          preparedAt: destinationJournal?.replacement?.preparedAt ?? attempt.createdAt,
          reconciledAt: new Date().toISOString(),
        }
        installState = 'unknown'
      }
    } else {
      installState = await this.reconcileDestinationState(attempt)
    }

    const installOutcome: InstallOutcome = stage === 'hotload'
      ? 'recovery_required'
      : installState === 'not_installed'
        ? 'failed_absent'
        : 'recovery_required'
    const failure = lifecycleFailure(
      stage === 'hotload' ? 'load' : 'install',
      'operation_cancelled',
      stage === 'hotload'
        ? 'Installation was cancelled while current-process activation may have mutated runtime state.'
        : 'Installation was cancelled while an install effect was in flight; Host state was reconciled before returning.',
      false,
    )
    const evidence = stage === 'hotload' && attempt.verification
      ? {
          ...attempt.verification,
          reason: `${attempt.verification.reason} Cancellation was observed after activation began; explicit recovery is required.`,
        }
      : failedInstallation(review.manifest.expectedTools, installOutcome, failure)
    const record: InstallationRecord = {
      ...(destinationJournal ?? provisional!),
      installPhase: 'completed',
      installState,
      installOutcome,
      installed: false,
      loaded: false,
      verified: false,
      restartRequired: false,
      ...(stage === 'hotload' && attempt.hotReloadAttempt
        ? { hotReload: attempt.hotReloadAttempt.evidence }
        : {}),
      removed: false,
      installFailure: failure,
      verification: evidence,
      ...(replacementJournal ? { replacement: replacementJournal } : {}),
    }
    try {
      // Deliberately unsignaled: after an effect may have started, durable
      // source truth takes priority over returning cancellation.
      await this.store.put('installations', record)
    } catch (cause) {
      throw new EvolutionError(
        'command_failed',
        'Installation was cancelled after an effect began, but reconciled state could not be persisted; the provisional receipt remains the recovery anchor',
        {
          installationId: attempt.id,
          recoveryRequired: true,
          stage: 'persist',
          retryable: false,
          diagnosticHash: hashObject({ cause: errorMessage(cause) }),
        },
      )
    }
    attempt.destinationJournal = record
    return record
  }

  /** Post-effect reconciliation of the live profile. Unreadable profile state is `unknown`, never a claim. */
  private async reconcileDestinationState(attempt: InstallAttemptContext): Promise<InstallationState> {
    const { input, dshHome, packageName, installSpec } = attempt
    const exactSourcePresent = await this.launcher.profileSourceMatches(
      dshHome,
      input.targetProfile,
      packageName,
      installSpec,
    ).catch(() => false)
    if (exactSourcePresent) return 'installed'
    return await this.launcher.profileTargetAbsent(dshHome, input.targetProfile, packageName)
      .then((absent) => (absent ? 'not_installed' as const : 'unknown' as const))
      .catch(() => 'unknown' as const)
  }

  private async prepareDestinationMutation(attempt: InstallAttemptContext): Promise<void> {
    const { input, exec, packageName } = attempt
    exec.signal?.throwIfAborted()
    // Approval can stay open for a long time. Recheck ownership and absence at
    // the actual destination mutation boundary to close profile/TOCTOU drift.
    await this.assertDestination(input, packageName, exec.signal)
    exec.signal?.throwIfAborted()
    attempt.lockfileBefore = await readFile(
      path.join(attempt.dshHome, 'profiles', input.targetProfile, 'pnpm-lock.yaml'),
      'utf8',
    ).catch(() => undefined)
    exec.signal?.throwIfAborted()
    attempt.destinationJournal = { ...attempt.destinationJournal!, installPhase: 'destination_installing' }
    // Effect journal commit immediately before the destination install command.
    await this.store.put('installations', attempt.destinationJournal)
    exec.signal?.throwIfAborted()
  }

  private async runDestinationInstall(attempt: InstallAttemptContext): Promise<InstallationRecord | undefined> {
    const {
      input,
      exec,
      review,
      dshHome,
      installSpec,
      cwd,
      recoveryInstallOptions,
      destinationJournal,
      lockfileBefore,
    } = attempt
    exec.signal?.throwIfAborted()
    try {
      await this.launcher.install(
        dshHome,
        input.targetProfile,
        installSpec,
        cwd,
        exec.signal,
        recoveryInstallOptions.minimumReleaseAgeExcludes?.length
          || recoveryInstallOptions.expectedProfileStoreFingerprint
          ? recoveryInstallOptions
          : undefined,
      )
      exec.signal?.throwIfAborted()
    } catch (error) {
      if (exec.signal?.aborted) {
        await this.settleInterruptedAttempt(attempt, 'destination')
        throw exec.signal.reason
      }
      const rawFailure = installFailure(error, 'install')
      const profileStoreFingerprint = rawFailure.recovery?.kind === 'profile_store_mismatch'
        ? await this.launcher.profileStoreFingerprint(dshHome, input.targetProfile).catch(() => undefined)
        : undefined
      if (exec.signal?.aborted) {
        await this.settleInterruptedAttempt(attempt, 'destination')
        throw exec.signal.reason
      }
      const failure = qualifyInstallRecovery(rawFailure, lockfileBefore, profileStoreFingerprint)
      const installState = await this.reconcileDestinationState(attempt)
      if (exec.signal?.aborted) {
        await this.settleInterruptedAttempt(attempt, 'destination')
        throw exec.signal.reason
      }
      const installOutcome = outcomeAfterCommandFailure(installState)
      const failedRecord: InstallationRecord = {
        ...destinationJournal!,
        installPhase: 'completed',
        installState,
        installOutcome,
        installed: false,
        removed: false,
        installFailure: failure,
        verification: failedInstallation(review.manifest.expectedTools, installOutcome, failure),
      }
      await this.store.put('installations', failedRecord)
      attempt.destinationJournal = failedRecord
      if (exec.signal?.aborted) throw exec.signal.reason
      return failedRecord
    }
    if (exec.signal?.aborted) {
      await this.settleInterruptedAttempt(attempt, 'destination')
      throw exec.signal.reason
    }
    return undefined
  }

  private async verifyInstalledSource(attempt: InstallAttemptContext): Promise<void> {
    const { input, exec, review, dshHome, installSpec, cwd, packageName, frozenLayer } = attempt
    exec.signal?.throwIfAborted()
    let sourceMatched = false
    try {
      sourceMatched = await this.launcher.profileSourceMatches(
        dshHome,
        input.targetProfile,
        packageName,
        installSpec,
      )
    } catch (error) {
      if (exec.signal?.aborted) throw exec.signal.reason
      sourceMatched = false
    }
    exec.signal?.throwIfAborted()
    const expectedTools = review.manifest.expectedTools
    let verification: VerificationEvidence
    let selectedLayer: VerificationLayerKind = frozenLayer
    if (!sourceMatched) {
      verification = sourceMismatchEvidence(expectedTools)
    } else {
      let declaredFixtures: Record<string, unknown> = {}
      try {
        declaredFixtures = await this.launcher.readInstalledVerificationFixtures(
          dshHome,
          input.targetProfile,
          packageName,
        )
      } catch (error) {
        if (exec.signal?.aborted) throw exec.signal.reason
        declaredFixtures = {}
      }
      exec.signal?.throwIfAborted()
      const selection = selectInstallVerificationLayer({ review, declaredFixtures })
      selectedLayer = selection.layer
      if (selection.layer === 'manual_runtime') {
        verification = manualRuntimeEvidence(expectedTools, selection.reason)
      } else {
        try {
          verification = await this.launcher.verifyHost({
            dshHome,
            profile: input.targetProfile,
            cwd,
            layer: selection.layer,
            packageName,
            ...(review.manifest.activatedFibers ? { activatedFibers: review.manifest.activatedFibers } : {}),
            expectedTools: selection.expectedTools,
            fixtures: selection.fixtures,
            fixtureDigest: selection.fixtureDigest,
            ...(exec.signal ? { signal: exec.signal } : {}),
          })
        } catch (error) {
          if (exec.signal?.aborted) throw exec.signal.reason
          verification = interruptedVerification(expectedTools, selection.layer)
        }
      }
    }
    attempt.sourceMatched = sourceMatched
    attempt.verification = verification
    attempt.selectedLayer = selectedLayer
    // If verifyHost returned evidence concurrently with cancellation, the
    // caller routes this populated attempt through activation/outcome
    // persistence before preserving the exact cancellation reason.
    exec.signal?.throwIfAborted()
  }

  private async activateInstalledBundle(attempt: InstallAttemptContext): Promise<void> {
    const {
      input,
      exec,
      review,
      dshHome,
      packageName,
      sourceMatched,
      verification,
      selectedLayer,
    } = attempt
    const layer = verification!.layer ?? selectedLayer!
    const status: VerificationStatus = verification!.status
      ?? (layer === 'manual_runtime' ? 'pending_user_test' : 'uncertain')
    const mechanical = sourceMatched! && (
      layer === 'manual_runtime'
        ? status === 'pending_user_test'
        : hostLayerSuccess({ sourceMatched: sourceMatched!, layer, verification: verification! })
    )
    const verified = mechanical && layer === 'tool_roundtrip' && status === 'passed'
    const activated = mechanical && layer === 'bundle_activation' && status === 'passed'
    const awaitingUserTest = mechanical && layer === 'manual_runtime' && status === 'pending_user_test'
    const nonFailure = verified || activated || awaitingUserTest
    const mechanicallyLoaded = sourceMatched! && (
      verified
      || activated
      || awaitingUserTest
      || (verification!.attempted && verification!.exitCode === 0)
    )
    attempt.verified = verified
    attempt.activated = activated
    attempt.awaitingUserTest = awaitingUserTest
    attempt.nonFailure = nonFailure
    attempt.mechanicallyLoaded = mechanicallyLoaded

    // A manual-runtime candidate is not mechanically proven against the live
    // profile state. Loading third-party startup code into the serving DSH
    // process can therefore terminate the Host before the final receipt is
    // committed (for example, a detached rejected Promise cannot be contained
    // by this call's try/catch). Keep the current Host alive and cross a clean
    // process boundary before the user performs the required real-client test.
    const manualRuntimeHotReload: HotReloadAttempt = {
      evidence: {
        attempted: false,
        loaded: false,
        method: 'unsupported',
        reason: 'Manual-runtime plugins are not activated inside the serving DSH process; restart is required before the real-client test.',
      },
    }
    if (exec.signal?.aborted) {
      attempt.hotReloadAttempt = awaitingUserTest ? manualRuntimeHotReload : undefined
      attempt.runtimeRecoveryRequired = false
      await this.persistInstallOutcome(attempt)
      throw exec.signal.reason
    }
    let hotReloadAttempt: HotReloadAttempt | undefined
    if (awaitingUserTest) {
      hotReloadAttempt = manualRuntimeHotReload
    } else if (nonFailure) {
      try {
        hotReloadAttempt = await this.hotLoader({
          ctx: this.ctx,
          dshHome,
          profile: input.targetProfile,
          packageName,
          expectedTools: review.manifest.expectedTools,
          ...(exec.agent ? { agent: exec.agent } : {}),
          ...(exec.signal ? { signal: exec.signal } : {}),
        })
      } catch (error) {
        if (!exec.signal?.aborted) throw error
        attempt.hotReloadAttempt = {
          evidence: {
            attempted: true,
            loaded: false,
            method: 'failed',
            reason: 'Current-process activation was interrupted after runtime mutation may have begun; explicit recovery is required.',
          },
        }
        attempt.runtimeRecoveryRequired = true
        await this.settleInterruptedAttempt(attempt, 'hotload')
        throw exec.signal.reason
      }
    }
    attempt.hotReloadAttempt = hotReloadAttempt
    attempt.runtimeRecoveryRequired = Boolean(nonFailure && hotReloadAttempt?.rollbackFailed === true)
    if (exec.signal?.aborted) {
      // A loader may settle after observing cancellation. Commit its actual
      // activation outcome before preserving cancellation identity.
      await this.persistInstallOutcome(attempt)
      throw exec.signal.reason
    }
  }

  private async persistInstallOutcome(attempt: InstallAttemptContext): Promise<InstallationRecord> {
    const { input, review, dshHome, packageName, installSpec, createdAt, upstreamRepository, id } = attempt
    const runtimeRecoveryRequired = attempt.runtimeRecoveryRequired!
    const verified = attempt.verified!
    const activated = attempt.activated!
    const awaitingUserTest = attempt.awaitingUserTest!
    const nonFailure = attempt.nonFailure!
    const destinationJournal = attempt.destinationJournal!
    const hotReload = attempt.hotReloadAttempt?.evidence
    const sourceMatched = attempt.sourceMatched!
    const verification = attempt.verification!
    const provisional = attempt.provisional!

    // Workflow maps `verified` to the installed/restart_required success nodes;
    // `activated` and `awaiting_user_test` (Host install outcomes for
    // bundle_activation / manual_runtime) map to their own distinct success nodes.
    let installOutcome: InstallOutcome
    if (runtimeRecoveryRequired) installOutcome = 'recovery_required'
    else if (verified) installOutcome = 'verified'
    else if (activated) installOutcome = 'activated'
    else if (awaitingUserTest) installOutcome = 'awaiting_user_test'
    else installOutcome = 'recovery_required'

    const contributionEligible = review.sourceSnapshot.kind === 'local' && verified && review.fit === 'full'
      && review.recommendation === 'use' && Boolean(review.license)
    let success = nonFailure && !runtimeRecoveryRequired
    let replacementJournal = destinationJournal.replacement
    let predecessorInstallationId: string | undefined
    if (input.replacement) {
      replacementJournal = await this.reconcileReplacement({
        dshHome,
        packageName,
        replacement: input.replacement,
        newInstallSpec: installSpec,
        preparedAt: destinationJournal.replacement?.preparedAt ?? createdAt,
      })
      if (replacementJournal.state !== 'new_present') {
        success = false
        installOutcome = replacementJournal.state === 'absent' ? 'failed_absent' : 'recovery_required'
      } else {
        const predecessor = await this.resolvePredecessor(input.replacement, id)
        predecessorInstallationId = predecessor?.id
      }
    }
    const outcomeFailure: InstallFailure | undefined = success
      ? undefined
      : runtimeRecoveryRequired
        ? lifecycleFailure(
            'load',
            'load_recovery_required',
            'Current-process Loader activation may have mutated runtime state; safe rollback is unavailable.',
            false,
          )
        : replacementJournal && replacementJournal.state !== 'new_present'
          ? lifecycleFailure(
              'install',
              'replacement_reconciliation_failed',
              `Replacement reconciliation ended in ${replacementJournal.state}.`,
              replacementJournal.state !== 'unknown',
            )
          : !sourceMatched
            ? lifecycleFailure(
                'verify',
                'source_mismatch',
                'The target profile did not retain the exact reviewed source as an active bundle.',
              )
            : lifecycleFailure(
                'verify',
                'verification_failed',
                'Host verification did not prove the frozen verification layer.',
              )
    const record: InstallationRecord = projectInstallation({
      ...destinationJournal,
      schemaVersion: 2,
      installPhase: 'completed',
      installState: 'installed',
      installOutcome,
      installed: success,
      ...(replacementJournal ? { replacement: replacementJournal } : {}),
      ...(predecessorInstallationId ? { predecessorInstallationId } : {}),
      // "loaded" only when the destination process itself activated the
      // bundle. A pending user test cannot make that claim for the live profile.
      loaded: success && hotReload?.loaded === true,
      verified: verified && !runtimeRecoveryRequired,
      restartRequired: success && !hotReload?.loaded,
      ...(hotReload ? { hotReload } : {}),
      ...(outcomeFailure ? { installFailure: outcomeFailure } : {}),
      removed: false,
      verification: runtimeRecoveryRequired
        ? { ...verification, reason: `${verification.reason} Current-process Loader activation may have changed runtime state; explicit recovery is required before retry or restart.` }
        : success
          ? (hotReload && !hotReload.loaded
            ? { ...verification, reason: `${verification.reason} Current-process activation did not complete (${hotReload.reason})` }
            : verification)
          : {
              ...verification,
              reason: `${verification.reason} Install command finished but Loader/runtime verification did not prove the expected plugin; recovery is required.`,
            },
      ...(review.sourceSnapshot.kind === 'local'
        ? {
            contributionAdvice: {
              eligible: contributionEligible,
              reason: contributionEligible
                ? 'Potentially eligible to suggest after the user task is complete. Inspect the diff for user-specific data and obtain explicit approval before any fork, push, or upstream PR.'
                : 'Do not suggest an upstream PR until the local change is a licensed, full-fit, reviewed, and verified implementation.',
            },
          }
        : {}),
      ...(success && upstreamRepository ? { upstreamProject: { repository: upstreamRepository } } : {}),
    })
    if (!predecessorInstallationId) delete record.predecessorInstallationId
    try {
      await this.store.put('installations', record)
    } catch (cause) {
      const persistFailure = installFailure(cause, 'persist')
      try {
        await this.store.put('installations', {
          ...provisional,
          installState: 'unknown',
          installOutcome: 'recovery_required',
          installed: false,
          loaded: false,
          verified: false,
          restartRequired: false,
          ...(hotReload ? { hotReload } : {}),
          installFailure: persistFailure,
          removed: false,
          verification: {
            ...verification,
            reason: `${verification.reason} Final receipt persistence failed after runtime activation may have begun; recover by installationId and reconcile the exact live source.`,
          },
        })
      } catch {
        // The earlier provisional receipt remains the recovery anchor.
      }
      throw new EvolutionError('command_failed', 'Installation completed but final receipt persistence failed; a recovery receipt was preserved', {
        installationId: id,
        recoveryRequired: true,
        stage: persistFailure.stage,
        retryable: persistFailure.retryable,
        summary: persistFailure.summary,
        repairHints: persistFailure.repairHints,
        diagnosticHash: hashObject({ cause: errorMessage(cause) }),
      })
    }
    // All post-effect receipt convergence above is deliberately unsignaled.
    // Once the durable outcome exists, cancellation identity may be returned.
    attempt.exec.signal?.throwIfAborted()
    return record
  }
}

export const _testing = {
  validateProfile,
  assertStrictInstallSpec,
  outcomeAfterCommandFailure,
  selectInstallVerificationLayer,
  installApprovalReason,
}
