import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeConfig } from '../../src/config.js'
import type { ReviewRecord, VerificationEvidence } from '../../src/contracts.js'
import { PluginInstaller, _testing as installTesting } from '../../src/lifecycle/install.js'
import type { DshLauncher } from '../../src/lifecycle/launcher.js'
import { StateStore } from '../../src/state/store.js'

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((entry) => rm(entry, { recursive: true, force: true })))
})

function review(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    schemaVersion: 1,
    id: `review_${'a'.repeat(64)}`,
    policyVersion: 'v2-2026-08-15',
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
    const installer = new PluginInstaller(ctx, config(root), store, launcher, async () => true)
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
    })
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
    }, execution())).rejects.toThrow(/package bytes changed after user confirmation/i)
  })
})
