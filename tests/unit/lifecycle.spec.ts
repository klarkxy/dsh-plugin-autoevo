import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeConfig } from '../../src/config.js'
import { POLICY_VERSION, type ReviewRecord, type VerificationEvidence } from '../../src/contracts.js'
import { EvolutionError } from '../../src/errors.js'
import { PluginInstaller, _testing as installTesting } from '../../src/lifecycle/install.js'
import { DshLauncher } from '../../src/lifecycle/launcher.js'
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
    policyVersion: POLICY_VERSION,
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
    evolutionPreset: true,
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

  it('keeps verificationTask optional and never requires it for mechanical verification', () => {
    expect(installTesting.verificationTask({
      reviewId: `review_${'a'.repeat(64)}`,
      targetProfile: 'trial',
      retention: 'temporary',
    })).toBeUndefined()
    expect(installTesting.verificationTask({
      reviewId: `review_${'a'.repeat(64)}`,
      targetProfile: 'persistent',
      retention: 'persistent',
    })).toBeUndefined()
    expect(installTesting.verificationTask({
      reviewId: `review_${'a'.repeat(64)}`,
      targetProfile: 'trial',
      retention: 'temporary',
      verificationTask: 'test calculator',
    })).toBe('test calculator')
    expect(() => installTesting.verificationExpectation({
      reviewId: `review_${'a'.repeat(64)}`,
      targetProfile: 'persistent',
      retention: 'persistent',
      verificationTask: 'test calculator',
      verificationExpectedText: '42',
    }, undefined)).toThrow(/requires a verificationTask/u)
  })

  it('rejects shell metacharacters in local artifact paths forwarded by DSH on Windows', () => {
    expect(() => snapshotTesting.shellForwardedFileSpec('C:\\safe&unsafe\\plugin.tgz')).toThrow(/unsafe/u)
    expect(snapshotTesting.shellForwardedFileSpec('C:\\safe path\\plugin.tgz')).toMatch(/^file:/u)
  })

  it('matches only the exact profile source when the reviewed bundle is active', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'capability-evolution-profile-source-'))
    temporary.push(root)
    const profileRoot = path.join(root, 'home', 'profiles', 'trial')
    await mkdir(profileRoot, { recursive: true })
    const spec = `github:acme/calculator#${'c'.repeat(40)}`
    await writeFile(path.join(profileRoot, 'package.json'), `${JSON.stringify({
      dependencies: { 'dsh-tool-calculator': spec },
      dsh: { profile: { bundles: ['dsh-tool-calculator'] } },
    })}\n`)
    const launcher = new DshLauncher({ run: async () => { throw new Error('not used') } }, config(root))
    await expect(launcher.profileSourceMatches(path.join(root, 'home'), 'trial', 'dsh-tool-calculator', spec)).resolves.toBe(true)
    await expect(launcher.profileSourceMatches(path.join(root, 'home'), 'trial', 'dsh-tool-calculator', `${spec}-other`)).resolves.toBe(false)
  })

  it('rejects a none-fit candidate for direct install', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'capability-evolution-install-'))
    temporary.push(root)
    const store = new StateStore(root)
    await store.put('reviews', review({ fit: 'none', recommendation: 'modify', missingCapabilities: ['scientific notation'] }))
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
    await store.put('reviews', attestedReview())
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
    await store.put('reviews', attestedReview())
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
    const launcher = {
      install: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, truncated: false }),
      profileSourceMatches: async () => true,
      readInstalledVerificationFixtures: async () => ({ calculator: { arguments: { expression: '1+1' } } }),
      verifyHost: async () => failedVerification,
      verify: async () => { throw new Error('LLM verify must not drive mechanical verification') },
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
    expect(result).toMatchObject({
      installOutcome: 'failed_absent',
      installed: false,
      loaded: false,
      verified: false,
      removed: true,
    })
    expect(result.verification.reason).toContain('Failed temporary trial was removed.')
    await expect(stat(store.trialRoot(result.id))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('records failure and removes a temporary trial when installation throws', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'capability-evolution-install-'))
    temporary.push(root)
    const store = new StateStore(root)
    await store.put('reviews', attestedReview())
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const launcher = { install: async () => {
      throw new EvolutionError('command_failed', 'dsh exited with code 1', {
        exitCode: 1,
        diagnosticHash: 'b'.repeat(64),
      })
    } } as unknown as DshLauncher
    const installer = new PluginInstaller(ctx, config(root), store, launcher, async () => true)

    const result = await installer.install({
      reviewId: `review_${'a'.repeat(64)}`,
      targetProfile: 'trial',
      retention: 'temporary',
      verificationTask: 'test calculator',
    }, execution())
    expect(result).toMatchObject({
      installed: false,
      verified: false,
      removed: true,
      installFailure: {
        code: 'command_failed',
        message: 'dsh exited with code 1',
        exitCode: 1,
        diagnosticHash: 'b'.repeat(64),
      },
    })
    expect(result.verification.reason).toContain(`Diagnostic sha256: ${'b'.repeat(64)}`)
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
      profileTargetAbsent: async () => false,
    } as unknown as DshLauncher
    const installer = new PluginInstaller(ctx, config(root), store, launcher, async () => true)

    const result = await installer.install({
      reviewId: `review_${'a'.repeat(64)}`,
      targetProfile: 'persistent',
      retention: 'persistent',
      verificationTask: 'test calculator',
    }, execution())

    expect(result).toMatchObject({
      installState: 'installed',
      installOutcome: 'recovery_required',
      installed: false,
      verified: false,
      removed: false,
    })
    expect(result.verification.reason).toMatch(/present, unknown, or unverifiable|recovery is required/i)
  })

  it('activates a no-tool bundle from Host Loader evidence without a model or Agent turn', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'capability-evolution-install-'))
    temporary.push(root)
    const store = new StateStore(root)
    await store.put('reviews', review({
      manifest: {
        kind: 'bundle',
        packageName: 'dsh-subscription-auth',
        bundlePatch: './cordis.patch.yml',
        scripts: [],
        dependencies: [],
        peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.1.0-rc.6 <0.2.0' },
        expectedTools: [],
      },
      runtimeSurface: {
        llmDependency: false,
        llmRegistered: false,
        credentialsDependency: false,
        credentialsRegistered: false,
        networkSignal: false,
        environmentSignal: false,
        processSignal: false,
        skillOnly: false,
        unsafeTools: false,
        expectedTools: [],
        toolFixtures: [],
        kind: 'bundle',
        verificationLayer: 'bundle_activation',
      },
    }))
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const loadVerification: VerificationEvidence = {
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
    }
    let verifyHostCalls = 0
    const launcher = {
      install: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, truncated: false }),
      profileSourceMatches: async () => true,
      readInstalledVerificationFixtures: async () => ({}),
      verifyHost: async () => {
        verifyHostCalls += 1
        return loadVerification
      },
      verify: async () => { throw new Error('LLM verify must not drive mechanical verification') },
    } as unknown as DshLauncher
    const installer = new PluginInstaller(ctx, config(root), store, launcher, async () => true)
    const result = await installer.install({
      reviewId: `review_${'a'.repeat(64)}`,
      targetProfile: 'web',
      retention: 'persistent',
    }, execution())
    expect(verifyHostCalls).toBe(1)
    expect(result).toMatchObject({
      installOutcome: 'activated',
      installed: true,
      loaded: true,
      verified: false,
      removed: false,
      verification: { layer: 'bundle_activation', status: 'passed' },
    })
    expect(result.verification.task).toBeUndefined()
  })

  it('marks a persistent install outcome unknown when reconciliation also fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'capability-evolution-install-'))
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
      reviewId: `review_${'a'.repeat(64)}`,
      targetProfile: 'persistent',
      retention: 'persistent',
      verificationTask: 'test calculator',
    }, execution())

    expect(result).toMatchObject({
      installState: 'unknown',
      installOutcome: 'recovery_required',
      installed: false,
      verified: false,
      removed: false,
    })
    expect(result.verification.reason).toContain('recovery is required')
  })

  it('does not spawn Host verification for persistent manual_runtime and records awaiting_user_test', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'capability-evolution-install-'))
    temporary.push(root)
    const store = new StateStore(root)
    await store.put('reviews', review())
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    let verifyHostCalls = 0
    const launcher = {
      install: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
      profileSourceMatches: async () => true,
      readInstalledVerificationFixtures: async () => ({ calculator: { safe: true } }),
      verifyHost: async () => {
        verifyHostCalls += 1
        throw new Error('manual_runtime must not spawn')
      },
      verify: async () => { throw new Error('LLM verify must not drive mechanical verification') },
    } as unknown as DshLauncher
    const installer = new PluginInstaller(ctx, config(root), store, launcher, async () => true)

    const result = await installer.install({
      reviewId: `review_${'a'.repeat(64)}`,
      targetProfile: 'persistent',
      retention: 'persistent',
      verificationTask: 'calculate 6 * 7',
      verificationExpectedText: '42',
    }, execution())

    expect(verifyHostCalls).toBe(0)
    expect(result).toMatchObject({
      installOutcome: 'awaiting_user_test',
      installed: true,
      loaded: true,
      verified: false,
      removed: false,
      verification: { layer: 'manual_runtime', status: 'pending_user_test' },
    })
    expect(JSON.stringify(result.verification)).not.toContain('calculate 6 * 7')
  })

  it('rejects a temporary manual_runtime install before approval, materialize, install, or receipt', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'capability-evolution-manual-temp-'))
    temporary.push(root)
    class CountingStore extends StateStore {
      installationWrites = 0

      override async put(...args: Parameters<StateStore['put']>): Promise<void> {
        if (args[0] === 'installations') this.installationWrites += 1
        await super.put(...args)
      }
    }
    const store = new CountingStore(root)
    await store.put('reviews', review({
      runtimeSurface: {
        llmDependency: false,
        llmRegistered: false,
        credentialsDependency: false,
        credentialsRegistered: false,
        networkSignal: false,
        environmentSignal: false,
        processSignal: false,
        skillOnly: false,
        unsafeTools: false,
        expectedTools: ['calculator'],
        toolFixtures: [{ tool: 'calculator', available: true, safe: false, hostValidated: false }],
        kind: 'bundle',
        verificationLayer: 'manual_runtime',
      },
    }))
    let approvals = 0
    const ctx = { get: () => ({ request: async () => { approvals += 1; return 'allowed-once' } }) } as unknown as Context
    let installs = 0
    let materializes = 0
    let verifyHostCalls = 0
    const launcher = {
      materializeLocal: async () => { materializes += 1; throw new Error('must not materialize') },
      install: async () => { installs += 1; throw new Error('must not install') },
      verifyHost: async () => { verifyHostCalls += 1; throw new Error('must not verify') },
    } as unknown as DshLauncher
    const installer = new PluginInstaller(ctx, config(root), store, launcher, async () => true)

    await expect(installer.install({
      reviewId: `review_${'a'.repeat(64)}`,
      targetProfile: 'trial',
      retention: 'temporary',
    }, execution())).rejects.toSatisfy((error: unknown) => {
      expect(error).toMatchObject({ code: 'invalid_input' })
      expect((error as Error).message).toMatch(/reconfirm persistent/i)
      return true
    })
    expect(approvals).toBe(0)
    expect(installs).toBe(0)
    expect(materializes).toBe(0)
    expect(verifyHostCalls).toBe(0)
    expect(store.installationWrites).toBe(0)
  })

  it('removes a temporary trial that degrades from Host-attested automatic verification to manual_runtime', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'capability-evolution-degraded-temp-'))
    temporary.push(root)
    const store = new StateStore(root)
    await store.put('reviews', attestedReview())
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    let verifyHostCalls = 0
    const launcher = {
      install: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
      profileSourceMatches: async () => true,
      readInstalledVerificationFixtures: async () => ({ calculator: { safe: true } }),
      verifyHost: async () => {
        verifyHostCalls += 1
        throw new Error('degraded automatic verification must not spawn')
      },
    } as unknown as DshLauncher
    const installer = new PluginInstaller(ctx, config(root), store, launcher, async () => true)
    const result = await installer.install({
      reviewId: `review_${'a'.repeat(64)}`,
      targetProfile: 'trial',
      retention: 'temporary',
    }, execution())
    expect(verifyHostCalls).toBe(0)
    expect(result).toMatchObject({
      installOutcome: 'failed_absent',
      installed: false,
      loaded: false,
      verified: false,
      removed: true,
      verification: { layer: 'manual_runtime', status: 'failed' },
    })
    expect(result.installOutcome).not.toBe('awaiting_user_test')
    await expect(stat(store.trialRoot(result.id))).rejects.toMatchObject({ code: 'ENOENT' })
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
    await store.put('reviews', attestedReview())
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const launcher = {
      install: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
      profileSourceMatches: async () => true,
      readInstalledVerificationFixtures: async () => ({ calculator: { arguments: { expression: '1+1' } } }),
      verifyHost: async (): Promise<VerificationEvidence> => ({
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
      }),
      verify: async () => { throw new Error('LLM verify must not drive mechanical verification') },
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
      expect(error).toMatchObject({ code: 'command_failed', details: { recoveryRequired: true } })
    }
    expect(installationId).toMatch(/^installation_[a-f0-9]{24}$/u)
    await expect(store.getInstallation(installationId)).resolves.toMatchObject({ removed: true })
    await expect(stat(store.trialRoot(installationId))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('returns a removable receipt when persistent verification is interrupted', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'capability-evolution-install-'))
    temporary.push(root)
    const store = new StateStore(root)
    await store.put('reviews', attestedReview())
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const launcher = {
      install: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
      profileSourceMatches: async () => true,
      readInstalledVerificationFixtures: async () => ({ calculator: { arguments: { expression: '1+1' } } }),
      verifyHost: async () => { throw new Error('simulated verification interruption') },
      verify: async () => { throw new Error('LLM verify must not drive mechanical verification') },
    } as unknown as DshLauncher
    const installer = new PluginInstaller(ctx, config(root), store, launcher, async () => true)

    const result = await installer.install({
      reviewId: `review_${'a'.repeat(64)}`,
      targetProfile: 'persistent-profile',
      retention: 'persistent',
      verificationTask: 'test calculator',
    }, execution())

    expect(result).toMatchObject({
      installOutcome: 'recovery_required',
      installed: false,
      loaded: false,
      verified: false,
      removed: false,
      restartRequired: false,
    })
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

  it('does not mark a persistent installation removed when one-time approval is denied', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'capability-evolution-remove-denied-'))
    temporary.push(root)
    const store = new StateStore(root)
    const installationId = `installation_${'e'.repeat(24)}`
    await store.put('installations', {
      schemaVersion: 1,
      id: installationId,
      createdAt: '2026-08-15T00:00:00.000Z',
      reviewId: `review_${'a'.repeat(64)}`,
      workflowId: `workflow_${'d'.repeat(24)}`,
      targetProfile: 'persistent',
      retention: 'persistent',
      dshHome: path.join(root, 'dsh-home'),
      packageName: 'dsh-tool-calculator',
      installSpec: `github:acme/calculator#${'c'.repeat(40)}`,
      installed: true,
      loaded: true,
      verified: false,
      restartRequired: false,
      removed: false,
      verification: {
        attempted: true,
        expectedTools: ['calculator'],
        calledTools: [],
        resultTools: [],
        failedTools: [],
        sessionFiles: [],
        taskResultObserved: false,
        reason: 'awaiting user test',
      },
    })
    const ctx = { get: () => ({ request: async () => 'denied' }) } as unknown as Context
    let removalCalled = false
    const launcher = {
      remove: async () => { removalCalled = true; return { exitCode: 0, signal: null, stdout: '', stderr: '' } },
      hasProfileDependency: async () => true,
    } as unknown as DshLauncher
    const remover = new PluginRemover(ctx, config(root), store, launcher)

    await expect(remover.remove({ installationId }, execution())).rejects.toMatchObject({ code: 'approval_required' })
    expect(removalCalled).toBe(false)
    await expect(store.getInstallation(installationId)).resolves.toMatchObject({ removed: false, id: installationId })
  })

  it('calls Host tool_roundtrip once and keeps the receipt free of args, output, env, and paths', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'capability-evolution-install-'))
    temporary.push(root)
    const store = new StateStore(root)
    await store.put('reviews', attestedReview())
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    let verifyHostCalls = 0
    const verifyHostArgs: unknown[] = []
    const launcher = {
      install: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
      profileSourceMatches: async () => true,
      readInstalledVerificationFixtures: async () => ({ calculator: { arguments: { expression: '1+1' }, safe: true } }),
      verifyHost: async (input: unknown) => {
        verifyHostCalls += 1
        verifyHostArgs.push(input)
        return {
          attempted: true,
          exitCode: 0,
          expectedTools: ['calculator'],
          calledTools: ['calculator'],
          resultTools: ['calculator'],
          failedTools: [],
          sessionFiles: [],
          taskResultObserved: false,
          layer: 'tool_roundtrip' as const,
          status: 'passed' as const,
          sourceMatched: true,
          fixtureDigest: 'a'.repeat(64),
          reason: 'Host executed 1 expected tool(s) once through ToolRuntime.execute.',
        }
      },
      verify: async () => { throw new Error('LLM verify must not drive mechanical verification') },
    } as unknown as DshLauncher
    const installer = new PluginInstaller(ctx, config(root), store, launcher, async () => true)
    const result = await installer.install({
      reviewId: `review_${'a'.repeat(64)}`,
      targetProfile: 'web',
      retention: 'persistent',
      verificationTask: 'calculate 6 * 7 with /Users/secret/path',
    }, execution())
    expect(verifyHostCalls).toBe(1)
    expect(JSON.stringify(verifyHostArgs)).not.toContain('calculate 6 * 7')
    expect(JSON.stringify(verifyHostArgs)).not.toContain('verificationTask')
    expect(JSON.stringify(verifyHostArgs)).not.toContain('verificationExpectedText')
    expect(result).toMatchObject({
      installOutcome: 'verified',
      verified: true,
      verification: { layer: 'tool_roundtrip', status: 'passed' },
    })
    const serialized = JSON.stringify(result.verification)
    expect(serialized).not.toContain('1+1')
    expect(serialized).not.toContain('expression')
    expect(serialized).not.toContain('/Users/secret/path')
    expect(serialized).not.toContain('calculate 6 * 7')
    expect(result.verification.sessionFiles).toEqual([])
    expect(result.verification.receiptPath).toBeUndefined()
    expect(result.verification.task).toBeUndefined()
  })

  it('ignores expectedRoute and never spawns when the frozen surface requires a user test', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'capability-evolution-install-'))
    temporary.push(root)
    const store = new StateStore(root)
    await store.put('reviews', review({
      manifest: {
        ...review().manifest,
        expectedRoute: { provider: 'xai-oauth', model: 'grok-4.5' },
      },
      runtimeSurface: {
        llmDependency: false,
        llmRegistered: true,
        credentialsDependency: false,
        credentialsRegistered: false,
        networkSignal: false,
        environmentSignal: false,
        processSignal: false,
        skillOnly: false,
        unsafeTools: false,
        expectedTools: ['calculator'],
        toolFixtures: [{ tool: 'calculator', available: true, safe: false, hostValidated: false }],
        expectedRoute: { provider: 'xai-oauth', model: 'grok-4.5' },
        kind: 'bundle',
        verificationLayer: 'manual_runtime',
      },
    }))
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    let verifyHostCalls = 0
    const launcher = {
      install: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
      profileSourceMatches: async () => true,
      readInstalledVerificationFixtures: async () => ({ calculator: { arguments: { expression: '1+1' } } }),
      verifyHost: async () => {
        verifyHostCalls += 1
        throw new Error('expectedRoute must not spawn Host verification')
      },
    } as unknown as DshLauncher
    const installer = new PluginInstaller(ctx, config(root), store, launcher, async () => true)
    const result = await installer.install({
      reviewId: `review_${'a'.repeat(64)}`,
      targetProfile: 'persistent',
      retention: 'persistent',
      verificationTask: 'answer with Grok',
    }, execution())
    expect(verifyHostCalls).toBe(0)
    expect(result).toMatchObject({
      installOutcome: 'awaiting_user_test',
      verified: false,
      installed: true,
      verification: { layer: 'manual_runtime', status: 'pending_user_test' },
    })
  })

  it('maps rollbackFailed to recovery_required for activated and awaiting_user_test', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'capability-evolution-rollback-nonfailure-'))
    temporary.push(root)
    const store = new StateStore(root)
    const none = review({
      manifest: {
        kind: 'bundle',
        packageName: 'dsh-subscription-auth',
        bundlePatch: './cordis.patch.yml',
        scripts: [],
        dependencies: [],
        peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.1.0-rc.6 <0.2.0' },
        expectedTools: [],
      },
      runtimeSurface: {
        llmDependency: false,
        llmRegistered: false,
        credentialsDependency: false,
        credentialsRegistered: false,
        networkSignal: false,
        environmentSignal: false,
        processSignal: false,
        skillOnly: false,
        unsafeTools: false,
        expectedTools: [],
        toolFixtures: [],
        kind: 'bundle',
        verificationLayer: 'bundle_activation',
      },
    })
    await store.put('reviews', none)
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const launcher = {
      install: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, truncated: false }),
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
      ctx, config(root), store, launcher, async () => true, undefined, async () => ({
        evidence: { attempted: true, loaded: false, method: 'failed', reason: 'activation and rollback failed' },
        rollbackFailed: true,
      }),
    ).install({
      reviewId: none.id,
      targetProfile: 'web',
      retention: 'persistent',
    }, execution())
    expect(activated).toMatchObject({
      installOutcome: 'recovery_required',
      installed: false,
      verified: false,
      restartRequired: false,
    })
    expect(activated.verification.reason).toMatch(/explicit recovery/i)

    await store.put('reviews', review())
    const awaiting = await new PluginInstaller(
      ctx, config(root), store, launcher, async () => true, undefined, async () => ({
        evidence: { attempted: true, loaded: false, method: 'failed', reason: 'activation and rollback failed' },
        rollbackFailed: true,
      }),
    ).install({
      reviewId: review().id,
      targetProfile: 'web',
      retention: 'persistent',
    }, execution())
    expect(awaiting).toMatchObject({
      installOutcome: 'recovery_required',
      installed: false,
      verified: false,
      restartRequired: false,
      verification: { layer: 'manual_runtime' },
    })
    expect(awaiting.verification.reason).toMatch(/explicit recovery/i)
  })
})
