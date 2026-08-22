import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
import { sha256 } from '../../src/state/hashes.js'

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

function attestedSurface(expectedTools: readonly string[] = ['calculator']): NonNullable<ReviewRecord['runtimeSurface']> {
  return {
    llmDependency: false,
    llmRegistered: false,
    credentialsDependency: false,
    credentialsRegistered: false,
    networkSignal: false,
    environmentSignal: false,
    processSignal: false,
    skillOnly: false,
    unsafeTools: false,
    expectedTools: [...expectedTools],
    toolFixtures: expectedTools.map((tool) => ({
      tool, available: true, safe: true, hostValidated: true,
    })),
    kind: 'bundle',
    verificationLayer: expectedTools.length > 0 ? 'tool_roundtrip' : 'bundle_activation',
  }
}

function attestedReview(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  const current = review(overrides)
  return {
    ...current,
    runtimeSurface: overrides.runtimeSurface ?? attestedSurface(current.manifest.expectedTools),
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

function unusedVerifier(): SemanticVerifierHost {
  return {
    async run() {
      throw new Error('semantic verifier / model path must not drive mechanical verification')
    },
  }
}

const hostPassedEvidence: VerificationEvidence = {
  attempted: true,
  exitCode: 0,
  expectedTools: ['calculator'],
  calledTools: ['calculator'],
  resultTools: ['calculator'],
  failedTools: [],
  sessionFiles: [],
  taskResultObserved: false,
  layer: 'tool_roundtrip',
  status: 'passed',
  sourceMatched: true,
  reason: 'Host executed 1 expected tool(s) once through ToolRuntime.execute.',
}

const hostFailedEvidence: VerificationEvidence = {
  attempted: true,
  exitCode: 1,
  expectedTools: ['calculator'],
  calledTools: ['calculator'],
  resultTools: [],
  failedTools: ['calculator'],
  sessionFiles: [],
  taskResultObserved: false,
  layer: 'tool_roundtrip',
  status: 'failed',
  sourceMatched: true,
  reason: 'Host tool execution failed; the same fixture digest will not be retried.',
}

function jsonFixtures(): Record<string, unknown> {
  return { calculator: { arguments: { expression: '1+1' } } }
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

  it('returns recovery_required on Host verification failure and does not report installed success', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-outcome-mismatch-'))
    temporary.push(root)
    const store = new StateStore(root)
    await store.put('reviews', attestedReview())
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const verifyHost = vi.fn(async () => hostFailedEvidence)
    const verify = vi.fn(async () => { throw new Error('LLM verify must not drive mechanical verification') })
    const launcher = {
      install: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
      profileSourceMatches: async () => true,
      readInstalledVerificationFixtures: async () => jsonFixtures(),
      verifyHost,
      verify,
    } as unknown as DshLauncher
    const installer = new PluginInstaller(ctx, config(root), store, launcher, async () => true)
    const result = await installer.install({
      reviewId: review().id,
      targetProfile: 'persistent',
      retention: 'persistent',
      verificationTask: 'calculate 6 * 7',
      verificationExpectedText: '42',
    }, execution())
    expect(verifyHost).toHaveBeenCalledTimes(1)
    expect(verify).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      installOutcome: 'recovery_required',
      installed: false,
      verified: false,
      removed: false,
    })
  })

  it('reports verified success only after Host tool_roundtrip and never calls a semantic verifier', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-outcome-ok-'))
    temporary.push(root)
    const store = new StateStore(root)
    await store.put('reviews', attestedReview())
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const verifyHost = vi.fn(async () => hostPassedEvidence)
    const verify = vi.fn(async () => { throw new Error('LLM verify must not drive mechanical verification') })
    const launcher = {
      install: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
      profileSourceMatches: async () => true,
      readInstalledVerificationFixtures: async () => jsonFixtures(),
      verifyHost,
      verify,
    } as unknown as DshLauncher
    const verifier = unusedVerifier()
    const run = vi.spyOn(verifier, 'run')
    const installer = new PluginInstaller(ctx, config(root), store, launcher, async () => true, undefined, async () => ({
      evidence: { attempted: true, loaded: true, method: 'loader', reason: 'hot-loaded' },
    }), verifier)
    const result = await installer.install({
      reviewId: review().id,
      targetProfile: 'persistent',
      retention: 'persistent',
      verificationTask: 'test calculator',
    }, execution())
    expect(verifyHost).toHaveBeenCalledTimes(1)
    expect(verify).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    expect(result.verificationVerdict).toBeUndefined()
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
    await store.put('reviews', attestedReview())
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const launcher = {
      install: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
      profileSourceMatches: async () => true,
      readInstalledVerificationFixtures: async () => jsonFixtures(),
      verifyHost: async () => hostPassedEvidence,
      verify: async () => { throw new Error('LLM verify must not drive mechanical verification') },
    } as unknown as DshLauncher
    const verifier = unusedVerifier()
    const run = vi.spyOn(verifier, 'run')
    const installer = new PluginInstaller(ctx, config(root), store, launcher, async () => true, undefined, async () => ({
      evidence: { attempted: true, loaded: false, method: 'unsupported', reason: 'different active profile' },
    }), verifier)
    const result = await installer.install({
      reviewId: review().id,
      targetProfile: 'persistent',
      retention: 'persistent',
      verificationTask: 'test calculator',
    }, execution())
    expect(run).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      installOutcome: 'verified',
      installed: true,
      loaded: false,
      verified: true,
      restartRequired: true,
      hotReload: { attempted: true, loaded: false, method: 'unsupported' },
    })
  })

  it('preflights the exact source in isolated headless before installing into the live profile', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-outcome-preflight-'))
    temporary.push(root)
    const store = new StateStore(root)
    await store.put('reviews', attestedReview())
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const install = vi.fn(async (
      _home: string, _profile: string, _spec: string, _cwd: string, _signal?: AbortSignal,
    ) => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }))
    const verifyHost = vi.fn(async () => hostPassedEvidence)
    const launcher = {
      profileTargetAbsent: async () => true,
      install,
      profileSourceMatches: async () => true,
      readInstalledVerificationFixtures: async () => jsonFixtures(),
      verifyHost,
    } as unknown as DshLauncher
    const installer = new PluginInstaller(
      ctx,
      config(root),
      store,
      launcher,
      async () => true,
      undefined,
      async () => ({ evidence: { attempted: true, loaded: false, method: 'unsupported', reason: 'restart' } }),
      unusedVerifier(),
      'headless',
    )
    const result = await installer.install({
      reviewId: review().id,
      targetProfile: 'web',
      retention: 'persistent',
    }, execution())

    expect(install).toHaveBeenCalledTimes(2)
    expect(install.mock.calls[0]?.[1]).toBe('headless')
    expect(install.mock.calls[1]?.[0]).toBe(config(root).dshHome)
    expect(install.mock.calls[1]?.[1]).toBe('web')
    expect(install.mock.calls[0]?.[2]).toBe(install.mock.calls[1]?.[2])
    expect(result).toMatchObject({
      installPhase: 'completed',
      targetProfile: 'web',
      installOutcome: 'verified',
      loaded: false,
      restartRequired: true,
      preflight: { profile: 'headless', passed: true, sourceMatched: true },
    })
  })

  it('does not mutate the destination when isolated headless preflight fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-outcome-preflight-fail-'))
    temporary.push(root)
    const store = new StateStore(root)
    await store.put('reviews', attestedReview())
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const install = vi.fn(async (
      _home: string, _profile: string, _spec: string, _cwd: string, _signal?: AbortSignal,
    ) => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }))
    const launcher = {
      profileTargetAbsent: async () => true,
      install,
      profileSourceMatches: async () => true,
      readInstalledVerificationFixtures: async () => jsonFixtures(),
      verifyHost: async () => hostFailedEvidence,
    } as unknown as DshLauncher
    const result = await new PluginInstaller(
      ctx, config(root), store, launcher, async () => true, undefined, undefined, undefined, 'headless',
    ).install({ reviewId: review().id, targetProfile: 'web', retention: 'persistent' }, execution())

    expect(install).toHaveBeenCalledTimes(1)
    expect(install.mock.calls[0]?.[1]).toBe('headless')
    expect(result).toMatchObject({
      installPhase: 'completed',
      installOutcome: 'failed_absent',
      installState: 'not_installed',
      installed: false,
      preflight: { passed: false },
    })
  })

  it('rechecks destination absence after preflight and refuses a concurrent install race', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-outcome-preflight-race-'))
    temporary.push(root)
    const store = new StateStore(root)
    await store.put('reviews', attestedReview())
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    let absenceChecks = 0
    const install = vi.fn(async (
      _home: string, _profile: string, _spec: string, _cwd: string, _signal?: AbortSignal,
    ) => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }))
    const launcher = {
      profileTargetAbsent: async () => {
        absenceChecks += 1
        return absenceChecks === 1
      },
      install,
      profileSourceMatches: async () => true,
      readInstalledVerificationFixtures: async () => jsonFixtures(),
      verifyHost: async () => hostPassedEvidence,
    } as unknown as DshLauncher
    const installer = new PluginInstaller(
      ctx, config(root), store, launcher, async () => true, undefined, undefined, undefined, 'headless',
    )

    await expect(installer.install({
      reviewId: review().id,
      targetProfile: 'web',
      retention: 'persistent',
    }, execution())).rejects.toThrow(/refusing to overwrite or remove a user-owned installation/i)
    expect(absenceChecks).toBe(2)
    expect(install).toHaveBeenCalledTimes(1)
    expect(install.mock.calls[0]?.[1]).toBe('headless')
  })

  it('uses headless only for activation preflight when the real result requires a user test', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-outcome-manual-preflight-'))
    temporary.push(root)
    const manual = attestedReview({
      runtimeSurface: {
        ...attestedSurface(),
        networkSignal: true,
        verificationLayer: 'manual_runtime',
      },
    })
    const store = new StateStore(root)
    await store.put('reviews', manual)
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const install = vi.fn(async (
      _home: string, _profile: string, _spec: string, _cwd: string, _signal?: AbortSignal,
    ) => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }))
    const verifyHost = vi.fn(async (input: { layer: string; expectedTools: string[] }): Promise<VerificationEvidence> => {
      expect(input).toMatchObject({ layer: 'bundle_activation', expectedTools: [] })
      return {
        attempted: true,
        exitCode: 0,
        expectedTools: [],
        calledTools: [],
        resultTools: [],
        failedTools: [],
        sessionFiles: [],
        taskResultObserved: false,
        layer: 'bundle_activation',
        status: 'passed',
        sourceMatched: true,
        reason: 'isolated activation passed',
      }
    })
    const launcher = {
      profileTargetAbsent: async () => true,
      install,
      profileSourceMatches: async () => true,
      readInstalledVerificationFixtures: async () => ({}),
      verifyHost,
    } as unknown as DshLauncher
    const result = await new PluginInstaller(
      ctx,
      config(root),
      store,
      launcher,
      async () => true,
      undefined,
      async () => ({ evidence: { attempted: true, loaded: false, method: 'unsupported', reason: 'restart' } }),
      undefined,
      'headless',
    ).install({ reviewId: manual.id, targetProfile: 'web', retention: 'persistent' }, execution())

    expect(install).toHaveBeenCalledTimes(2)
    expect(verifyHost).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      installOutcome: 'awaiting_user_test',
      installed: true,
      loaded: false,
      verified: false,
      restartRequired: true,
      preflight: { passed: true, verification: { layer: 'bundle_activation', status: 'passed' } },
      verification: { layer: 'manual_runtime', status: 'pending_user_test' },
    })
  })

  it('rehashes a managed local artifact after preflight before destination mutation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-outcome-preflight-drift-'))
    temporary.push(root)
    const local = attestedReview({
      sourceSnapshot: {
        kind: 'local',
        path: path.join(root, 'source'),
        baseReviewId: `review_${'b'.repeat(64)}`,
        baseCommit: 'c'.repeat(40),
        statusHash: 'd'.repeat(64),
      },
      installSpec: `file:${path.join(root, 'confirmed.tgz').replaceAll('\\', '/')}`,
    })
    const store = new StateStore(root)
    await store.put('reviews', local)
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const install = vi.fn(async (
      _home: string, _profile: string, _spec: string, _cwd: string, _signal?: AbortSignal,
    ) => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }))
    let artifact = ''
    const launcher = {
      profileTargetAbsent: async () => true,
      materializeLocal: async (_review: ReviewRecord, artifactRoot: string) => {
        await mkdir(artifactRoot, { recursive: true })
        artifact = path.join(artifactRoot, 'package.tgz')
        const bytes = Buffer.from('reviewed bytes')
        await writeFile(artifact, bytes)
        return {
          installSpec: `file:${artifact.replaceAll('\\', '/')}`,
          artifactRoot,
          artifactSha256: sha256(bytes),
        }
      },
      install,
      profileSourceMatches: async () => true,
      readInstalledVerificationFixtures: async () => jsonFixtures(),
      verifyHost: async () => {
        await writeFile(artifact, 'changed after preflight')
        return hostPassedEvidence
      },
    } as unknown as DshLauncher
    const installer = new PluginInstaller(
      ctx, config(root), store, launcher, async () => true, undefined, undefined, undefined, 'headless',
    )

    await expect(installer.install({
      reviewId: local.id,
      targetProfile: 'web',
      retention: 'persistent',
    }, execution())).rejects.toThrow(/bytes changed between isolated preflight and destination install/i)
    expect(install).toHaveBeenCalledTimes(1)
    expect(install.mock.calls[0]?.[1]).toBe('headless')
  })

  it('refuses to overwrite an existing destination package before approval or preflight', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-outcome-existing-'))
    temporary.push(root)
    const store = new StateStore(root)
    await store.put('reviews', attestedReview())
    const request = vi.fn(async () => 'allowed-once')
    const ctx = { get: () => ({ request }) } as unknown as Context
    const install = vi.fn()
    const launcher = { profileTargetAbsent: async () => false, install } as unknown as DshLauncher
    const installer = new PluginInstaller(
      ctx, config(root), store, launcher, async () => true, undefined, undefined, undefined, 'headless',
    )

    await expect(installer.install({
      reviewId: review().id,
      targetProfile: 'web',
      retention: 'persistent',
    }, execution())).rejects.toThrow(/refusing to overwrite or remove a user-owned installation/i)
    expect(request).not.toHaveBeenCalled()
    expect(install).not.toHaveBeenCalled()
  })

  it('rechecks the live profile owner immediately before any persistent mutation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-outcome-owner-drift-'))
    temporary.push(root)
    const store = new StateStore(root)
    await store.put('reviews', attestedReview())
    const request = vi.fn(async () => 'allowed-once')
    const ctx = { get: () => ({ request }) } as unknown as Context
    const profileTargetAbsent = vi.fn(async () => true)
    const launcher = { profileTargetAbsent } as unknown as DshLauncher
    const installer = new PluginInstaller(
      ctx,
      config(root),
      store,
      launcher,
      async () => true,
      undefined,
      undefined,
      undefined,
      'headless',
      async () => 'headless',
    )

    await expect(installer.install({
      reviewId: review().id,
      targetProfile: 'web',
      retention: 'persistent',
    }, execution())).rejects.toThrow(/no longer matches the live DSH profile headless/i)
    expect(profileTargetAbsent).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })

  it('does not pass provider, route, or expected-text into verifyHost', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-outcome-route-'))
    temporary.push(root)
    const routed = review({
      manifest: {
        ...review().manifest,
        expectedRoute: { provider: 'xai-oauth', model: 'grok-4.5' },
      },
      runtimeSurface: {
        ...attestedSurface(),
        expectedRoute: { provider: 'xai-oauth', model: 'grok-4.5' },
        llmRegistered: true,
        verificationLayer: 'manual_runtime',
      },
    })
    const store = new StateStore(root)
    await store.put('reviews', routed)
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const verifyHost = vi.fn(async () => { throw new Error('route/provider must not spawn Host verification') })
    const launcher = {
      install: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
      profileSourceMatches: async () => true,
      readInstalledVerificationFixtures: async () => jsonFixtures(),
      verifyHost,
    } as unknown as DshLauncher
    const installer = new PluginInstaller(ctx, config(root), store, launcher, async () => true)
    const result = await installer.install({
      reviewId: routed.id,
      targetProfile: 'persistent',
      retention: 'persistent',
      verificationTask: 'answer with Grok',
      verificationExpectedText: '42',
    }, execution())
    expect(verifyHost).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      installOutcome: 'awaiting_user_test',
      installed: true,
      verified: false,
      verification: { layer: 'manual_runtime', status: 'pending_user_test' },
    })
  })

  it('reports activated after Host bundle_activation and never claims verified', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-outcome-activated-'))
    temporary.push(root)
    const none = attestedReview({
      manifest: {
        ...review().manifest,
        packageName: 'dsh-subscription-auth',
        expectedTools: [],
      },
      runtimeSurface: attestedSurface([]),
    })
    const store = new StateStore(root)
    await store.put('reviews', none)
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const verifyHost = vi.fn(async (): Promise<VerificationEvidence> => ({
      attempted: true,
      exitCode: 0,
      expectedTools: [],
      calledTools: [],
      resultTools: [],
      failedTools: [],
      sessionFiles: [],
      taskResultObserved: false,
      layer: 'bundle_activation',
      status: 'passed',
      sourceMatched: true,
      reason: 'Host loaded the reviewed bundle and Loader/Fiber settled without an Agent turn.',
    }))
    const launcher = {
      install: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
      profileSourceMatches: async () => true,
      readInstalledVerificationFixtures: async () => ({}),
      verifyHost,
      verify: async () => { throw new Error('LLM verify must not drive mechanical verification') },
    } as unknown as DshLauncher
    const verifier = unusedVerifier()
    const run = vi.spyOn(verifier, 'run')
    const installer = new PluginInstaller(ctx, config(root), store, launcher, async () => true, undefined, async () => ({
      evidence: { attempted: true, loaded: true, method: 'loader', reason: 'hot-loaded' },
    }), verifier)
    const result = await installer.install({
      reviewId: none.id,
      targetProfile: 'persistent',
      retention: 'persistent',
    }, execution())
    expect(verifyHost).toHaveBeenCalledTimes(1)
    expect(run).not.toHaveBeenCalled()
    expect(result.verificationVerdict).toBeUndefined()
    expect(result).toMatchObject({
      installOutcome: 'activated',
      installState: 'installed',
      installed: true,
      loaded: true,
      verified: false,
      verification: { layer: 'bundle_activation', status: 'passed' },
    })
  })

  it('rejects temporary manual_runtime before approval, materialize, install, or receipt', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-outcome-manual-temp-'))
    temporary.push(root)
    class CountingStore extends StateStore {
      installationWrites = 0

      override async put(...args: Parameters<StateStore['put']>): Promise<void> {
        if (args[0] === 'installations') this.installationWrites += 1
        await super.put(...args)
      }
    }
    const store = new CountingStore(root)
    const manual = attestedReview({
      runtimeSurface: {
        ...attestedSurface(),
        toolFixtures: [{ tool: 'calculator', available: true, safe: false, hostValidated: false }],
        verificationLayer: 'manual_runtime',
      },
    })
    await store.put('reviews', manual)
    let approvals = 0
    const ctx = { get: () => ({
      request: async () => {
        approvals += 1
        return 'allowed-once'
      },
    }) } as unknown as Context
    let installs = 0
    let materializes = 0
    let verifyHostCalls = 0
    const launcher = {
      install: async () => {
        installs += 1
        throw new Error('must not install')
      },
      materializeLocal: async () => {
        materializes += 1
        throw new Error('must not materialize')
      },
      verifyHost: async () => {
        verifyHostCalls += 1
        throw new Error('must not verify')
      },
    } as unknown as DshLauncher
    const installer = new PluginInstaller(ctx, config(root), store, launcher, async () => true)
    await expect(installer.install({
      reviewId: manual.id,
      targetProfile: 'web',
      retention: 'temporary',
      verificationTask: 'calculate 6 * 7',
      verificationExpectedText: '42',
    }, execution())).rejects.toThrow(/manual_runtime cannot be installed as a temporary trial/i)
    expect(approvals).toBe(0)
    expect(installs).toBe(0)
    expect(materializes).toBe(0)
    expect(verifyHostCalls).toBe(0)
    expect(store.installationWrites).toBe(0)
  })

  it('cannot mint tool_roundtrip from unattested or self-declared fixtures', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-outcome-unattested-'))
    temporary.push(root)
    const unattested = attestedReview({
      runtimeSurface: {
        ...attestedSurface(),
        toolFixtures: [{ tool: 'calculator', available: true, safe: true, hostValidated: false }],
        verificationLayer: 'manual_runtime',
      },
    })
    const store = new StateStore(root)
    await store.put('reviews', unattested)
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const verifyHost = vi.fn(async () => { throw new Error('unattested fixtures must not spawn Host verification') })
    const launcher = {
      install: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
      profileSourceMatches: async () => true,
      readInstalledVerificationFixtures: async () => ({ calculator: { safe: true, arguments: { expression: '1+1' } } }),
      verifyHost,
    } as unknown as DshLauncher
    const verifier = unusedVerifier()
    const run = vi.spyOn(verifier, 'run')
    const hotLoader = vi.fn(async () => ({
      evidence: { attempted: true, loaded: true, method: 'loader' as const, reason: 'hot-loaded' },
    }))
    const installer = new PluginInstaller(
      ctx,
      config(root),
      store,
      launcher,
      async () => true,
      undefined,
      hotLoader,
      verifier,
    )
    const result = await installer.install({
      reviewId: unattested.id,
      targetProfile: 'persistent',
      retention: 'persistent',
    }, execution())
    expect(verifyHost).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    expect(hotLoader).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      installOutcome: 'awaiting_user_test',
      installed: true,
      loaded: false,
      verified: false,
      restartRequired: true,
      hotReload: {
        attempted: false,
        loaded: false,
        method: 'unsupported',
      },
      verification: { layer: 'manual_runtime', status: 'pending_user_test' },
    })
  })

  it('reports recovery rather than restart when failed hot-load could not roll back', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-outcome-hot-recovery-'))
    temporary.push(root)
    const store = new StateStore(root)
    await store.put('reviews', attestedReview())
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const launcher = {
      install: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
      profileSourceMatches: async () => true,
      readInstalledVerificationFixtures: async () => jsonFixtures(),
      verifyHost: async () => hostPassedEvidence,
      verify: async () => { throw new Error('LLM verify must not drive mechanical verification') },
    } as unknown as DshLauncher
    const installer = new PluginInstaller(ctx, config(root), store, launcher, async () => true, undefined, async () => ({
      evidence: { attempted: true, loaded: false, method: 'failed', reason: 'activation and rollback failed' },
      rollbackFailed: true,
    }), unusedVerifier())
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

  it('maps rollbackFailed to recovery_required for activated but never hot-loads awaiting_user_test', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-outcome-hot-recovery-layers-'))
    temporary.push(root)
    const store = new StateStore(root)
    const none = attestedReview({
      manifest: {
        ...review().manifest,
        packageName: 'dsh-subscription-auth',
        expectedTools: [],
      },
      runtimeSurface: attestedSurface([]),
    })
    await store.put('reviews', none)
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const rollback = vi.fn(async () => ({
      evidence: { attempted: true, loaded: false, method: 'failed' as const, reason: 'activation and rollback failed' },
      rollbackFailed: true,
    }))
    const activatedLauncher = {
      install: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
      profileSourceMatches: async () => true,
      readInstalledVerificationFixtures: async () => ({}),
      verifyHost: async (): Promise<VerificationEvidence> => ({
        attempted: true,
        exitCode: 0,
        expectedTools: [],
        calledTools: [],
        resultTools: [],
        failedTools: [],
        sessionFiles: [],
        taskResultObserved: false,
        layer: 'bundle_activation',
        status: 'passed',
        sourceMatched: true,
        reason: 'Host loaded the reviewed bundle and Loader/Fiber settled without an Agent turn.',
      }),
    } as unknown as DshLauncher
    const activated = await new PluginInstaller(
      ctx, config(root), store, activatedLauncher, async () => true, undefined, rollback,
    ).install({
      reviewId: none.id,
      targetProfile: 'persistent',
      retention: 'persistent',
    }, execution())
    expect(activated).toMatchObject({
      installOutcome: 'recovery_required',
      installed: false,
      restartRequired: false,
    })
    expect(activated.verification.reason).toMatch(/explicit recovery/i)
    expect(rollback).toHaveBeenCalledTimes(1)

    await store.put('reviews', review())
    const awaitingLauncher = {
      install: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
      profileSourceMatches: async () => true,
      readInstalledVerificationFixtures: async () => jsonFixtures(),
      verifyHost: async () => { throw new Error('manual_runtime must not spawn') },
    } as unknown as DshLauncher
    const awaiting = await new PluginInstaller(
      ctx, config(root), store, awaitingLauncher, async () => true, undefined, rollback,
    ).install({
      reviewId: review().id,
      targetProfile: 'persistent',
      retention: 'persistent',
    }, execution())
    expect(awaiting).toMatchObject({
      installOutcome: 'awaiting_user_test',
      installed: true,
      loaded: false,
      restartRequired: true,
      hotReload: { attempted: false, loaded: false, method: 'unsupported' },
      verification: { layer: 'manual_runtime', status: 'pending_user_test' },
    })
    expect(awaiting.verification.reason).toMatch(/not activated inside the serving DSH process/i)
    expect(rollback).toHaveBeenCalledTimes(1)
  })

  it('keeps verificationTask and expectedText as human prompts that never enter verifyHost', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-outcome-substring-diagnostic-'))
    temporary.push(root)
    const store = new StateStore(root)
    await store.put('reviews', attestedReview())
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const verifyHost = vi.fn(async (input: unknown) => {
      const serialized = JSON.stringify(input)
      expect(serialized).not.toContain('calculate 6 * 7')
      expect(serialized).not.toContain('42')
      expect(serialized).not.toContain('verificationTask')
      expect(serialized).not.toContain('verificationExpectedText')
      expect(serialized).not.toContain('expectedRoute')
      return hostPassedEvidence
    })
    const launcher = {
      install: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
      profileSourceMatches: async () => true,
      readInstalledVerificationFixtures: async () => jsonFixtures(),
      verifyHost,
    } as unknown as DshLauncher
    const verifier = unusedVerifier()
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
    expect(verifyHost).toHaveBeenCalledTimes(1)
    expect(run).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      installOutcome: 'verified',
      installState: 'installed',
      installed: true,
      verified: true,
    })
    expect(result.verification.task).toBeUndefined()
    expect(result.verificationVerdict).toBeUndefined()
  })

  it('does not let a semantic verifier override a missing mechanical Host tool result', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-outcome-mechanical-override-'))
    temporary.push(root)
    const store = new StateStore(root)
    await store.put('reviews', attestedReview())
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const verifyHost = vi.fn(async () => hostFailedEvidence)
    const launcher = {
      install: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
      profileSourceMatches: async () => true,
      readInstalledVerificationFixtures: async () => jsonFixtures(),
      verifyHost,
    } as unknown as DshLauncher
    const verifier = unusedVerifier()
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
    expect(verifyHost).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      installOutcome: 'recovery_required',
      installed: false,
      verified: false,
    })
    expect(result.verificationVerdict).toBeUndefined()
  })

  it('requires the target profile to bind the exact reviewed source before verification can succeed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-outcome-source-mismatch-'))
    temporary.push(root)
    const store = new StateStore(root)
    await store.put('reviews', attestedReview())
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const verifyHost = vi.fn(async () => hostPassedEvidence)
    const verify = vi.fn(async () => { throw new Error('LLM verify must not drive mechanical verification') })
    const launcher = {
      install: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
      profileSourceMatches: async () => false,
      readInstalledVerificationFixtures: async () => jsonFixtures(),
      verifyHost,
      verify,
    } as unknown as DshLauncher
    const installer = new PluginInstaller(ctx, config(root), store, launcher, async () => true)
    const result = await installer.install({
      reviewId: review().id,
      targetProfile: 'persistent',
      retention: 'persistent',
      verificationTask: 'test calculator',
    }, execution())
    expect(verifyHost).not.toHaveBeenCalled()
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
    const local = attestedReview({
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

  it('verifies a Host tool round-trip without using expected-text substring or a model verifier', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-outcome-no-substring-'))
    temporary.push(root)
    const store = new StateStore(root)
    await store.put('reviews', attestedReview())
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const verifyHost = vi.fn(async (input: unknown) => {
      const fields = Object.keys(input as Record<string, unknown>)
      expect(fields).not.toContain('verificationExpectedText')
      expect(fields).not.toContain('expectedText')
      expect(fields).not.toContain('verificationTask')
      expect(fields).not.toContain('task')
      return hostPassedEvidence
    })
    const launcher = {
      install: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
      profileSourceMatches: async () => true,
      readInstalledVerificationFixtures: async () => jsonFixtures(),
      verifyHost,
    } as unknown as DshLauncher
    const verifier = unusedVerifier()
    const run = vi.spyOn(verifier, 'run')
    const installer = new PluginInstaller(
      ctx, config(root), store, launcher, async () => true, undefined, undefined, verifier,
    )
    const result = await installer.install({
      reviewId: review().id,
      targetProfile: 'web',
      retention: 'temporary',
      verificationTask: 'test calculator',
      verificationExpectedText: '42',
    }, execution())
    expect(run).not.toHaveBeenCalled()
    expect(result, result.verification.reason).toMatchObject({
      installOutcome: 'verified',
      verified: true,
    })
    expect(result.verificationVerdict).toBeUndefined()
  })

  it('cannot verify when Host tool results are missing, even if a verifier would approve', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-outcome-substring-only-'))
    temporary.push(root)
    const store = new StateStore(root)
    await store.put('reviews', attestedReview())
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const launcher = {
      install: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
      profileSourceMatches: async () => true,
      readInstalledVerificationFixtures: async () => jsonFixtures(),
      verifyHost: async (): Promise<VerificationEvidence> => ({
        ...hostPassedEvidence,
        calledTools: [],
        resultTools: [],
        failedTools: [],
        status: 'failed',
        exitCode: 1,
        reason: 'no successful Host tool result',
      }),
    } as unknown as DshLauncher
    const verifier = unusedVerifier()
    const run = vi.spyOn(verifier, 'run')
    const installer = new PluginInstaller(
      ctx, config(root), store, launcher, async () => true, undefined, undefined, verifier,
    )
    const result = await installer.install({
      reviewId: review().id,
      targetProfile: 'persistent',
      retention: 'persistent',
      verificationTask: 'test calculator',
      verificationExpectedText: '42',
    }, execution())
    expect(run).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      installOutcome: 'recovery_required',
      verified: false,
    })
  })

  it('does not consult a bound semantic verifier on the Host mechanical path', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-outcome-stale-verifier-'))
    temporary.push(root)
    const store = new StateStore(root)
    await store.put('reviews', attestedReview())
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const launcher = {
      install: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
      profileSourceMatches: async () => true,
      readInstalledVerificationFixtures: async () => jsonFixtures(),
      verifyHost: async () => hostPassedEvidence,
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
    const run = vi.spyOn(stale, 'run')
    const installer = new PluginInstaller(
      ctx, config(root), store, launcher, async () => true, undefined, undefined, stale,
    )
    const result = await installer.install({
      reviewId: review().id,
      targetProfile: 'persistent',
      retention: 'persistent',
      verificationTask: 'test calculator',
    }, execution())
    expect(run).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      installOutcome: 'verified',
      verified: true,
    })
    expect(result.verificationVerdict).toBeUndefined()
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

const riskyReview = () => attestedReview({
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
