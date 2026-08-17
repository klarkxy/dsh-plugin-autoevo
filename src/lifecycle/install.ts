import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { RuntimeConfig } from '../config.js'
import type { InstallationState, InstallInput, InstallationRecord, ReviewRecord, VerificationEvidence } from '../contracts.js'
import { EvolutionError } from '../errors.js'
import { assertSafePackageName } from '../package-name.js'
import { hashObject } from '../state/hashes.js'
import type { StateStore } from '../state/store.js'
import { assertOwnedTrialPath, type DshLauncher } from './launcher.js'

export type ReviewRevalidator = (review: ReviewRecord, signal?: AbortSignal) => Promise<boolean>
export type InstallAuthorizer = (review: ReviewRecord, exec: ToolRunContext) => void | Promise<void>

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
  if (input.retention === 'temporary' && !task) {
    throw new EvolutionError('invalid_input', 'temporary installation requires a non-empty verificationTask')
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

function emptyVerification(expectedTools: readonly string[]): VerificationEvidence {
  return {
    attempted: false,
    expectedTools: [...expectedTools],
    calledTools: [],
    resultTools: [],
    failedTools: [],
    sessionFiles: [],
    taskResultObserved: false,
    reason: 'No verificationTask was supplied; loaded and verified remain false.',
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

function interruptedVerification(task: string, expectedTools: readonly string[]): VerificationEvidence {
  return {
    attempted: true,
    task,
    exitCode: null,
    expectedTools: [...expectedTools],
    calledTools: [],
    resultTools: [],
    failedTools: [],
    sessionFiles: [],
    taskResultObserved: false,
    reason: 'Verification could not complete; no trusted tool round-trip was accepted.',
  }
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
  installState: InstallationState,
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
    reason: (installState === 'installed'
      ? 'The DSH installation command did not complete successfully, but profile reconciliation found the dependency installed; verification is still required.'
      : installState === 'not_installed'
        ? 'The DSH installation command did not complete successfully and profile reconciliation found no installed dependency.'
        : 'The DSH installation command did not complete successfully and profile reconciliation failed; recovery is required before retrying.')
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

function githubInstallSpec(review: ReviewRecord): string | null {
  if (review.sourceSnapshot.kind !== 'github' || !review.manifest.packageName) return null
  return `github:${review.sourceSnapshot.repository}#${review.sourceSnapshot.commit}`
}

export class PluginInstaller {
  constructor(
    private readonly ctx: Context,
    private readonly config: RuntimeConfig,
    private readonly store: StateStore,
    private readonly launcher: DshLauncher,
    private readonly revalidate: ReviewRevalidator,
    private readonly authorizeInstall?: InstallAuthorizer,
  ) {}

  private async removeOwnedDirectory(candidate: string, ownedRoot: string): Promise<void> {
    await mkdir(ownedRoot, { recursive: true })
    try {
      const owned = await assertOwnedTrialPath(candidate, ownedRoot)
      await rm(owned, { recursive: true, force: false })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  async install(input: InstallInput, exec: ToolRunContext): Promise<InstallationRecord> {
    validateProfile(input.targetProfile)
    const task = verificationTask(input)
    const expectedText = verificationExpectation(input, task)
    const review = await this.store.getReview(input.reviewId)
    const packageName = assertSafePackageName(review.manifest.packageName)
    if (this.authorizeInstall) await this.authorizeInstall(review, exec)
    const installableSpec = review.installSpec ?? githubInstallSpec(review)
    const sourceCanInstall = review.sourceSnapshot.kind === 'local' || Boolean(installableSpec)
    const userChoseUse = Boolean(this.authorizeInstall)
    const hardSkip = review.findings.some((finding) => finding.code === 'prompt_injection' || finding.code === 'dynamic_evaluation')
    const blocked = review.manifest.kind !== 'bundle'
      || review.fit !== 'full'
      || review.compatibility.status === 'incompatible'
      || !sourceCanInstall
      || review.findings.some((finding) => finding.code === 'review_truncated')
      || hardSkip
      || (!userChoseUse && (review.recommendation !== 'use' || review.securityRisk === 'high'))
    if (blocked) {
      throw new EvolutionError('review_rejected', 'This review does not authorize installation', {
        recommendation: review.recommendation,
        securityRisk: review.securityRisk,
        compatibility: review.compatibility.status,
        fit: review.fit,
        manifestKind: review.manifest.kind,
      })
    }
    if (!await this.revalidate(review, exec.signal)) {
      throw new EvolutionError('review_expired', 'The reviewed source changed or could not be revalidated; resume the capability workflow to review again')
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

    let installSpec = review.installSpec ?? installableSpec
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
      targetProfile: input.targetProfile,
      retention: input.retention,
      dshHome,
      packageName,
      installSpec,
      ...(ownedArtifactRoot ? { ownedArtifactRoot } : {}),
      ...(artifactSha256 ? { artifactSha256 } : {}),
      installState: 'unknown',
      installed: false,
      loaded: false,
      verified: false,
      restartRequired: input.retention === 'persistent',
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
          installState = await this.launcher.hasProfileDependency(dshHome, input.targetProfile, packageName)
            ? 'installed'
            : 'not_installed'
        } catch {
          installState = 'unknown'
        }
      }
      const failedRecord: InstallationRecord = {
        ...provisional,
        installState,
        installed: installState === 'installed',
        removed,
        installFailure: failure,
        verification: failedInstallation(review.manifest.expectedTools, installState, failure),
      }
      await this.store.put('installations', failedRecord)
      return failedRecord
    }
    let verification: VerificationEvidence
    if (task) {
      try {
        verification = await this.launcher.verify(
          dshHome,
          input.targetProfile,
          cwd,
          task,
          review.manifest.expectedTools,
          expectedText,
          exec.signal,
        )
      } catch {
        verification = interruptedVerification(task, review.manifest.expectedTools)
      }
    } else {
      verification = emptyVerification(review.manifest.expectedTools)
    }
    const expectedTools = review.manifest.expectedTools
    const loadOnly = expectedTools.length === 0
    const loaded = verification.attempted && verification.exitCode === 0
      && (loadOnly
        ? verification.taskResultObserved
        : expectedTools.some((name) => verification.calledTools.includes(name)))
    const verified = loaded && verification.taskResultObserved && verification.taskResultMatchedExpectation !== false
      && (loadOnly
        || expectedTools.every((name) => verification.calledTools.includes(name)
          && verification.resultTools.includes(name)
          && !verification.failedTools.includes(name)))
    const failedTemporaryTrialRemoved = input.retention === 'temporary' && verification.attempted && !verified
    if (failedTemporaryTrialRemoved) await this.removeOwnedDirectory(trialRoot, trialsRoot)
    const contributionEligible = review.sourceSnapshot.kind === 'local' && verified && review.fit === 'full'
      && review.recommendation === 'use' && Boolean(review.license)
    const record: InstallationRecord = {
      ...provisional,
      installState: 'installed',
      installed: true,
      loaded,
      verified,
      restartRequired: input.retention === 'persistent',
      removed: failedTemporaryTrialRemoved,
      verification: failedTemporaryTrialRemoved
        ? { ...verification, reason: `${verification.reason} Failed temporary trial was removed.` }
        : verification,
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
      if (input.retention === 'temporary') {
        await this.removeOwnedDirectory(trialRoot, trialsRoot)
        try {
          await this.store.put('installations', {
            ...provisional,
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
        diagnosticHash: hashObject({ cause: cause instanceof Error ? cause.message : String(cause) }),
      })
    }
    return record
  }
}

export const _testing = { validateProfile, verificationTask, verificationExpectation }
