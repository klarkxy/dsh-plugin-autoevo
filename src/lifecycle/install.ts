import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { RuntimeConfig } from '../config.js'
import type {
  InstallationState,
  InstallInput,
  InstallationRecord,
  InstallOutcome,
  ReviewRecord,
  VerificationEvidence,
  VerificationLayerKind,
  VerificationStatus,
  VerificationVerdict,
  VerifierRequest,
} from '../contracts.js'
import { EvolutionError } from '../errors.js'
import {
  hostLayerSuccess,
  sanitizeHostVerificationEvidence,
  selectInstallVerificationLayer,
} from '../host-verification-driver.js'
import { assertSafePackageName } from '../package-name.js'
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
import { hashObject } from '../state/hashes.js'
import type { StateStore } from '../state/store.js'
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

function installFailure(error: unknown): NonNullable<InstallationRecord['installFailure']> {
  if (error instanceof EvolutionError) {
    const message = error.message.normalize('NFKC').replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim().slice(0, 400)
    const exitCode = typeof error.details.exitCode === 'number' || error.details.exitCode === null
      ? error.details.exitCode
      : undefined
    const diagnosticHash = typeof error.details.diagnosticHash === 'string'
      && /^[a-f0-9]{64}$/u.test(error.details.diagnosticHash)
      ? error.details.diagnosticHash
      : undefined
    return {
      code: error.code,
      message,
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(diagnosticHash ? { diagnosticHash } : {}),
    }
  }
  const message = (error instanceof Error ? error.message : String(error))
    .normalize('NFKC').replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim().slice(0, 400)
  return { code: 'command_failed', message: message || 'Unknown installation failure' }
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
      + ` ${failure.message}.${diagnostic}`,
  }
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
  ) {
    this.hotLoader = hotLoader ?? hotLoadInstalledBundle
  }

  private async removeOwnedDirectory(candidate: string, ownedRoot: string): Promise<void> {
    await mkdir(ownedRoot, { recursive: true })
    try {
      const owned = await assertOwnedTrialPath(candidate, ownedRoot)
      await rm(owned, { recursive: true, force: false })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
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
    const scripts = review.manifest.scripts.length > 0 ? review.manifest.scripts.join(', ') : 'none'
    const riskFindings = review.findings
      .filter((finding) => finding.severity === 'block' || review.securityRisk === 'high')
      .slice(0, 8)
      .map((finding) => `${finding.code}:${finding.severity}`)
    const findings = review.findings.length > 0
      ? review.findings.slice(0, 8).map((finding) => `${finding.code}:${finding.severity}`).join(', ')
      : 'none'
    const riskPrefix = review.securityRisk === 'high'
      ? `HIGH RISK (${riskFindings.join(', ') || review.securityRisk}). `
      : ''
    await requestApproval(
      this.ctx,
      exec,
      `${riskPrefix}Install reviewed ${packageName} into profile ${input.targetProfile} (${input.retention}). Review: fit=${review.fit}, risk=${review.securityRisk}, compatibility=${review.compatibility.status}, lifecycleScripts=${scripts}, findings=${findings}.`,
      'capability_workflow_resume',
    )

    const id = `installation_${hashObject({ reviewId: review.id, at: new Date().toISOString(), nonce: randomUUID() }).slice(0, 24)}`
    const createdAt = new Date().toISOString()
    const trialRoot = this.store.trialRoot(id)
    const trialsRoot = path.join(this.store.root, 'trials')
    const artifactsRoot = path.join(this.store.root, 'artifacts')
    const dshHome = input.retention === 'temporary' ? path.join(trialRoot, 'dsh-home') : this.config.dshHome
    if (input.retention === 'temporary') await mkdir(dshHome, { recursive: true })
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
      installState: 'unknown',
      installOutcome: 'pending',
      installed: false,
      loaded: false,
      verified: false,
      restartRequired: false,
      removed: false,
      verification: pendingVerification(review.manifest.expectedTools),
    }
    try {
      await this.store.put('installations', provisional)
    } catch (error) {
      if (input.retention === 'temporary') await this.removeOwnedDirectory(trialRoot, trialsRoot)
      else if (ownedArtifactRoot) await this.removeOwnedDirectory(ownedArtifactRoot, artifactsRoot)
      throw error
    }

    try {
      await this.launcher.install(dshHome, input.targetProfile, installSpec, cwd, exec.signal)
    } catch (error) {
      const failure = installFailure(error)
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
        ...provisional,
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
    const loaded = sourceMatched && (
      verified
      || activated
      || awaitingUserTest
      || (verification.attempted && verification.exitCode === 0)
    )
    const hotReloadAttempt = input.retention === 'persistent' && nonFailure
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

    // Workflow currently treats only `verified` as graph success. `activated`
    // and `awaiting_user_test` are the Host install outcomes for
    // bundle_activation / manual_runtime; cursor mapping is a later node.
    let installOutcome: InstallOutcome
    if (runtimeRecoveryRequired) installOutcome = 'recovery_required'
    else if (verified) installOutcome = 'verified'
    else if (activated) installOutcome = 'activated'
    else if (awaitingUserTest) installOutcome = 'awaiting_user_test'
    else if (failedTemporaryTrialRemoved) installOutcome = 'failed_absent'
    else installOutcome = 'recovery_required'

    const contributionEligible = review.sourceSnapshot.kind === 'local' && verified && review.fit === 'full'
      && review.recommendation === 'use' && Boolean(review.license)
    const success = nonFailure && !runtimeRecoveryRequired
    const record: InstallationRecord = {
      ...provisional,
      installState: failedTemporaryTrialRemoved ? 'not_installed' : 'installed',
      installOutcome,
      installed: success,
      loaded: success ? loaded : false,
      verified: verified && !runtimeRecoveryRequired,
      restartRequired: input.retention === 'persistent' && success && !hotReload?.loaded,
      ...(hotReload ? { hotReload } : {}),
      removed: failedTemporaryTrialRemoved,
      verification: failedTemporaryTrialRemoved
        ? { ...verification, reason: `${verification.reason} Failed temporary trial was removed.` }
        : runtimeRecoveryRequired
          ? { ...verification, reason: `${verification.reason} Current-process Loader activation could not be rolled back; explicit recovery is required before retry or restart.` }
          : success
            ? (input.retention === 'persistent' && hotReload && !hotReload.loaded
              ? { ...verification, reason: `${verification.reason} Current-process hot reload did not complete (${hotReload.reason}); restart is required.` }
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
    } catch (cause) {
      let rollbackFailure: unknown
      if (hotReloadAttempt?.rollback) {
        try {
          await hotReloadAttempt.rollback()
        } catch (error) {
          rollbackFailure = error
        }
      }
      if (input.retention === 'temporary') {
        await this.removeOwnedDirectory(trialRoot, trialsRoot)
        try {
          await this.store.put('installations', {
            ...provisional,
            installOutcome: 'recovery_required',
            removed: true,
            verification: {
              ...verification,
              reason: `${verification.reason} Final receipt persistence failed; the owned temporary trial was removed.`,
            },
          })
        } catch {
          // The provisional receipt remains the recovery anchor.
        }
      }
      throw new EvolutionError('command_failed', 'Installation completed but final receipt persistence failed; a recovery receipt was preserved', {
        installationId: id,
        recoveryRequired: true,
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
}
