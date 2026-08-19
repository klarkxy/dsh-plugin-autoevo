import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeConfig } from '../../src/config.js'
import { POLICY_VERSION, type ReviewRecord, type VerificationEvidence } from '../../src/contracts.js'
import { PluginInstaller, _testing as installTesting } from '../../src/lifecycle/install.js'
import type { DshLauncher } from '../../src/lifecycle/launcher.js'
import { reviewCandidateDigest, reviewSnapshotDigest } from '../../src/review/direct-use.js'
import { mintReviewerRequest, requirementHashFor, REVIEWER_VERSION } from '../../src/semantic-reviewer.js'
import {
  mintVerifierRequest,
  VERIFIER_VERSION,
  type SemanticVerifierHost,
} from '../../src/semantic-verifier.js'
import { StateStore } from '../../src/state/store.js'

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((entry) => rm(entry, { recursive: true, force: true })))
})

function review(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    schemaVersion: 1,
    id: `review_${'a'.repeat(64)}`,
    policyVersion: POLICY_VERSION,
    createdAt: '2026-08-15T00:00:00.000Z',
    resolutionId: `resolution_${'b'.repeat(24)}`,
    requirement: 'calculator',
    sourceSnapshot: {
      kind: 'github', repository: 'acme/calculator', requestedRef: 'main', commit: 'c'.repeat(40), defaultBranch: 'main',
    },
    inspectedFiles: [],
    manifest: {
      kind: 'bundle', packageName: 'dsh-tool-calculator', bundlePatch: './cordis.patch.yml', scripts: [], dependencies: [],
      peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.1.0-rc.6 <0.2.0' }, expectedTools: ['calculator'],
    },
    fit: 'full',
    confidence: 0.8,
    securityRisk: 'low',
    maintained: true,
    license: 'MIT',
    compatibility: { status: 'compatible', reason: 'test', runtimeVersion: '0.1.0-rc.6' },
    missingCapabilities: [],
    findings: [],
    recommendation: 'use',
    installSpec: `github:acme/calculator#${'c'.repeat(40)}`,
    ...overrides,
  }
}

function config(root: string): RuntimeConfig {
  return {
    dshHome: path.join(root, 'persistent-dsh-home'),
    stateDir: root,
    ghCommand: 'gh',
    gitCommand: 'git',
    dshCommand: 'dsh',
    dshCommandArgs: [],
    maxCandidates: 5,
    maxFiles: 80,
    maxRepositoryBytes: 1_048_576,
    commandTimeoutMs: 30_000,
    forwardedCredentialEnv: [],
    verificationPatchPaths: [],
    evolutionPreset: false,
  }
}

function execution(): ToolRunContext {
  return {
    callId: 'call-1',
    agent: { session: { header: { cwd: process.cwd() } } },
  } as unknown as ToolRunContext
}

function approvingVerifier(): SemanticVerifierHost {
  return {
    async run(input) {
      const request = mintVerifierRequest({
        installationId: input.installationId,
        reviewId: input.reviewId,
        requirement: input.requirement,
        evidenceDigest: input.evidenceDigest,
      })
      const completedAt = '2026-08-19T00:00:10.000Z'
      return {
        request: { ...request, status: 'completed', startedAt: request.createdAt, completedAt },
        verdict: {
          requestId: request.id,
          installationId: input.installationId,
          reviewId: input.reviewId,
          requirementHash: requirementHashFor(input.requirement),
          evidenceDigest: input.evidenceDigest,
          verifierSessionId: 'verifier-session',
          verifierVersion: VERIFIER_VERSION,
          decision: 'verified',
          evidence: ['mechanical receipt matches the requirement'],
          conditions: [],
          createdAt: completedAt,
        },
      }
    },
  }
}

const verifiedEvidence: VerificationEvidence = {
  attempted: true,
  task: 'test calculator',
  exitCode: 0,
  expectedTools: ['calculator'],
  calledTools: ['calculator'],
  resultTools: ['calculator'],
  failedTools: [],
  sessionFiles: [],
  taskResultObserved: true,
  taskResultMatchedExpectation: true,
  reason: 'verified',
}

describe('fail-closed install outcomes', () => {
  it('rejects missing and mismatched install specifications without synthesizing a fallback', () => {
    expect(() => installTesting.assertStrictInstallSpec(review({ installSpec: null }))).toThrow(/missing an immutable install specification/i)
    expect(() => installTesting.assertStrictInstallSpec(review({
      installSpec: `github:acme/calculator#${'d'.repeat(40)}`,
    }))).toThrow(/does not match the reviewed GitHub source/i)
    expect(installTesting.assertStrictInstallSpec(review())).toBe(`github:acme/calculator#${'c'.repeat(40)}`)
  })

  it('returns failed_absent when the install command fails and the target is confirmed absent', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-outcome-absent-'))
    temporary.push(root)
    const store = new StateStore(root)
    await store.put('reviews', review())
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const launcher = {
      install: async () => { throw new Error('dsh exited with code 1') },
      profileTargetAbsent: async () => true,
    } as unknown as DshLauncher
    const installer = new PluginInstaller(ctx, config(root), store, launcher, async () => true)
    const result = await installer.install({
      reviewId: review().id,
      targetProfile: 'persistent',
      retention: 'persistent',
      verificationTask: 'test calculator',
    }, execution())
    expect(result).toMatchObject({
      installOutcome: 'failed_absent',
      installState: 'not_installed',
      installed: false,
      verified: false,
    })
  })

  it('returns recovery_required when the install command fails but the target is present', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-outcome-present-'))
    temporary.push(root)
    const store = new StateStore(root)
    await store.put('reviews', review())
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const launcher = {
      install: async () => { throw new Error('timeout after manifest update') },
      profileTargetAbsent: async () => false,
    } as unknown as DshLauncher
    const installer = new PluginInstaller(ctx, config(root), store, launcher, async () => true)
    const result = await installer.install({
      reviewId: review().id,
      targetProfile: 'persistent',
      retention: 'persistent',
      verificationTask: 'test calculator',
    }, execution())
    expect(result).toMatchObject({
      installOutcome: 'recovery_required',
      installState: 'installed',
      installed: false,
      verified: false,
    })
  })

  it('returns recovery_required when reconciliation is unknown after command failure', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-outcome-unknown-'))
    temporary.push(root)
    const store = new StateStore(root)
    await store.put('reviews', review())
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const launcher = {
      install: async () => { throw new Error('timeout') },
      profileTargetAbsent: async () => { throw new Error('profile unreadable') },
    } as unknown as DshLauncher
    const installer = new PluginInstaller(ctx, config(root), store, launcher, async () => true)
    const result = await installer.install({
      reviewId: review().id,
      targetProfile: 'persistent',
      retention: 'persistent',
      verificationTask: 'test calculator',
    }, execution())
    expect(result).toMatchObject({
      installOutcome: 'recovery_required',
      installState: 'unknown',
      installed: false,
      verified: false,
    })
  })

  it('returns recovery_required on verification mismatch and does not report installed success', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-outcome-mismatch-'))
    temporary.push(root)
    const store = new StateStore(root)
    await store.put('reviews', review())
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const launcher = {
      install: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
      profileSourceMatches: async () => true,
      verify: async (): Promise<VerificationEvidence> => ({
        ...verifiedEvidence,
        taskResultMatchedExpectation: false,
        reason: 'wrong result',
      }),
    } as unknown as DshLauncher
    const installer = new PluginInstaller(ctx, config(root), store, launcher, async () => true)
    const result = await installer.install({
      reviewId: review().id,
      targetProfile: 'persistent',
      retention: 'persistent',
      verificationTask: 'calculate 6 * 7',
      verificationExpectedText: '42',
    }, execution())
    expect(result).toMatchObject({
      installOutcome: 'recovery_required',
      installed: false,
      verified: false,
      removed: false,
    })
  })

  it('reports verified success only after Loader/runtime verification', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-outcome-ok-'))
    temporary.push(root)
    const store = new StateStore(root)
    await store.put('reviews', review())
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const launcher = {
      install: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
      profileSourceMatches: async () => true,
      verify: async () => verifiedEvidence,
    } as unknown as DshLauncher
    const installer = new PluginInstaller(ctx, config(root), store, launcher, async () => true, undefined, async () => ({
      evidence: { attempted: true, loaded: true, method: 'loader', reason: 'hot-loaded' },
    }), approvingVerifier())
    const result = await installer.install({
      reviewId: review().id,
      targetProfile: 'persistent',
      retention: 'persistent',
      verificationTask: 'test calculator',
    }, execution())
    expect(result).toMatchObject({
      installOutcome: 'verified',
      installState: 'installed',
      installed: true,
      loaded: true,
      verified: true,
      restartRequired: false,
    })
  })

  it('keeps a verified persistent install usable but requests restart when hot-load is unsupported', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-outcome-restart-'))
    temporary.push(root)
    const store = new StateStore(root)
    await store.put('reviews', review())
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const launcher = {
      install: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
      profileSourceMatches: async () => true,
      verify: async () => verifiedEvidence,
    } as unknown as DshLauncher
    const installer = new PluginInstaller(ctx, config(root), store, launcher, async () => true, undefined, async () => ({
      evidence: { attempted: true, loaded: false, method: 'unsupported', reason: 'different active profile' },
    }), approvingVerifier())
    const result = await installer.install({
      reviewId: review().id,
      targetProfile: 'persistent',
      retention: 'persistent',
      verificationTask: 'test calculator',
    }, execution())
    expect(result).toMatchObject({
      installOutcome: 'verified',
      installed: true,
      verified: true,
      restartRequired: true,
      hotReload: { attempted: true, loaded: false, method: 'unsupported' },
    })
  })

  it('rejects verification performed through a different provider route', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-outcome-route-'))
    temporary.push(root)
    const routed = review({
      manifest: {
        ...review().manifest,
        expectedRoute: { provider: 'xai-oauth', model: 'grok-4.5' },
      },
    })
    const store = new StateStore(root)
    await store.put('reviews', routed)
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const launcher = {
      install: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
      profileSourceMatches: async () => true,
      verify: async () => ({ ...verifiedEvidence, routeMatchedExpectation: false, observedProvider: 'openai' }),
    } as unknown as DshLauncher
    const installer = new PluginInstaller(ctx, config(root), store, launcher, async () => true)
    const result = await installer.install({
      reviewId: routed.id,
      targetProfile: 'persistent',
      retention: 'persistent',
      verificationTask: 'answer with Grok',
    }, execution())
    expect(result).toMatchObject({
      installOutcome: 'recovery_required',
      installed: false,
      verified: false,
      restartRequired: false,
    })
  })

  it('reports recovery rather than restart when failed hot-load could not roll back', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-outcome-hot-recovery-'))
    temporary.push(root)
    const store = new StateStore(root)
    await store.put('reviews', review())
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const launcher = {
      install: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
      profileSourceMatches: async () => true,
      verify: async () => verifiedEvidence,
    } as unknown as DshLauncher
    const installer = new PluginInstaller(ctx, config(root), store, launcher, async () => true, undefined, async () => ({
      evidence: { attempted: true, loaded: false, method: 'failed', reason: 'activation and rollback failed' },
      rollbackFailed: true,
    }), approvingVerifier())
    const result = await installer.install({
      reviewId: review().id,
      targetProfile: 'persistent',
      retention: 'persistent',
      verificationTask: 'test calculator',
    }, execution())
    expect(result).toMatchObject({
      installOutcome: 'recovery_required',
      installed: false,
      verified: false,
      restartRequired: false,
    })
    expect(result.verification.reason).toMatch(/explicit recovery/i)
  })

  it('treats a substring miss as diagnostic when mechanical success has an exact approving verifier', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-outcome-substring-diagnostic-'))
    temporary.push(root)
    const store = new StateStore(root)
    await store.put('reviews', review())
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const launcher = {
      install: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
      profileSourceMatches: async () => true,
      verify: async (): Promise<VerificationEvidence> => ({
        ...verifiedEvidence,
        task: 'calculate 6 * 7',
        taskResultMatchedExpectation: false,
        reason: 'tool round-trip and completed turn succeeded; expected-text substring is diagnostic only and did not match.',
      }),
    } as unknown as DshLauncher
    const verifier = approvingVerifier()
    const run = vi.spyOn(verifier, 'run')
    const installer = new PluginInstaller(ctx, config(root), store, launcher, async () => true, undefined, async () => ({
      evidence: { attempted: true, loaded: true, method: 'loader', reason: 'hot-loaded' },
    }), verifier)
    const result = await installer.install({
      reviewId: review().id,
      targetProfile: 'persistent',
      retention: 'persistent',
      verificationTask: 'calculate 6 * 7',
      verificationExpectedText: '42',
    }, execution())
    expect(run).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      installOutcome: 'verified',
      installState: 'installed',
      installed: true,
      verified: true,
    })
    expect(result.verification.taskResultMatchedExpectation).toBe(false)
    expect(result.verificationVerdict?.decision).toBe('verified')
  })

  it('does not let a substring hit or verifier override a missing mechanical tool result', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-outcome-mechanical-override-'))
    temporary.push(root)
    const store = new StateStore(root)
    await store.put('reviews', review())
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const launcher = {
      install: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
      profileSourceMatches: async () => true,
      verify: async (): Promise<VerificationEvidence> => ({
        ...verifiedEvidence,
        calledTools: ['calculator'],
        resultTools: [],
        failedTools: ['calculator'],
        taskResultMatchedExpectation: true,
        reason: 'expected-text substring matched, but the matching tool result failed.',
      }),
    } as unknown as DshLauncher
    const verifier = approvingVerifier()
    const run = vi.spyOn(verifier, 'run')
    const installer = new PluginInstaller(
      ctx,
      config(root),
      store,
      launcher,
      async () => true,
      undefined,
      undefined,
      verifier,
    )
    const result = await installer.install({
      reviewId: review().id,
      targetProfile: 'persistent',
      retention: 'persistent',
      verificationTask: 'calculate 6 * 7',
      verificationExpectedText: '42',
    }, execution())
    expect(run).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      installOutcome: 'recovery_required',
      installed: false,
      verified: false,
    })
    expect(result.verification.taskResultMatchedExpectation).toBe(true)
    expect(result.verificationVerdict).toBeUndefined()
  })

  it('requires the target profile to bind the exact reviewed source before verification can succeed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-outcome-source-mismatch-'))
    temporary.push(root)
    const store = new StateStore(root)
    await store.put('reviews', review())
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const verify = vi.fn(async () => verifiedEvidence)
    const launcher = {
      install: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
      profileSourceMatches: async () => false,
      verify,
    } as unknown as DshLauncher
    const installer = new PluginInstaller(ctx, config(root), store, launcher, async () => true)
    const result = await installer.install({
      reviewId: review().id,
      targetProfile: 'persistent',
      retention: 'persistent',
      verificationTask: 'test calculator',
    }, execution())
    expect(verify).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      installOutcome: 'recovery_required',
      installed: false,
      loaded: false,
      verified: false,
    })
    expect(result.verification.reason).toMatch(/exact reviewed source/i)
  })

  it('rejects a managed local package whose packed bytes changed after confirmation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-outcome-artifact-drift-'))
    temporary.push(root)
    const store = new StateStore(root)
    const local = review({
      sourceSnapshot: {
        kind: 'local',
        path: path.join(root, 'source'),
        baseReviewId: `review_${'b'.repeat(64)}`,
        baseCommit: 'c'.repeat(40),
        statusHash: 'd'.repeat(64),
      },
      installSpec: `file:${path.join(root, 'confirmed.tgz').replaceAll('\\', '/')}`,
    })
    await store.put('reviews', local)
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const launcher = {
      materializeLocal: async () => ({
        installSpec: `file:${path.join(root, 'actual.tgz').replaceAll('\\', '/')}`,
        artifactRoot: path.join(root, 'actual'),
        artifactSha256: 'e'.repeat(64),
      }),
    } as unknown as DshLauncher
    const installer = new PluginInstaller(ctx, config(root), store, launcher, async () => true)
    await expect(installer.install({
      reviewId: local.id,
      targetProfile: 'persistent',
      retention: 'persistent',
      expectedArtifactSha256: 'f'.repeat(64),
      verificationTask: 'test calculator',
    }, execution())).rejects.toThrow(/package bytes changed after user confirmation/i)
  })

  it('verifies a real tool round-trip without expected-text substring when the semantic verifier approves', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-outcome-no-substring-'))
    temporary.push(root)
    const store = new StateStore(root)
    await store.put('reviews', review())
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const launcher = {
      install: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
      profileSourceMatches: async () => true,
      verify: async () => ({
        ...verifiedEvidence,
        taskResultMatchedExpectation: false,
        reason: 'tool round-trip observed',
      }),
    } as unknown as DshLauncher
    const installer = new PluginInstaller(
      ctx, config(root), store, launcher, async () => true, undefined, undefined, approvingVerifier(),
    )
    const result = await installer.install({
      reviewId: review().id,
      targetProfile: 'web',
      retention: 'temporary',
      verificationTask: 'test calculator',
      verificationExpectedText: '42',
    }, execution())
    expect(result).toMatchObject({
      installOutcome: 'verified',
      verified: true,
      verification: { taskResultMatchedExpectation: false },
    })
    expect(result.verificationVerdict?.decision).toBe('verified')
  })

  it('cannot verify a substring hit that lacks a successful tool result, even with a verified-looking submit', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-outcome-substring-only-'))
    temporary.push(root)
    const store = new StateStore(root)
    await store.put('reviews', review())
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const launcher = {
      install: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
      profileSourceMatches: async () => true,
      verify: async () => ({
        ...verifiedEvidence,
        calledTools: [],
        resultTools: [],
        failedTools: [],
        taskResultMatchedExpectation: true,
        reason: 'substring only',
      }),
    } as unknown as DshLauncher
    const installer = new PluginInstaller(
      ctx, config(root), store, launcher, async () => true, undefined, undefined, approvingVerifier(),
    )
    const result = await installer.install({
      reviewId: review().id,
      targetProfile: 'persistent',
      retention: 'persistent',
      verificationTask: 'test calculator',
      verificationExpectedText: '42',
    }, execution())
    expect(result).toMatchObject({
      installOutcome: 'recovery_required',
      verified: false,
    })
  })

  it('fails closed on a stale or wrong-bound verifier verdict', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-outcome-stale-verifier-'))
    temporary.push(root)
    const store = new StateStore(root)
    await store.put('reviews', review())
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const launcher = {
      install: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
      profileSourceMatches: async () => true,
      verify: async () => verifiedEvidence,
    } as unknown as DshLauncher
    const stale: SemanticVerifierHost = {
      async run(input) {
        const request = mintVerifierRequest({
          installationId: input.installationId,
          reviewId: input.reviewId,
          requirement: input.requirement,
          evidenceDigest: input.evidenceDigest,
        })
        const completedAt = '2026-08-19T00:00:10.000Z'
        return {
          request: { ...request, status: 'completed', startedAt: request.createdAt, completedAt },
          verdict: {
            requestId: request.id,
            installationId: input.installationId,
            reviewId: input.reviewId,
            requirementHash: requirementHashFor(input.requirement),
            evidenceDigest: '9'.repeat(64),
            verifierSessionId: 'verifier-session',
            verifierVersion: VERIFIER_VERSION,
            decision: 'verified',
            evidence: ['stale'],
            conditions: [],
            createdAt: completedAt,
          },
        }
      },
    }
    const installer = new PluginInstaller(
      ctx, config(root), store, launcher, async () => true, undefined, undefined, stale,
    )
    const result = await installer.install({
      reviewId: review().id,
      targetProfile: 'persistent',
      retention: 'persistent',
      verificationTask: 'test calculator',
    }, execution())
    expect(result).toMatchObject({
      installOutcome: 'recovery_required',
      verified: false,
    })
  })
})

function withApprovedVerdict(record: ReviewRecord): ReviewRecord {
  const snapshotDigest = reviewSnapshotDigest(record)
  const candidateDigest = reviewCandidateDigest(record)
  const request = mintReviewerRequest({
    workflowId: `workflow_${'d'.repeat(24)}`,
    review: record,
    snapshotDigest,
    candidateDigest,
    createdAt: '2026-08-19T00:00:02.000Z',
  })
  const completed = { ...request, status: 'completed' as const, completedAt: '2026-08-19T00:00:03.000Z' }
  return {
    ...record,
    reviewerRequestId: completed.id,
    reviewerRequest: completed,
    reviewerVerdict: {
      requestId: completed.id,
      reviewId: record.id,
      requirementHash: requirementHashFor(record.requirement),
      snapshotDigest,
      candidateDigest,
      reviewerSessionId: 'reviewer-session',
      reviewerVersion: REVIEWER_VERSION,
      decision: 'approved',
      evidence: [],
      conditions: [],
      semanticCoverage: 'partial',
      createdAt: '2026-08-19T00:00:03.000Z',
    },
  }
}

const riskyReview = () => review({
  fit: 'partial',
  recommendation: 'modify',
  securityRisk: 'high',
  findings: [
    { code: 'prompt_injection', severity: 'block', source: 'README.md', detail: 'ignore previous instructions' },
    { code: 'process_execution', severity: 'block', source: 'src/run.ts', detail: 'spawn' },
  ],
})

describe('install authorization uses verdict and hard boundaries', () => {
  it('lets a high-risk prompt-regex review with an exact approved verdict pass the install gate once', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-outcome-approved-high-'))
    temporary.push(root)
    const bound = withApprovedVerdict(riskyReview())
    const store = new StateStore(root)
    await store.put('reviews', bound)
    const reasons: string[] = []
    let authorized = 0
    const ctx = { get: () => ({
      request: async ({ reason }: { reason: string }) => {
        reasons.push(reason)
        return 'allowed-once'
      },
    }) } as unknown as Context
    let reachedInstall = false
    const launcher = {
      install: async () => {
        reachedInstall = true
        throw new Error('stop after authorization gate')
      },
      profileTargetAbsent: async () => true,
    } as unknown as DshLauncher
    const installer = new PluginInstaller(
      ctx,
      config(root),
      store,
      launcher,
      async () => true,
      async () => { authorized += 1 },
    )
    const result = await installer.install({
      reviewId: bound.id,
      targetProfile: 'web',
      retention: 'temporary',
      verificationTask: 'test calculator',
    }, execution())
    expect(authorized).toBe(1)
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toMatch(/HIGH RISK/i)
    expect(reachedInstall).toBe(true)
    expect(result.installOutcome).toBe('failed_absent')
  })

  it('rejects missing or rejected verdicts even when prompt-regex and high risk are the only findings', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-outcome-missing-verdict-'))
    temporary.push(root)
    const store = new StateStore(root)
    const missing = riskyReview()
    await store.put('reviews', missing)
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const launcher = { install: async () => { throw new Error('must not install') } } as unknown as DshLauncher
    const installer = new PluginInstaller(ctx, config(root), store, launcher, async () => true, async () => undefined)
    await expect(installer.install({
      reviewId: missing.id,
      targetProfile: 'web',
      retention: 'temporary',
      verificationTask: 'test calculator',
    }, execution())).rejects.toThrow(/verdict does not authorize direct use/i)

    const rejected = withApprovedVerdict(riskyReview())
    rejected.reviewerVerdict = { ...rejected.reviewerVerdict!, decision: 'rejected' }
    await store.put('reviews', rejected)
    await expect(installer.install({
      reviewId: rejected.id,
      targetProfile: 'web',
      retention: 'temporary',
      verificationTask: 'test calculator',
    }, execution())).rejects.toThrow(/verdict does not authorize direct use/i)
  })
})
