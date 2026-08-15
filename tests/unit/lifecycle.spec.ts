import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeConfig } from '../../src/config.js'
import type { ReviewRecord, VerificationEvidence } from '../../src/contracts.js'
import { PluginInstaller, _testing as installTesting } from '../../src/lifecycle/install.js'
import type { DshLauncher } from '../../src/lifecycle/launcher.js'
import { PluginRemover } from '../../src/lifecycle/remove.js'
import { StateStore } from '../../src/state/store.js'
import { _testing as snapshotTesting } from '../../src/lifecycle/snapshot.js'

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
      kind: 'bundle', packageName: 'dsh-tool-calculator', bundlePatch: './cordis.patch.yml', scripts: ['prepare'], dependencies: [],
      peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.1.0-rc.6 <0.2.0' }, expectedTools: ['calculator'],
    },
    fit: 'full',
    confidence: 0.8,
    securityRisk: 'medium',
    maintained: true,
    license: 'MIT',
    compatibility: { status: 'compatible', reason: 'test', runtimeVersion: '0.1.0-rc.6' },
    missingCapabilities: [],
    findings: [{ code: 'lifecycle_script', severity: 'info', source: 'package.json', detail: 'declares lifecycle script: prepare' }],
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
  }
}

function execution(): ToolRunContext {
  return {
    callId: 'call-1',
    agent: { session: { header: { cwd: process.cwd() } } },
  } as unknown as ToolRunContext
}

describe('lifecycle validation', () => {
  it('accepts simple profile names and rejects path-shaped values', () => {
    expect(() => installTesting.validateProfile('temporary-check_1')).not.toThrow()
    expect(() => installTesting.validateProfile('../default')).toThrow(/profile name/u)
    expect(() => installTesting.validateProfile('a/b')).toThrow(/profile name/u)
  })

  it('requires a bounded non-empty verification task for temporary trials', () => {
    expect(() => installTesting.verificationTask({
      reviewId: `review_${'a'.repeat(64)}`,
      targetProfile: 'trial',
      retention: 'temporary',
    })).toThrow(/requires a non-empty verificationTask/u)
    expect(installTesting.verificationTask({
      reviewId: `review_${'a'.repeat(64)}`,
      targetProfile: 'persistent',
      retention: 'persistent',
    })).toBeUndefined()
    expect(() => installTesting.verificationExpectation({
      reviewId: `review_${'a'.repeat(64)}`,
      targetProfile: 'persistent',
      retention: 'persistent',
      verificationExpectedText: '42',
    }, undefined)).toThrow(/requires a verificationTask/u)
  })

  it('rejects shell metacharacters in local artifact paths forwarded by DSH on Windows', () => {
    expect(() => snapshotTesting.shellForwardedFileSpec('C:\\safe&unsafe\\plugin.tgz')).toThrow(/unsafe/u)
    expect(snapshotTesting.shellForwardedFileSpec('C:\\safe path\\plugin.tgz')).toMatch(/^file:/u)
  })

  it('rejects a partial candidate until it has been modified and reviewed as a full fit', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'capability-evolution-install-'))
    temporary.push(root)
    const store = new StateStore(root)
    await store.put('reviews', review({ fit: 'partial', recommendation: 'modify', missingCapabilities: ['scientific notation'] }))
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const launcher = { install: async () => { throw new Error('must not install') } } as unknown as DshLauncher
    const installer = new PluginInstaller(ctx, config(root), store, launcher, async () => true)

    await expect(installer.install({
      reviewId: `review_${'a'.repeat(64)}`,
      targetProfile: 'trial',
      retention: 'temporary',
      verificationTask: 'test calculator',
    }, execution())).rejects.toMatchObject({ code: 'review_rejected' })
  })

  it('makes no installation change when one-time approval is denied', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'capability-evolution-install-'))
    temporary.push(root)
    const store = new StateStore(root)
    await store.put('reviews', review())
    const ctx = { get: () => ({ request: async () => 'denied' }) } as unknown as Context
    const launcher = { install: async () => { throw new Error('must not install') } } as unknown as DshLauncher
    const installer = new PluginInstaller(ctx, config(root), store, launcher, async () => true)

    await expect(installer.install({
      reviewId: `review_${'a'.repeat(64)}`,
      targetProfile: 'trial',
      retention: 'temporary',
      verificationTask: 'test calculator',
    }, execution())).rejects.toMatchObject({ code: 'approval_required' })
    await expect(stat(path.join(root, 'trials'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('includes review risk in approval and removes a failed temporary trial', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'capability-evolution-install-'))
    temporary.push(root)
    const store = new StateStore(root)
    await store.put('reviews', review())
    let approvalReason = ''
    const ctx = {
      get: () => ({
        request: async ({ reason }: { reason: string }) => {
          approvalReason = reason
          return 'allowed-once'
        },
      }),
    } as unknown as Context
    const failedVerification: VerificationEvidence = {
      attempted: true,
      task: 'test calculator',
      exitCode: 0,
      expectedTools: ['calculator'],
      calledTools: [],
      resultTools: [],
      failedTools: [],
      sessionFiles: [],
      taskResultObserved: true,
      taskResultSha256: 'd'.repeat(64),
      reason: 'No matching tool round-trip.',
    }
    const launcher = {
      install: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, truncated: false }),
      verify: async () => failedVerification,
    } as unknown as DshLauncher
    const installer = new PluginInstaller(ctx, config(root), store, launcher, async () => true)
    const result = await installer.install({
      reviewId: `review_${'a'.repeat(64)}`,
      targetProfile: 'trial',
      retention: 'temporary',
      verificationTask: 'test calculator',
    }, execution())

    expect(approvalReason).toContain('risk=medium')
    expect(approvalReason).toContain('lifecycleScripts=prepare')
    expect(result).toMatchObject({ installed: true, loaded: false, verified: false, removed: true })
    expect(result.verification.reason).toContain('Failed temporary trial was removed.')
    await expect(stat(store.trialRoot(result.id))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('records failure and removes a temporary trial when installation throws', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'capability-evolution-install-'))
    temporary.push(root)
    const store = new StateStore(root)
    await store.put('reviews', review())
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const launcher = { install: async () => { throw new Error('simulated install failure') } } as unknown as DshLauncher
    const installer = new PluginInstaller(ctx, config(root), store, launcher, async () => true)

    await expect(installer.install({
      reviewId: `review_${'a'.repeat(64)}`,
      targetProfile: 'trial',
      retention: 'temporary',
      verificationTask: 'test calculator',
    }, execution())).resolves.toMatchObject({ installed: false, verified: false, removed: true })
    await expect(readdir(path.join(root, 'trials'))).resolves.toEqual([])
  })

  it('reconciles a persistent dependency after an ambiguous install-command failure', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'capability-evolution-install-'))
    temporary.push(root)
    const store = new StateStore(root)
    await store.put('reviews', review())
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const launcher = {
      install: async () => { throw new Error('timeout after manifest update') },
      hasProfileDependency: async () => true,
    } as unknown as DshLauncher
    const installer = new PluginInstaller(ctx, config(root), store, launcher, async () => true)

    const result = await installer.install({
      reviewId: `review_${'a'.repeat(64)}`,
      targetProfile: 'persistent',
      retention: 'persistent',
    }, execution())

    expect(result).toMatchObject({ installState: 'installed', installed: true, verified: false, removed: false })
    expect(result.verification.reason).toContain('profile reconciliation found the dependency installed')
  })

  it('marks a persistent install outcome unknown when reconciliation also fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'capability-evolution-install-'))
    temporary.push(root)
    const store = new StateStore(root)
    await store.put('reviews', review())
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const launcher = {
      install: async () => { throw new Error('timeout') },
      hasProfileDependency: async () => { throw new Error('profile unreadable') },
    } as unknown as DshLauncher
    const installer = new PluginInstaller(ctx, config(root), store, launcher, async () => true)

    const result = await installer.install({
      reviewId: `review_${'a'.repeat(64)}`,
      targetProfile: 'persistent',
      retention: 'persistent',
    }, execution())

    expect(result).toMatchObject({ installState: 'unknown', installed: false, verified: false, removed: false })
    expect(result.verification.reason).toContain('recovery is required')
  })

  it('rejects a completed child answer that misses the required expected text', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'capability-evolution-install-'))
    temporary.push(root)
    const store = new StateStore(root)
    await store.put('reviews', review())
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const launcher = {
      install: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
      verify: async (): Promise<VerificationEvidence> => ({
        attempted: true,
        task: 'calculate 6 * 7',
        exitCode: 0,
        expectedTools: ['calculator'],
        calledTools: ['calculator'],
        resultTools: ['calculator'],
        failedTools: [],
        sessionFiles: [],
        taskResultObserved: true,
        taskResultSha256: 'f'.repeat(64),
        taskResultMatchedExpectation: false,
        reason: 'wrong result',
      }),
    } as unknown as DshLauncher
    const installer = new PluginInstaller(ctx, config(root), store, launcher, async () => true)

    const result = await installer.install({
      reviewId: `review_${'a'.repeat(64)}`,
      targetProfile: 'trial',
      retention: 'temporary',
      verificationTask: 'calculate 6 * 7',
      verificationExpectedText: '42',
    }, execution())

    expect(result).toMatchObject({ installState: 'installed', installed: true, loaded: true, verified: false, removed: true })
  })

  it('uses a provisional receipt to recover from final receipt persistence failure', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'capability-evolution-install-'))
    temporary.push(root)
    class FailingFinalStore extends StateStore {
      installationWrites = 0

      override async put(...args: Parameters<StateStore['put']>): Promise<void> {
        if (args[0] === 'installations') {
          this.installationWrites += 1
          if (this.installationWrites === 2) throw new Error('simulated final receipt failure')
        }
        await super.put(...args)
      }
    }
    const store = new FailingFinalStore(root)
    await store.put('reviews', review())
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const launcher = {
      install: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
      verify: async (): Promise<VerificationEvidence> => ({
        attempted: true,
        task: 'test calculator',
        exitCode: 0,
        expectedTools: ['calculator'],
        calledTools: ['calculator'],
        resultTools: ['calculator'],
        failedTools: [],
        sessionFiles: [],
        taskResultObserved: true,
        reason: 'verified',
      }),
    } as unknown as DshLauncher
    const installer = new PluginInstaller(ctx, config(root), store, launcher, async () => true)

    let installationId = ''
    try {
      await installer.install({
        reviewId: `review_${'a'.repeat(64)}`,
        targetProfile: 'trial',
        retention: 'temporary',
        verificationTask: 'test calculator',
      }, execution())
      throw new Error('expected receipt persistence failure')
    } catch (error) {
      installationId = String((error as { details?: { installationId?: unknown } }).details?.installationId ?? '')
      expect(error).toMatchObject({ code: 'command_failed' })
    }
    expect(installationId).toMatch(/^installation_[a-f0-9]{24}$/u)
    await expect(store.getInstallation(installationId)).resolves.toMatchObject({ removed: true })
    await expect(stat(store.trialRoot(installationId))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('returns a removable receipt when persistent verification is interrupted', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'capability-evolution-install-'))
    temporary.push(root)
    const store = new StateStore(root)
    await store.put('reviews', review())
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const launcher = {
      install: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
      verify: async () => { throw new Error('simulated verification interruption') },
    } as unknown as DshLauncher
    const installer = new PluginInstaller(ctx, config(root), store, launcher, async () => true)

    const result = await installer.install({
      reviewId: `review_${'a'.repeat(64)}`,
      targetProfile: 'persistent-profile',
      retention: 'persistent',
      verificationTask: 'test calculator',
    }, execution())

    expect(result).toMatchObject({ installed: true, loaded: false, verified: false, removed: false, restartRequired: true })
    expect(result.verification.reason).toContain('could not complete')
    await expect(store.getInstallation(result.id)).resolves.toMatchObject({ id: result.id, verified: false })
  })

  it('recovers when an owned temporary trial was deleted before its receipt update', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'capability-evolution-remove-'))
    temporary.push(root)
    const store = new StateStore(root)
    const installationId = `installation_${'c'.repeat(24)}`
    await store.put('installations', {
      schemaVersion: 1,
      id: installationId,
      createdAt: '2026-08-15T00:00:00.000Z',
      reviewId: `review_${'a'.repeat(64)}`,
      targetProfile: 'trial',
      retention: 'temporary',
      dshHome: path.join(store.trialRoot(installationId), 'dsh-home'),
      packageName: 'dsh-tool-calculator',
      installSpec: `github:acme/calculator#${'c'.repeat(40)}`,
      installed: true,
      loaded: true,
      verified: true,
      restartRequired: false,
      removed: false,
      verification: {
        attempted: true,
        exitCode: 0,
        expectedTools: ['calculator'],
        calledTools: ['calculator'],
        resultTools: ['calculator'],
        failedTools: [],
        sessionFiles: [],
        taskResultObserved: true,
        reason: 'verified',
      },
    })
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const remover = new PluginRemover(ctx, config(root), store, {} as DshLauncher)

    await expect(remover.remove({ installationId }, execution())).resolves.toMatchObject({ removed: true })
    await expect(store.getInstallation(installationId)).resolves.toMatchObject({ removed: true })
  })

  it('removes an owned persistent artifact even when a failed install left no profile dependency', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'capability-evolution-remove-'))
    temporary.push(root)
    const store = new StateStore(root)
    const installationId = `installation_${'d'.repeat(24)}`
    const artifactRoot = path.join(root, 'artifacts', installationId)
    await mkdir(artifactRoot, { recursive: true })
    await writeFile(path.join(artifactRoot, 'plugin.tgz'), 'owned artifact')
    await store.put('installations', {
      schemaVersion: 1,
      id: installationId,
      createdAt: '2026-08-15T00:00:00.000Z',
      reviewId: `review_${'a'.repeat(64)}`,
      targetProfile: 'persistent',
      retention: 'persistent',
      dshHome: path.join(root, 'dsh-home'),
      packageName: 'dsh-tool-calculator',
      installSpec: `file:${path.join(artifactRoot, 'plugin.tgz').replaceAll('\\', '/')}`,
      ownedArtifactRoot: artifactRoot,
      artifactSha256: 'e'.repeat(64),
      installed: false,
      loaded: false,
      verified: false,
      restartRequired: true,
      removed: false,
      verification: {
        attempted: false,
        expectedTools: ['calculator'],
        calledTools: [],
        resultTools: [],
        failedTools: [],
        sessionFiles: [],
        taskResultObserved: false,
        reason: 'installation failed',
      },
    })
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    let removalCalled = false
    const launcher = {
      remove: async () => { removalCalled = true; return { exitCode: 1, signal: null, stdout: '', stderr: 'not installed' } },
      hasProfileDependency: async () => false,
    } as unknown as DshLauncher
    const remover = new PluginRemover(ctx, config(root), store, launcher)

    await expect(remover.remove({ installationId }, execution())).resolves.toMatchObject({ removed: true })
    expect(removalCalled).toBe(false)
    await expect(stat(artifactRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(store.getInstallation(installationId)).resolves.toMatchObject({ removed: true })
  })

  it('rejects an unsafe package name from a persistent recovery receipt before approval or DSH execution', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'capability-evolution-remove-'))
    temporary.push(root)
    const store = new StateStore(root)
    const installationId = `installation_${'f'.repeat(24)}`
    await store.put('installations', {
      schemaVersion: 1,
      id: installationId,
      createdAt: '2026-08-15T00:00:00.000Z',
      reviewId: `review_${'a'.repeat(64)}`,
      targetProfile: 'persistent',
      retention: 'persistent',
      dshHome: path.join(root, 'dsh-home'),
      packageName: 'calculator&whoami',
      installSpec: `github:acme/calculator#${'c'.repeat(40)}`,
      installed: false,
      loaded: false,
      verified: false,
      restartRequired: true,
      removed: false,
      verification: {
        attempted: false,
        expectedTools: ['calculator'],
        calledTools: [],
        resultTools: [],
        failedTools: [],
        sessionFiles: [],
        taskResultObserved: false,
        reason: 'installation failed',
      },
    })
    let approvalRequested = false
    const ctx = { get: () => ({ request: async () => { approvalRequested = true; return 'allowed-once' } }) } as unknown as Context
    let removalCalled = false
    const launcher = {
      remove: async () => { removalCalled = true; return { exitCode: 0, signal: null, stdout: '', stderr: '' } },
    } as unknown as DshLauncher
    const remover = new PluginRemover(ctx, config(root), store, launcher)

    await expect(remover.remove({ installationId }, execution())).rejects.toThrow(/package name is unsafe/u)
    expect(approvalRequested).toBe(false)
    expect(removalCalled).toBe(false)
  })
})
