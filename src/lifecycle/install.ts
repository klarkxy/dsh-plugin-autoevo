import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
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
  VerificationVerdict,
  VerifierRequest,
} from '../contracts.js'
import { dependencySpecDigest } from '../resolver/installed-origin.js'
import { EvolutionError } from '../errors.js'
import { copy } from '../i18n.js'
import {
  fixtureDigestFor,
  hostLayerSuccess,
  sanitizeHostVerificationEvidence,
  selectInstallVerificationLayer,
} from '../host-verification-driver.js'
import { assertSafePackageName } from '../package-name.js'
import { isTransientPnpmRecoveryCode } from '../process/runner.js'
import { assertDirectUseAllowed, type InstallCommitmentBinding } from '../review/direct-use.js'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  mintVerifierRequest,
  redactVerificationReceipt,
  VERIFIER_VERSION,
  verificationEvidenceDigest,
  type SemanticVerifierHost,
} from '../semantic-verifier.js'
import { requirementHashFor } from '../semantic-reviewer.js'
import { hashObject, sha256 } from '../state/hashes.js'
import type { StateStore } from '../state/store.js'
import { boundedAgentText } from '../workflow/sanitize.js'
import { assertOwnedTrialPath, type DshLauncher } from './launcher.js'
import { hotLoadInstalledBundle, type HotReloadAttempt } from './hot-load.js'

export type ReviewRevalidator = (review: ReviewRecord, signal?: AbortSignal) => Promise<boolean>
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
}) => Promise<HotReloadAttempt>

/**
 * Isolated persistent-install preflight profile. The name is not a shipped
 * DSH template, so `dsh plugin` initializes only `@deepseek-ai/dsh-base`.
 * The sandbox lives under the trial DSH home, never `~/.dsh/profiles/headless`.
 */
export const ISOLATED_VERIFICATION_PROFILE = 'autoevo-verify' as const

function validateProfile(profile: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(profile)) {
    throw new EvolutionError('invalid_input', 'targetProfile must be a simple DSH profile name')
  }
}

function verificationTask(input: InstallInput): string | undefined {
  const task = input.verificationTask?.normalize('NFKC').trim()
  if (task !== undefined && task.length > 4_000) {
    throw new EvolutionError('invalid_input', 'verificationTask must not exceed 4000 characters')
  }
  return task || undefined
}

function verificationExpectation(input: InstallInput, task: string | undefined): string | undefined {
  const expected = input.verificationExpectedText?.normalize('NFKC').trim()
  if (expected !== undefined && expected.length > 1_000) {
    throw new EvolutionError('invalid_input', 'verificationExpectedText must not exceed 1000 characters')
  }
  if (expected && !task) throw new EvolutionError('invalid_input', 'verificationExpectedText requires a verificationTask')
  return expected || undefined
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
type InstallFailureStage = NonNullable<InstallFailure['stage']>
type RecoveryInstallOptions = {
  minimumReleaseAgeExcludes?: string[]
  expectedProfileStoreFingerprint?: string
}

function parsedInstallRecovery(value: unknown): InstallFailureRecovery | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const item = value as Record<string, unknown>
  if (item.kind === 'same_authority_once'
    && item.owner === 'pnpm'
    && isTransientPnpmRecoveryCode(item.code)) {
    return { kind: 'same_authority_once', owner: 'pnpm', code: item.code }
  }
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
    case 'preflight':
      return [
        'Inspect the displayed DSH/pnpm diagnostic summary; use diagnosticHash only to correlate the failure evidence.',
        'Resume the workflow so the repaired immutable source is reviewed again before retrying.',
      ]
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

function lifecycleFailure(
  stage: InstallFailureStage,
  code: string,
  summary: string,
  retryable = true,
): InstallFailure {
  const message = summary.normalize('NFKC').replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim().slice(0, 400)
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
    const message = error.message.normalize('NFKC').replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim().slice(0, 400)
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
  const message = (error instanceof Error ? error.message : String(error))
    .normalize('NFKC').replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim().slice(0, 400)
  return lifecycleFailure(stage, 'command_failed', message || 'Unknown installation failure')
}

function failedInstallation(
  expectedTools: readonly string[],
  outcome: InstallOutcome,
  failure: NonNullable<InstallationRecord['installFailure']>,
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
  retention: string
  preflight: boolean
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
    input.preflight
      ? `Preflight the exact reviewed ${input.packageName} in an isolated minimal DSH profile, then install it into live profile ${input.targetProfile}`
      : input.retention === 'temporary'
        ? `Install the exact reviewed ${input.packageName} into isolated temporary profile ${input.targetProfile}`
        : `Install the exact reviewed ${input.packageName} into profile ${input.targetProfile}`,
    input.preflight
      ? `先在隔离的无头 profile 中预检已审查的 ${input.packageName}，再安装到当前 profile ${input.targetProfile}`
      : input.retention === 'temporary'
        ? `将已审查的 ${input.packageName} 安装到隔离的临时 profile ${input.targetProfile}`
        : `将已审查的 ${input.packageName} 安装到 profile ${input.targetProfile}`,
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
    `${input.riskPrefix}${actionPlan} (${input.retention}). Review: fit=${input.fit}, risk=${input.securityRisk}, compatibility=${input.compatibility}, lifecycleScripts=${input.scripts}, findings=${input.findings}.${policyNotice}${storeNotice}`,
    `${input.riskPrefix}${actionPlan}（${input.retention}）。审查：匹配=${input.fit}，风险=${input.securityRisk}，兼容性=${input.compatibility}，生命周期脚本=${input.scripts}，发现=${input.findings}。${policyNotice}${storeNotice}`,
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

/** Exact review-derived GitHub install spec. No fallback synthesis at install time. */
export function expectedGithubInstallSpec(review: ReviewRecord): string | null {
  if (review.sourceSnapshot.kind !== 'github' || !review.manifest.packageName) return null
  return `github:${review.sourceSnapshot.repository}#${review.sourceSnapshot.commit}`
}

export function assertStrictInstallSpec(review: ReviewRecord): string {
  if (review.sourceSnapshot.kind === 'github') {
    const expected = expectedGithubInstallSpec(review)
    if (!expected) {
      throw new EvolutionError('review_rejected', 'GitHub review is missing package identity required for an immutable install specification')
    }
    if (!review.installSpec) {
      throw new EvolutionError('review_rejected', 'Review is missing an immutable install specification')
    }
    if (review.installSpec !== expected) {
      throw new EvolutionError('review_rejected', 'Review install specification does not match the reviewed GitHub source', {
        expected,
        actual: review.installSpec,
      })
    }
    return review.installSpec
  }
  // Local installs materialize an owned file: spec from the reviewed tree; a pre-set non-file spec is rejected.
  if (review.installSpec && !review.installSpec.startsWith('file:')) {
    throw new EvolutionError('review_rejected', 'Local review install specification must be an owned file: artifact or null before materialization', {
      actual: review.installSpec,
    })
  }
  return review.installSpec ?? ''
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
    throw new EvolutionError('review_rejected', 'Managed local installation lost its owned file specification')
  }
  const candidate = installSpec.slice('file:'.length)
  if (!path.isAbsolute(candidate)) {
    throw new EvolutionError('unsafe_path', 'Managed local installation artifact is not an absolute path')
  }
  return candidate
}

export class PluginInstaller {
  private readonly hotLoader: ProfileHotLoader

  constructor(
    private readonly ctx: Context,
    private readonly config: RuntimeConfig,
    private readonly store: StateStore,
    private readonly launcher: DshLauncher,
    private readonly revalidate: ReviewRevalidator,
    private readonly authorizeInstall?: InstallAuthorizer,
    hotLoader?: ProfileHotLoader,
    private readonly semanticVerifier?: SemanticVerifierHost,
    private readonly preflightProfile?: string,
    private readonly resolveDestinationProfile?: () => Promise<string>,
  ) {
    this.hotLoader = hotLoader ?? hotLoadInstalledBundle
    if (preflightProfile) validateProfile(preflightProfile)
  }

  private async removeOwnedDirectory(candidate: string, ownedRoot: string): Promise<void> {
    try {
      const owned = await assertOwnedTrialPath(candidate, ownedRoot)
      await rm(owned, { recursive: true, force: false })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  private async assertPersistentDestination(input: InstallInput, packageName: string): Promise<void> {
    if (input.retention !== 'persistent') return
    if (this.resolveDestinationProfile) {
      const owner = await this.resolveDestinationProfile()
      if (owner !== input.targetProfile) {
        throw new EvolutionError(
          'invalid_input',
          `Install target ${input.targetProfile} no longer matches the live DSH profile ${owner}; refusing profile mutation`,
        )
      }
    }
    if (input.replacement) {
      await this.assertReplacementBinding(input, packageName)
      return
    }
    if (this.preflightProfile
      && !await this.launcher.profileTargetAbsent(this.config.dshHome, input.targetProfile, packageName)) {
      throw new EvolutionError(
        'invalid_input',
        `Profile ${input.targetProfile} already owns ${packageName}; refusing to overwrite or remove a user-owned installation`,
      )
    }
  }

  private async assertReplacementBinding(input: InstallInput, packageName: string): Promise<void> {
    const replacement = input.replacement
    if (!replacement) {
      throw new EvolutionError('invalid_input', 'Replacement binding is required for same-package persist')
    }
    if (input.retention !== 'persistent') {
      throw new EvolutionError('invalid_input', 'Installed-package replacement requires persistent retention')
    }
    if (replacement.packageName !== packageName) {
      throw new EvolutionError('invalid_input', 'Replacement package does not match the reviewed package')
    }
    if (replacement.profile !== input.targetProfile) {
      throw new EvolutionError('invalid_input', 'Replacement profile does not match the frozen installed target')
    }
    if (!this.launcher.profileDependencySpec) {
      throw new EvolutionError('invalid_input', 'This installer host cannot read the live profile dependency spec')
    }
    const liveSpec = await this.launcher.profileDependencySpec(
      this.config.dshHome,
      input.targetProfile,
      packageName,
    )
    if (!liveSpec || dependencySpecDigest(liveSpec) !== replacement.oldSpecDigest || liveSpec !== replacement.oldDependencySpec) {
      throw new EvolutionError(
        'invalid_input',
        'Live profile dependency spec drifted from the frozen installed target; refusing replacement',
      )
    }
  }

  private async assertRecoveryPlanBinding(
    input: InstallInput,
    review: ReviewRecord,
    workflow?: import('../review/direct-use.js').ReviewCandidateContext,
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

  private async installWithTransientRetry(input: {
    dshHome: string
    profile: string
    installSpec: string
    cwd: string
    packageName: string
    signal?: AbortSignal
    options?: {
      forwardCredentials?: boolean
      minimumReleaseAgeExcludes?: string[]
      expectedProfileStoreFingerprint?: string
    }
  }): Promise<void> {
    try {
      await this.launcher.install(
        input.dshHome,
        input.profile,
        input.installSpec,
        input.cwd,
        input.signal,
        input.options,
      )
    } catch (error) {
      const sealedRecovery = Boolean(input.options?.minimumReleaseAgeExcludes?.length
        || input.options?.expectedProfileStoreFingerprint)
      if (sealedRecovery) throw error
      const failure = installFailure(error, 'install')
      if (failure.recovery?.kind !== 'same_authority_once') throw error
      const absent = await this.launcher.profileTargetAbsent(
        input.dshHome,
        input.profile,
        input.packageName,
      ).catch(() => false)
      if (!absent) throw error
      await this.launcher.install(
        input.dshHome,
        input.profile,
        input.installSpec,
        input.cwd,
        input.signal,
        input.options,
      )
    }
  }

  private async resolvePredecessor(replacement: ReplacementTarget): Promise<InstallationRecord | undefined> {
    if (replacement.predecessorInstallationId) {
      const named = await this.store.getInstallation(replacement.predecessorInstallationId).catch(() => undefined)
      if (named
        && named.packageName === replacement.packageName
        && named.targetProfile === replacement.profile
        && !named.removed
        && !named.supersededByInstallationId) {
        return named
      }
    }
    if (!this.store.listInstallations) return undefined
    const records = await this.store.listInstallations()
    return records.find((item) => item.packageName === replacement.packageName
      && item.targetProfile === replacement.profile
      && item.installSpec === replacement.oldDependencySpec
      && !item.removed
      && !item.supersededByInstallationId)
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
    const liveSpec = await this.launcher.profileDependencySpec?.(
      input.dshHome,
      input.replacement.profile,
      input.packageName,
    ).catch(() => undefined)
    let state: ReplacementJournal['state']
    if (newPresent) state = 'new_present'
    else if (liveSpec === input.replacement.oldDependencySpec) state = 'old_present'
    else if (!liveSpec) state = 'absent'
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
    validateProfile(input.targetProfile)
    const task = verificationTask(input)
    verificationExpectation(input, task)
    const review = await this.store.getReview(input.reviewId)
    const packageName = assertSafePackageName(review.manifest.packageName)
    if (this.authorizeInstall) await this.authorizeInstall(review, exec, binding)

    const strictSpec = assertStrictInstallSpec(review)
    assertDirectUseAllowed(review, binding?.workflow)
    const recoveryInstallOptions = await this.assertRecoveryPlanBinding(input, review, binding?.workflow)
    if (!await this.revalidate(review, exec.signal)) {
      throw new EvolutionError('review_expired', 'The reviewed source changed or could not be revalidated; resume the capability workflow to review again')
    }
    const frozenLayer: VerificationLayerKind = review.runtimeSurface?.verificationLayer ?? 'manual_runtime'
    const originallyAutomatic = frozenLayer === 'tool_roundtrip' || frozenLayer === 'bundle_activation'
    if (frozenLayer === 'manual_runtime' && input.retention === 'temporary') {
      throw new EvolutionError(
        'invalid_input',
        'manual_runtime cannot be installed as a temporary trial; reconfirm persistent retention if a user test is intended.',
      )
    }
    await this.assertPersistentDestination(input, packageName)
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
    // Validates the host-minted id before materialization, approval, or any DSH command.
    this.store.trialRoot(id)
    try {
      await this.store.getInstallation(id)
      throw new EvolutionError('invalid_input', 'The prelinked installation receipt already exists; recover it instead of reinstalling', {
        installationId: id,
      })
    } catch (error) {
      if (!(error instanceof EvolutionError) || error.code !== 'not_found') throw error
    }
    const createdAt = new Date().toISOString()
    const trialRoot = this.store.trialRoot(id)
    const trialsRoot = path.join(this.store.root, 'trials')
    const artifactsRoot = path.join(this.store.root, 'artifacts')
    const dshHome = input.retention === 'temporary' ? path.join(trialRoot, 'dsh-home') : this.config.dshHome
    const cwd = exec.agent?.session.header.cwd ?? process.cwd()

    let installSpec = strictSpec
    let ownedArtifactRoot: string | undefined
    let artifactSha256: string | undefined
    if (review.sourceSnapshot.kind === 'local') {
      ownedArtifactRoot = input.retention === 'temporary'
        ? path.join(trialRoot, 'artifact')
        : path.join(artifactsRoot, id)
      try {
        const materialized = await this.launcher.materializeLocal(review, ownedArtifactRoot, exec.signal)
        installSpec = materialized.installSpec
        artifactSha256 = materialized.artifactSha256
        if (input.expectedArtifactSha256 && artifactSha256 !== input.expectedArtifactSha256) {
          throw new EvolutionError('review_rejected', 'Managed source package bytes changed after user confirmation', {
            expectedArtifactSha256: input.expectedArtifactSha256,
            actualArtifactSha256: artifactSha256,
          })
        }
      } catch (error) {
        if (input.retention === 'temporary') await this.removeOwnedDirectory(trialRoot, trialsRoot)
        else await this.removeOwnedDirectory(ownedArtifactRoot, artifactsRoot)
        throw error
      }
    }
    if (!installSpec) throw new EvolutionError('review_rejected', 'The review did not yield an immutable installation spec')

    try {
      await requestApproval(
        this.ctx,
        exec,
        installApprovalReason({
          requirement: review.requirement,
          packageName,
          targetProfile: input.targetProfile,
          retention: input.retention,
          preflight: Boolean(this.preflightProfile && input.retention === 'persistent'),
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
    } catch (error) {
      if (input.retention === 'temporary') await this.removeOwnedDirectory(trialRoot, trialsRoot)
      else if (ownedArtifactRoot) await this.removeOwnedDirectory(ownedArtifactRoot, artifactsRoot)
      throw error
    }

    const provisional: InstallationRecord = {
      schemaVersion: 1,
      id,
      createdAt,
      reviewId: review.id,
      ...(binding?.workflow ? { workflowId: binding.workflow.id } : {}),
      targetProfile: input.targetProfile,
      retention: input.retention,
      dshHome,
      packageName,
      installSpec,
      ...(ownedArtifactRoot ? { ownedArtifactRoot } : {}),
      ...(artifactSha256 ? { artifactSha256 } : {}),
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
    try {
      await this.store.put('installations', provisional)
    } catch (error) {
      if (input.retention === 'temporary') await this.removeOwnedDirectory(trialRoot, trialsRoot)
      else if (ownedArtifactRoot) await this.removeOwnedDirectory(ownedArtifactRoot, artifactsRoot)
      throw error
    }

    let destinationJournal = provisional
    if (this.preflightProfile && input.retention === 'persistent') {
      const preflightHome = path.join(trialRoot, 'preflight-dsh-home')
      await mkdir(preflightHome, { recursive: true })
      const running: InstallationRecord = { ...provisional, installPhase: 'preflight_running' }
      await this.store.put('installations', running)
      try {
        await this.installWithTransientRetry({
          dshHome: preflightHome,
          profile: this.preflightProfile,
          installSpec,
          cwd,
          packageName,
          signal: exec.signal,
          options: { forwardCredentials: false },
        })
      } catch (error) {
        const failure = installFailure(error, 'preflight')
        const preflightFailure = failedInstallation(review.manifest.expectedTools, 'failed_absent', failure)
        await this.removeOwnedDirectory(trialRoot, trialsRoot)
        const failedRecord: InstallationRecord = {
          ...running,
          installPhase: 'completed',
          installState: 'not_installed',
          installOutcome: 'failed_absent',
          installed: false,
          removed: true,
          installFailure: failure,
          preflight: {
            profile: this.preflightProfile,
            passed: false,
            sourceMatched: false,
            verification: preflightFailure,
          },
          verification: preflightFailure,
        }
        await this.store.put('installations', failedRecord)
        return failedRecord
      }

      const preflightSourceMatched = await this.launcher.profileSourceMatches(
        preflightHome,
        this.preflightProfile,
        packageName,
        installSpec,
      ).catch(() => false)
      let preflightVerification: VerificationEvidence
      let preflightLayer: Exclude<VerificationLayerKind, 'manual_runtime'> = 'bundle_activation'
      if (!preflightSourceMatched) {
        preflightVerification = sourceMismatchEvidence(review.manifest.expectedTools)
      } else {
        let declaredFixtures: Record<string, unknown> = {}
        try {
          declaredFixtures = await this.launcher.readInstalledVerificationFixtures(
            preflightHome,
            this.preflightProfile,
            packageName,
          )
        } catch {
          declaredFixtures = {}
        }
        const selection = selectInstallVerificationLayer({ review, declaredFixtures })
        preflightLayer = selection.layer === 'manual_runtime' ? 'bundle_activation' : selection.layer
        try {
          preflightVerification = await this.launcher.verifyHost({
            dshHome: preflightHome,
            profile: this.preflightProfile,
            cwd,
            layer: preflightLayer,
            packageName,
            expectedTools: selection.layer === 'manual_runtime' ? [] : selection.expectedTools,
            fixtures: selection.layer === 'manual_runtime' ? [] : selection.fixtures,
            fixtureDigest: selection.layer === 'manual_runtime' ? fixtureDigestFor([]) : selection.fixtureDigest,
            ...(review.manifest.activatedFibers ? { activatedFibers: review.manifest.activatedFibers } : {}),
            ...(exec.signal ? { signal: exec.signal } : {}),
          })
        } catch {
          preflightVerification = interruptedVerification(
            selection.layer === 'manual_runtime' ? [] : selection.expectedTools,
            preflightLayer,
          )
        }
      }
      const preflightPassed = preflightSourceMatched && hostLayerSuccess({
        sourceMatched: preflightSourceMatched,
        layer: preflightLayer,
        verification: preflightVerification,
      })
      await this.removeOwnedDirectory(trialRoot, trialsRoot)
      const preflightRecord: InstallationRecord = {
        ...running,
        installPhase: preflightPassed ? 'preflight_passed' : 'completed',
        ...(preflightPassed ? {} : { installState: 'not_installed' as const, installOutcome: 'failed_absent' as const }),
        removed: !preflightPassed,
        ...(preflightPassed ? {} : {
          installFailure: lifecycleFailure(
            'preflight',
            preflightSourceMatched ? 'verification_failed' : 'source_mismatch',
            preflightSourceMatched
              ? 'Isolated preflight did not prove the frozen verification layer.'
              : 'Isolated preflight did not activate the exact reviewed source.',
          ),
        }),
        preflight: {
          profile: this.preflightProfile,
          passed: preflightPassed,
          sourceMatched: preflightSourceMatched,
          verification: preflightVerification,
        },
        verification: preflightPassed ? running.verification : preflightVerification,
      }
      await this.store.put('installations', preflightRecord)
      if (!preflightPassed) return preflightRecord
      destinationJournal = preflightRecord
    }

    if (review.sourceSnapshot.kind === 'local' && artifactSha256) {
      const currentArtifactSha256 = sha256(await readFile(ownedArtifactPath(installSpec)))
      if (currentArtifactSha256 !== artifactSha256) {
        throw new EvolutionError('review_expired', 'Managed source package bytes changed between isolated preflight and destination install', {
          expectedArtifactSha256: artifactSha256,
          actualArtifactSha256: currentArtifactSha256,
        })
      }
    }
    // The isolated phase can take minutes. Recheck ownership and absence at
    // the actual destination mutation boundary to close profile/TOCTOU drift.
    await this.assertPersistentDestination(input, packageName)
    destinationJournal = { ...destinationJournal, installPhase: 'destination_installing' }
    if (this.preflightProfile && input.retention === 'persistent') {
      await this.store.put('installations', destinationJournal)
    }
    const lockfileBefore = input.retention === 'persistent'
      ? await readFile(path.join(dshHome, 'profiles', input.targetProfile, 'pnpm-lock.yaml'), 'utf8').catch(() => undefined)
      : undefined

    try {
      await this.installWithTransientRetry({
        dshHome,
        profile: input.targetProfile,
        installSpec,
        cwd,
        packageName,
        signal: exec.signal,
        ...(recoveryInstallOptions.minimumReleaseAgeExcludes?.length
          || recoveryInstallOptions.expectedProfileStoreFingerprint
          ? { options: recoveryInstallOptions }
          : {}),
      })
    } catch (error) {
      const rawFailure = installFailure(error, 'install')
      const profileStoreFingerprint = rawFailure.recovery?.kind === 'profile_store_mismatch'
        ? await this.launcher.profileStoreFingerprint(dshHome, input.targetProfile).catch(() => undefined)
        : undefined
      const failure = qualifyInstallRecovery(rawFailure, lockfileBefore, profileStoreFingerprint)
      const removed = input.retention === 'temporary'
      if (removed) await this.removeOwnedDirectory(trialRoot, trialsRoot)
      let installState: InstallationState = 'not_installed'
      if (input.retention === 'persistent') {
        try {
          installState = await this.launcher.profileTargetAbsent(dshHome, input.targetProfile, packageName)
            ? 'not_installed'
            : 'installed'
        } catch {
          installState = 'unknown'
        }
      }
      const installOutcome = outcomeAfterCommandFailure(installState)
      const failedRecord: InstallationRecord = {
        ...destinationJournal,
        installPhase: 'completed',
        installState,
        installOutcome,
        installed: false,
        removed,
        installFailure: failure,
        verification: failedInstallation(review.manifest.expectedTools, installOutcome, failure),
      }
      await this.store.put('installations', failedRecord)
      return failedRecord
    }
    const sourceMatched = await this.launcher.profileSourceMatches(
      dshHome,
      input.targetProfile,
      packageName,
      installSpec,
    ).catch(() => false)
    const expectedTools = review.manifest.expectedTools
    let verification: VerificationEvidence
    let selectedLayer: VerificationLayerKind = frozenLayer
    let automaticVerificationDegraded = false
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
      } catch {
        declaredFixtures = {}
      }
      const selection = selectInstallVerificationLayer({ review, declaredFixtures })
      selectedLayer = selection.layer
      if (selection.layer === 'manual_runtime') {
        if (originallyAutomatic && input.retention === 'temporary') {
          automaticVerificationDegraded = true
          verification = sanitizeHostVerificationEvidence({
            attempted: false,
            layer: 'manual_runtime',
            status: 'failed',
            expectedTools,
            sourceMatched: true,
            reason: `${selection.reason} Automatic verification lacked fixture, schema, or Host evidence after install.`,
          })
        } else {
          verification = manualRuntimeEvidence(expectedTools, selection.reason)
        }
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
        } catch {
          verification = interruptedVerification(expectedTools, selection.layer)
        }
      }
    }
    const layer = verification.layer ?? selectedLayer
    const status: VerificationStatus = verification.status
      ?? (layer === 'manual_runtime' ? 'pending_user_test' : 'uncertain')
    const mechanical = sourceMatched && (
      layer === 'manual_runtime'
        ? status === 'pending_user_test'
        : hostLayerSuccess({ sourceMatched, layer, verification })
    )
    const verified = mechanical && layer === 'tool_roundtrip' && status === 'passed'
    const activated = mechanical && layer === 'bundle_activation' && status === 'passed'
    const awaitingUserTest = mechanical && layer === 'manual_runtime' && status === 'pending_user_test'
    const nonFailure = verified || activated || awaitingUserTest
    const mechanicallyLoaded = sourceMatched && (
      verified
      || activated
      || awaitingUserTest
      || (verification.attempted && verification.exitCode === 0)
    )
    // A manual-runtime candidate is not mechanically proven against the live
    // profile state. Loading third-party startup code into the serving DSH
    // process can therefore terminate the Host before the final receipt is
    // committed (for example, a detached rejected Promise cannot be contained
    // by this call's try/catch). Keep the current Host alive and cross a clean
    // process boundary before the user performs the required real-client test.
    const hotReloadAttempt: HotReloadAttempt | undefined = input.retention === 'persistent' && awaitingUserTest
      ? {
          evidence: {
            attempted: false,
            loaded: false,
            method: 'unsupported',
            reason: 'Manual-runtime plugins are not activated inside the serving DSH process; restart is required before the real-client test.',
          },
        }
      : input.retention === 'persistent' && nonFailure
        ? await this.hotLoader({
            ctx: this.ctx,
            dshHome,
            profile: input.targetProfile,
            packageName,
            expectedTools: review.manifest.expectedTools,
            ...(exec.agent ? { agent: exec.agent } : {}),
          })
        : undefined
    const hotReload = hotReloadAttempt?.evidence
    const runtimeRecoveryRequired = Boolean(nonFailure && hotReloadAttempt?.rollbackFailed === true)
    const failedTemporaryTrialRemoved = input.retention === 'temporary'
      && !nonFailure
      && (
        (verification.attempted && status !== 'pending_user_test')
        || automaticVerificationDegraded
      )
    if (failedTemporaryTrialRemoved) await this.removeOwnedDirectory(trialRoot, trialsRoot)

    // Workflow maps `verified` to the installed/restart_required success nodes;
    // `activated` and `awaiting_user_test` (Host install outcomes for
    // bundle_activation / manual_runtime) map to their own distinct success nodes.
    let installOutcome: InstallOutcome
    if (runtimeRecoveryRequired) installOutcome = 'recovery_required'
    else if (verified) installOutcome = 'verified'
    else if (activated) installOutcome = 'activated'
    else if (awaitingUserTest) installOutcome = 'awaiting_user_test'
    else if (failedTemporaryTrialRemoved) installOutcome = 'failed_absent'
    else installOutcome = 'recovery_required'

    const contributionEligible = review.sourceSnapshot.kind === 'local' && verified && review.fit === 'full'
      && review.recommendation === 'use' && Boolean(review.license)
    let success = nonFailure && !runtimeRecoveryRequired
    let replacementJournal = destinationJournal.replacement
    let predecessorInstallationId = input.replacement?.predecessorInstallationId ?? destinationJournal.predecessorInstallationId
    if (input.replacement && input.retention === 'persistent') {
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
        const predecessor = await this.resolvePredecessor(input.replacement)
        predecessorInstallationId = predecessor?.id ?? predecessorInstallationId
      }
    }
    const outcomeFailure: InstallFailure | undefined = success
      ? undefined
      : runtimeRecoveryRequired
        ? lifecycleFailure(
            'load',
            'load_recovery_required',
            'Current-process Loader activation could not be rolled back cleanly.',
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
    const record: InstallationRecord = {
      ...destinationJournal,
      installPhase: 'completed',
      installState: failedTemporaryTrialRemoved ? 'not_installed' : 'installed',
      installOutcome,
      installed: success,
      ...(replacementJournal ? { replacement: replacementJournal } : {}),
      ...(predecessorInstallationId ? { predecessorInstallationId } : {}),
      // Persistent installs are "loaded" only when the destination process
      // itself activated the bundle. An isolated child or pending user test
      // cannot make that claim for the live profile.
      loaded: success
        ? (input.retention === 'persistent' ? hotReload?.loaded === true : mechanicallyLoaded)
        : false,
      verified: verified && !runtimeRecoveryRequired,
      restartRequired: input.retention === 'persistent' && success && !hotReload?.loaded,
      ...(hotReload ? { hotReload } : {}),
      ...(outcomeFailure ? { installFailure: outcomeFailure } : {}),
      removed: failedTemporaryTrialRemoved,
      verification: failedTemporaryTrialRemoved
        ? { ...verification, reason: `${verification.reason} Failed temporary trial was removed.` }
        : runtimeRecoveryRequired
          ? { ...verification, reason: `${verification.reason} Current-process Loader activation could not be rolled back; explicit recovery is required before retry or restart.` }
          : success
            ? (input.retention === 'persistent' && hotReload && !hotReload.loaded
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
    }
    try {
      await this.store.put('installations', record)
      if (input.replacement && replacementJournal?.state === 'new_present' && predecessorInstallationId) {
        const predecessor = await this.store.getInstallation(predecessorInstallationId).catch(() => undefined)
        if (predecessor && !predecessor.supersededByInstallationId && predecessor.packageName === packageName) {
          await this.store.put('installations', {
            ...predecessor,
            supersededByInstallationId: record.id,
          })
        }
      }
    } catch (cause) {
      let rollbackFailure: unknown
      if (hotReloadAttempt?.rollback) {
        try {
          await hotReloadAttempt.rollback()
        } catch (error) {
          rollbackFailure = error
        }
      }
      const persistFailure = installFailure(cause, 'persist')
      if (input.retention === 'temporary') await this.removeOwnedDirectory(trialRoot, trialsRoot)
      try {
        await this.store.put('installations', {
          ...provisional,
          installOutcome: 'recovery_required',
          installFailure: persistFailure,
          removed: input.retention === 'temporary',
          verification: {
            ...verification,
            reason: input.retention === 'temporary'
              ? `${verification.reason} Final receipt persistence failed; the owned temporary trial was removed.`
              : `${verification.reason} Final receipt persistence failed; recover by installationId and reconcile the exact live source.`,
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
        diagnosticHash: hashObject({
          cause: cause instanceof Error ? cause.message : String(cause),
          ...(rollbackFailure ? { rollback: rollbackFailure instanceof Error ? rollbackFailure.message : String(rollbackFailure) } : {}),
        }),
      })
    }
    return record
  }

  private async attachSemanticVerification(
    review: ReviewRecord,
    installationId: string,
    verification: VerificationEvidence,
    exec: ToolRunContext,
  ): Promise<{ request?: VerifierRequest; verdict?: VerificationVerdict }> {
    if (!this.semanticVerifier || !exec.agent) return {}
    const evidenceDigest = verificationEvidenceDigest(verification)
    try {
      const result = await this.semanticVerifier.run({
        parent: exec.agent as Agent,
        installationId,
        reviewId: review.id,
        requirement: review.requirement,
        evidenceDigest,
        receipt: redactVerificationReceipt(verification),
        timeoutMs: this.config.commandTimeoutMs,
        ...(exec.signal ? { signal: exec.signal } : {}),
      })
      if (result.request.reviewId !== review.id || result.verdict.reviewId !== review.id) {
        throw new EvolutionError('invalid_input', 'Semantic verifier result is not bound to this review')
      }
      if (result.request.installationId !== installationId || result.verdict.installationId !== installationId) {
        throw new EvolutionError('invalid_input', 'Semantic verifier result is not bound to this installation')
      }
      if (result.request.id !== result.verdict.requestId) {
        throw new EvolutionError('invalid_input', 'Semantic verifier verdict is not bound to its request')
      }
      if (result.request.evidenceDigest !== evidenceDigest || result.verdict.evidenceDigest !== evidenceDigest) {
        throw new EvolutionError('invalid_input', 'Semantic verifier evidence digest mismatch')
      }
      if (result.verdict.requirementHash !== requirementHashFor(review.requirement)) {
        throw new EvolutionError('invalid_input', 'Semantic verifier requirement hash mismatch')
      }
      return result
    } catch (error) {
      if (error instanceof EvolutionError && (error.code === 'invalid_input' || error.code === 'review_rejected')) {
        return {}
      }
      const request = mintVerifierRequest({
        installationId,
        reviewId: review.id,
        requirement: review.requirement,
        evidenceDigest,
      })
      const completedAt = new Date().toISOString()
      return {
        request: { ...request, status: 'completed', startedAt: request.createdAt, completedAt },
        verdict: {
          requestId: request.id,
          installationId,
          reviewId: review.id,
          requirementHash: requirementHashFor(review.requirement),
          evidenceDigest,
          verifierSessionId: 'host',
          verifierVersion: VERIFIER_VERSION,
          decision: 'uncertain',
          evidence: [(error instanceof Error ? error.message : String(error)).slice(0, 300)],
          conditions: [],
          createdAt: completedAt,
        },
      }
    }
  }
}

export const _testing = {
  validateProfile,
  verificationTask,
  verificationExpectation,
  assertStrictInstallSpec,
  expectedGithubInstallSpec,
  outcomeAfterCommandFailure,
  selectInstallVerificationLayer,
  installApprovalReason,
}
