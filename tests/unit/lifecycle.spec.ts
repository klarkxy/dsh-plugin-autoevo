import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { testReview } from '../helpers/records.js'
import { testRuntimeConfig } from '../helpers/runtime-config.js'
import { trackTempDirs } from '../helpers/temp-dirs.js'
import type { RuntimeConfig } from '../../src/config.js'
import { POLICY_VERSION, type InstallationRecord, type ReviewRecord, type VerificationEvidence } from '../../src/contracts.js'
import { EvolutionError } from '../../src/errors.js'
import { PluginInstaller, _testing as installTesting } from '../../src/lifecycle/install.js'
import { builtinReceiptSpec } from '../../src/lifecycle/enable-builtin.js'
import { DshLauncher } from '../../src/lifecycle/launcher.js'
import { PluginRemover } from '../../src/lifecycle/remove.js'
import { dependencySpecDigest } from '../../src/resolver/installed-origin.js'
import { StateStore } from '../../src/state/store.js'
import { sha256 } from '../../src/state/hashes.js'
import { _testing as packageArtifactTesting } from '../../src/lifecycle/package-artifact.js'

const temporary = trackTempDirs()

function review(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return testReview({
    securityRisk: 'medium',
    manifest: {
      kind: 'bundle', packageName: 'dsh-tool-calculator', bundlePatch: './cordis.patch.yml', scripts: ['prepare'], dependencies: [],
      peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.1.0-rc.6 <0.2.0' }, expectedTools: ['calculator'],
    },
    findings: [{ code: 'lifecycle_script', severity: 'info', source: 'package.json', detail: 'declares lifecycle script: prepare' }],
    ...overrides,
  })
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
  return testRuntimeConfig(root, { dshHome: path.join(root, 'persistent-dsh-home'), evolutionPreset: true })
}

function execution(signal?: AbortSignal): ToolRunContext {
  return {
    callId: 'call-1',
    agent: { session: { header: { cwd: process.cwd() } } },
    ...(signal ? { signal } : {}),
  } as unknown as ToolRunContext
}

function removalRecord(root: string, id: string, installSpec: string): InstallationRecord {
  return {
    schemaVersion: 1,
    id,
    createdAt: '2026-08-31T00:00:00.000Z',
    targetProfile: 'persistent',
    retention: 'persistent',
    dshHome: config(root).dshHome,
    packageName: 'dsh-tool-calculator',
    installSpec,
    installPhase: 'completed',
    installState: 'installed',
    installOutcome: 'verified',
    installed: true,
    loaded: true,
    verified: true,
    restartRequired: false,
    removed: false,
    verification: {
      attempted: true,
      expectedTools: ['calculator'],
      calledTools: ['calculator'],
      resultTools: ['calculator'],
      failedTools: [],
      sessionFiles: [],
      taskResultObserved: true,
      reason: 'verified',
    },
  }
}

function replacementRemovalRecord(
  parent: InstallationRecord,
  id: string,
  installSpec: string,
  createdAt: string,
): InstallationRecord {
  return {
    ...removalRecord(path.dirname(path.dirname(parent.dshHome)), id, installSpec),
    dshHome: parent.dshHome,
    targetProfile: parent.targetProfile,
    packageName: parent.packageName,
    createdAt,
    installPhase: 'completed',
    predecessorInstallationId: parent.id,
    replacement: {
      state: 'new_present',
      oldSpecDigest: dependencySpecDigest(parent.installSpec),
      newInstallSpec: installSpec,
      preparedAt: createdAt,
      reconciledAt: createdAt,
    },
  }
}

async function installHarness(record: ReviewRecord): Promise<{ root: string, store: StateStore, ctx: Context }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'capability-evolution-install-'))
  temporary.push(root)
  const store = new StateStore(root)
  await putFrozenReview(root, store, record)
  const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
  return { root, store, ctx }
}

async function putFrozenReview(root: string, store: StateStore, record: ReviewRecord): Promise<void> {
  const artifactRoot = path.join(root, 'review-artifacts', record.id)
  const artifactPath = path.join(artifactRoot, 'package', 'reviewed.tgz')
  const bytes = Buffer.from(`artifact:${record.id}`)
  await mkdir(path.dirname(artifactPath), { recursive: true })
  await writeFile(artifactPath, bytes)
  await store.put('reviews', {
    ...record,
    installSpec: `file:${artifactPath.replaceAll('\\', '/')}`,
    artifact: { sha256: sha256(bytes), bytes: bytes.byteLength, entryCount: record.inspectedFiles.length, ownedRoot: artifactRoot },
  })
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
    expect(() => packageArtifactTesting.shellForwardedFileSpec('C:\\safe&unsafe\\plugin.tgz')).toThrow(/unsafe/u)
    expect(packageArtifactTesting.shellForwardedFileSpec('C:\\safe path\\plugin.tgz')).toMatch(/^file:/u)
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

  it('makes no installation change when one-time approval is denied', async () => {
    const { root, store } = await installHarness(attestedReview())
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

  it('persists the host-prelinked receipt before the external install command starts', async () => {
    const { root, store, ctx } = await installHarness(attestedReview())
    const installationId = `installation_${'9'.repeat(24)}`
    let observedPhase: string | undefined
    const launcher = {
      install: async () => {
        observedPhase = (await store.getInstallation(installationId)).installPhase
        throw new EvolutionError('command_failed', 'dsh install failed', {
          exitCode: 1,
          diagnosticHash: '8'.repeat(64),
        })
      },
    } as unknown as DshLauncher
    const installer = new PluginInstaller(ctx, config(root), store, launcher, async () => true)

    const result = await installer.install({
      installationId,
      reviewId: `review_${'a'.repeat(64)}`,
      targetProfile: 'trial',
      retention: 'temporary',
    }, execution())

    // Every destination effect, including a temporary trial without preflight,
    // is now preceded by the durable destination_installing journal.
    expect(observedPhase).toBe('destination_installing')
    expect(result).toMatchObject({
      id: installationId,
      installFailure: {
        stage: 'install',
        code: 'command_failed',
        retryable: true,
        summary: 'dsh install failed',
        repairHints: expect.arrayContaining([expect.stringMatching(/resume the workflow/i)]),
      },
    })
  })

  it('uses a provisional receipt to recover from final receipt persistence failure', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'capability-evolution-install-'))
    temporary.push(root)
    class FailingFinalStore extends StateStore {
      installationWrites = 0

      override async put(...args: Parameters<StateStore['put']>): Promise<void> {
        if (args[0] === 'installations') {
          this.installationWrites += 1
          // prepared -> destination_installing -> completed
          if (this.installationWrites === 3) throw new Error('simulated final receipt failure')
        }
        await super.put(...args)
      }
    }
    const store = new FailingFinalStore(root)
    await putFrozenReview(root, store, attestedReview())
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const launcher = {
      install: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
      profileTargetAbsent: async () => true,
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
    const { root, store, ctx } = await installHarness(attestedReview())
    const launcher = {
      install: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
      profileTargetAbsent: async () => true,
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

  it('rejects a legacy removed receipt whose exact persistent dependency is still live', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'capability-evolution-remove-live-legacy-'))
    temporary.push(root)
    const store = new StateStore(root)
    const installationId = `installation_${'b'.repeat(24)}`
    const installSpec = `github:acme/calculator#${'c'.repeat(40)}`
    await store.put('installations', { ...removalRecord(root, installationId, installSpec), removed: true })
    const approval = vi.fn(async () => 'allowed-once')
    const launcher = {
      profileDependencySpec: vi.fn(async () => installSpec),
      remove: vi.fn(async () => ({ exitCode: 0 })),
    } as unknown as DshLauncher
    const put = vi.spyOn(store, 'put')
    put.mockClear()

    await expect(new PluginRemover(
      { get: () => ({ request: approval }) } as unknown as Context,
      config(root),
      store,
      launcher,
    ).remove({ installationId }, execution())).rejects.toMatchObject({ code: 'invalid_input' })
    expect(launcher.profileDependencySpec).toHaveBeenCalledTimes(1)
    expect(approval).not.toHaveBeenCalled()
    expect(launcher.remove).not.toHaveBeenCalled()
    expect(put).not.toHaveBeenCalled()
  })

  it('normalizes a legacy removed receipt only after persistent absence is proven', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'capability-evolution-remove-legacy-'))
    temporary.push(root)
    const store = new StateStore(root)
    const installationId = `installation_${'6'.repeat(24)}`
    await store.put('installations', {
      ...removalRecord(root, installationId, `github:acme/calculator#${'c'.repeat(40)}`),
      removed: true,
    })
    const approval = vi.fn(async () => 'allowed-once')
    const launcher = {
      profileDependencySpec: vi.fn(async () => undefined),
      remove: vi.fn(async () => ({ exitCode: 0 })),
    } as unknown as DshLauncher

    await expect(new PluginRemover(
      { get: () => ({ request: approval }) } as unknown as Context,
      config(root),
      store,
      launcher,
    ).remove({ installationId }, execution())).resolves.toMatchObject({ removed: true })
    expect(approval).not.toHaveBeenCalled()
    expect(launcher.remove).not.toHaveBeenCalled()
    await expect(store.listInstallationsStrict()).resolves.toEqual([
      expect.objectContaining({
        id: installationId,
        removed: true,
        installed: false,
        verified: false,
        restartRequired: true,
      }),
    ])
  })

  it('cleans an owned failed_absent artifact without removing a profile dependency', async () => {
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
      dshHome: config(root).dshHome,
      packageName: 'dsh-tool-calculator',
      installSpec: `file:${path.join(artifactRoot, 'plugin.tgz').replaceAll('\\', '/')}`,
      ownedArtifactRoot: artifactRoot,
      artifactSha256: 'e'.repeat(64),
      installPhase: 'completed',
      installState: 'not_installed',
      installOutcome: 'failed_absent',
      installed: false,
      loaded: false,
      verified: false,
      restartRequired: false,
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
      profileDependencySpec: async () => `github:acme/replacement#${'9'.repeat(40)}`,
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
      dshHome: config(root).dshHome,
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
      dshHome: config(root).dshHome,
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
      profileDependencySpec: async () => `github:acme/calculator#${'c'.repeat(40)}`,
    } as unknown as DshLauncher
    const remover = new PluginRemover(ctx, config(root), store, launcher)

    await expect(remover.remove({ installationId }, execution())).rejects.toMatchObject({ code: 'approval_required' })
    expect(removalCalled).toBe(false)
    await expect(store.getInstallation(installationId)).resolves.toMatchObject({ removed: false, id: installationId })
  })

  it('preserves exact cancellation and starts no remove effect when approval ignores its signal', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'capability-evolution-remove-approval-abort-'))
    temporary.push(root)
    const store = new StateStore(root)
    const installationId = `installation_${'8'.repeat(24)}`
    const installSpec = `github:acme/calculator#${'8'.repeat(40)}`
    await store.put('installations', removalRecord(root, installationId, installSpec))
    const controller = new AbortController()
    const reason = new Error('remove approval cancelled')
    const remove = vi.fn()
    const ctx = {
      get: () => ({
        request: async () => {
          controller.abort(reason)
          return 'allowed-once'
        },
      }),
    } as unknown as Context
    const launcher = {
      profileDependencySpec: async () => installSpec,
      remove,
    } as unknown as DshLauncher

    await expect(new PluginRemover(ctx, config(root), store, launcher)
      .remove({ installationId }, execution(controller.signal))).rejects.toBe(reason)
    expect(remove).not.toHaveBeenCalled()
    await expect(store.getInstallation(installationId)).resolves.toMatchObject({ removed: false })
  })

  it('persists confirmed absence after a remove effect observes cancellation, then throws the exact reason', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'capability-evolution-remove-effect-abort-'))
    temporary.push(root)
    const store = new StateStore(root)
    const installationId = `installation_${'9'.repeat(24)}`
    const installSpec = `github:acme/calculator#${'9'.repeat(40)}`
    await store.put('installations', removalRecord(root, installationId, installSpec))
    const controller = new AbortController()
    const reason = new Error('remove effect cancelled')
    const profileDependencySpec = vi.fn()
      .mockResolvedValueOnce(installSpec)
      .mockResolvedValueOnce(installSpec)
      .mockResolvedValueOnce(undefined)
    const remove = vi.fn(async () => {
      controller.abort(reason)
      return { exitCode: 0, signal: null, stdout: '', stderr: '' }
    })
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context

    await expect(new PluginRemover(ctx, config(root), store, {
      profileDependencySpec,
      remove,
    } as unknown as DshLauncher).remove({ installationId }, execution(controller.signal))).rejects.toBe(reason)
    expect(remove).toHaveBeenCalledTimes(1)
    expect(profileDependencySpec).toHaveBeenCalledTimes(3)
    await expect(store.getInstallation(installationId)).resolves.toMatchObject({ removed: true })
  })

  it('prioritizes recovery when cancelled removal state cannot be persisted', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'capability-evolution-remove-persist-abort-'))
    temporary.push(root)
    const store = new StateStore(root)
    const installationId = `installation_${'a'.repeat(24)}`
    const installSpec = `github:acme/calculator#${'a'.repeat(40)}`
    await store.put('installations', removalRecord(root, installationId, installSpec))
    const originalPut = store.put.bind(store)
    vi.spyOn(store, 'put').mockImplementation(async (kind, record) => {
      if (kind === 'installations') throw new Error('remove settlement persistence failed')
      return originalPut(kind, record)
    })
    const controller = new AbortController()
    const reason = new Error('remove persistence cancelled')
    const profileDependencySpec = vi.fn()
      .mockResolvedValueOnce(installSpec)
      .mockResolvedValueOnce(installSpec)
      .mockResolvedValueOnce(undefined)
    const remove = vi.fn(async () => {
      controller.abort(reason)
      return { exitCode: 0, signal: null, stdout: '', stderr: '' }
    })
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const operation = new PluginRemover(ctx, config(root), store, {
      profileDependencySpec,
      remove,
    } as unknown as DshLauncher).remove({ installationId }, execution(controller.signal))

    await expect(operation).rejects.toMatchObject({
      code: 'command_failed',
      details: { installationId, recoveryRequired: true, stage: 'remove' },
    })
    await expect(operation).rejects.not.toBe(reason)
    await expect(store.getInstallation(installationId)).resolves.toMatchObject({ removed: false })
  })

  it('refuses a stale persistent receipt when the exact live dependency spec changed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'capability-evolution-remove-stale-'))
    temporary.push(root)
    const store = new StateStore(root)
    const installationId = `installation_${'7'.repeat(24)}`
    const oldSpec = `github:acme/calculator#${'a'.repeat(40)}`
    const newSpec = `github:acme/calculator#${'b'.repeat(40)}`
    await store.put('installations', {
      schemaVersion: 1,
      id: installationId,
      createdAt: '2026-08-26T00:00:00.000Z',
      targetProfile: 'persistent',
      retention: 'persistent',
      dshHome: config(root).dshHome,
      packageName: 'dsh-tool-calculator',
      installSpec: oldSpec,
      installed: true,
      loaded: true,
      verified: true,
      restartRequired: false,
      removed: false,
      verification: {
        attempted: true,
        expectedTools: ['calculator'],
        calledTools: ['calculator'],
        resultTools: ['calculator'],
        failedTools: [],
        sessionFiles: [],
        taskResultObserved: true,
        reason: 'verified',
      },
    })
    let approvalRequested = false
    let removalCalled = false
    const ctx = { get: () => ({ request: async () => { approvalRequested = true; return 'allowed-once' } }) } as unknown as Context
    const launcher = {
      profileDependencySpec: async () => newSpec,
      remove: async () => { removalCalled = true; return { exitCode: 0, signal: null, stdout: '', stderr: '' } },
    } as unknown as DshLauncher

    await expect(new PluginRemover(ctx, config(root), store, launcher)
      .remove({ installationId }, execution())).rejects.toMatchObject({ code: 'review_expired' })
    expect(approvalRequested).toBe(false)
    expect(removalCalled).toBe(false)
    await expect(store.getInstallation(installationId)).resolves.toMatchObject({ removed: false, installSpec: oldSpec })
  })

  it('rejects stale A but removes canonical C in an A(S)-B(T)-C(S) chain', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'capability-evolution-remove-lineage-'))
    temporary.push(root)
    const store = new StateStore(root)
    const specS = `github:acme/calculator#${'a'.repeat(40)}`
    const specT = `github:acme/calculator#${'b'.repeat(40)}`
    const first = { ...removalRecord(root, `installation_${'1'.repeat(24)}`, specS), installPhase: 'completed' as const }
    const second = replacementRemovalRecord(first, `installation_${'2'.repeat(24)}`, specT, '2026-08-31T00:01:00.000Z')
    const third = replacementRemovalRecord(second, `installation_${'3'.repeat(24)}`, specS, '2026-08-31T00:02:00.000Z')
    for (const item of [first, second, third]) await store.put('installations', item)
    const approval = vi.fn(async () => 'allowed-once')
    const remove = vi.fn(async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }))
    const profileDependencySpec = vi.fn()
      .mockResolvedValueOnce(specS)
      .mockResolvedValueOnce(specS)
      .mockResolvedValueOnce(specS)
      .mockResolvedValueOnce(undefined)
    const remover = new PluginRemover(
      { get: () => ({ request: approval }) } as unknown as Context,
      config(root),
      store,
      { profileDependencySpec, remove } as unknown as DshLauncher,
    )

    await expect(remover.remove({ installationId: first.id }, execution()))
      .rejects.toThrow(/not the unique canonical live receipt/i)
    expect(approval).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()

    await expect(remover.remove({ installationId: third.id }, execution()))
      .resolves.toMatchObject({ removed: true })
    expect(approval).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledTimes(1)
  })

  it('blocks a newly committed child after removal approval and before effect', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'capability-evolution-remove-postapproval-child-'))
    temporary.push(root)
    const store = new StateStore(root)
    const oldSpec = `github:acme/calculator#${'a'.repeat(40)}`
    const newSpec = `github:acme/calculator#${'b'.repeat(40)}`
    const parent = { ...removalRecord(root, `installation_${'4'.repeat(24)}`, oldSpec), installPhase: 'completed' as const }
    const child = replacementRemovalRecord(parent, `installation_${'5'.repeat(24)}`, newSpec, '2026-08-31T00:03:00.000Z')
    await store.put('installations', parent)
    const approval = vi.fn(async () => {
      await store.put('installations', child)
      return 'allowed-once'
    })
    const remove = vi.fn()
    const profileDependencySpec = vi.fn().mockResolvedValueOnce(oldSpec).mockResolvedValueOnce(newSpec)
    const remover = new PluginRemover(
      { get: () => ({ request: approval }) } as unknown as Context,
      config(root),
      store,
      { profileDependencySpec, remove } as unknown as DshLauncher,
    )

    await expect(remover.remove({ installationId: parent.id }, execution()))
      .rejects.toThrow(/not the unique canonical live receipt/i)
    expect(approval).toHaveBeenCalledTimes(1)
    expect(remove).not.toHaveBeenCalled()
    await expect(store.getInstallation(parent.id)).resolves.toMatchObject({ removed: false })
    await expect(store.getInstallation(child.id)).resolves.toMatchObject({ removed: false })
  })

  it('rejects removal before approval when a corrupt canonical same-spec child is skipped by tolerant reads', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'capability-evolution-remove-corrupt-child-'))
    temporary.push(root)
    const store = new StateStore(root)
    const spec = `github:acme/calculator#${'a'.repeat(40)}`
    const parent = { ...removalRecord(root, `installation_${'9'.repeat(24)}`, spec), installPhase: 'completed' as const }
    await store.put('installations', parent)
    const corruptChildId = `installation_${'a'.repeat(24)}`
    await writeFile(path.join(store.root, 'installations', `${corruptChildId}.json`), JSON.stringify({
      schemaVersion: 1,
      id: corruptChildId,
      createdAt: '2026-08-31T00:00:00.000Z',
      targetProfile: parent.targetProfile,
      retention: parent.retention,
      dshHome: parent.dshHome,
      packageName: parent.packageName,
      predecessorInstallationId: parent.id,
      installSpec: spec,
    }), 'utf8')
    const approval = vi.fn()
    const live = vi.fn(async () => spec)
    const remove = vi.fn()
    const remover = new PluginRemover(
      { get: () => ({ request: approval }) } as unknown as Context,
      config(root),
      store,
      { profileDependencySpec: live, remove } as unknown as DshLauncher,
    )

    await expect(remover.remove({ installationId: parent.id }, execution())).rejects.toMatchObject({
      code: 'invalid_input',
      details: { diagnosticCount: 1 },
    })
    expect(live).not.toHaveBeenCalled()
    expect(approval).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
  })

  it('removes an exact AutoEvo-owned built-in mount from its receipt', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'capability-evolution-remove-builtin-'))
    temporary.push(root)
    const store = new StateStore(root)
    const installationId = `installation_${'6'.repeat(24)}`
    const patchRoot = path.join(config(root).dshHome, 'profiles', 'persistent')
    await mkdir(patchRoot, { recursive: true })
    const patchPath = path.join(patchRoot, 'cordis.patch.yml')
    await writeFile(patchPath, "- insert:\n    - id: time-context\n      name: '@deepseek-ai/dsh-time-context'\n")
    await store.put('installations', {
      schemaVersion: 1,
      id: installationId,
      createdAt: '2026-08-26T00:00:00.000Z',
      targetProfile: 'persistent',
      retention: 'persistent',
      dshHome: config(root).dshHome,
      packageName: '@deepseek-ai/dsh-time-context',
      installSpec: builtinReceiptSpec({ version: '0.1.1-rc.2', mountId: 'time-context', wrote: true }),
      installed: true,
      loaded: false,
      verified: false,
      restartRequired: true,
      removed: false,
      verification: {
        attempted: false,
        expectedTools: [],
        calledTools: [],
        resultTools: [],
        failedTools: [],
        sessionFiles: [],
        taskResultObserved: false,
        reason: 'built-in composition validated',
      },
    })
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const launcher = {
      dumpConfig: async () => ({ exitCode: 0, signal: null, stdout: '[]\n', stderr: '' }),
    } as unknown as DshLauncher

    await expect(new PluginRemover(ctx, config(root), store, launcher)
      .remove({ installationId }, execution())).resolves.toMatchObject({ removed: true, restartRequired: true })
    expect(await readFile(patchPath, 'utf8')).not.toContain('time-context')
    await expect(store.getInstallation(installationId)).resolves.toMatchObject({ removed: true })
  })

  it('retries built-in removal after the composition check throws post-write', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'capability-evolution-remove-builtin-retry-'))
    temporary.push(root)
    const store = new StateStore(root)
    const installationId = `installation_${'7'.repeat(24)}`
    const patchRoot = path.join(config(root).dshHome, 'profiles', 'persistent')
    await mkdir(patchRoot, { recursive: true })
    const patchPath = path.join(patchRoot, 'cordis.patch.yml')
    await writeFile(patchPath, "- insert:\n    - id: time-context\n      name: '@deepseek-ai/dsh-time-context'\n")
    await store.put('installations', {
      schemaVersion: 1,
      id: installationId,
      createdAt: '2026-08-26T00:00:00.000Z',
      targetProfile: 'persistent',
      retention: 'persistent',
      dshHome: config(root).dshHome,
      packageName: '@deepseek-ai/dsh-time-context',
      installSpec: builtinReceiptSpec({ version: '0.1.1-rc.2', mountId: 'time-context', wrote: true }),
      installed: true,
      loaded: false,
      verified: false,
      restartRequired: true,
      removed: false,
      verification: {
        attempted: false,
        expectedTools: [],
        calledTools: [],
        resultTools: [],
        failedTools: [],
        sessionFiles: [],
        taskResultObserved: false,
        reason: 'built-in composition validated',
      },
    })
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const dumpConfig = vi.fn(async () => { throw new Error('aborted after profile write') })
    const remover = new PluginRemover(ctx, config(root), store, { dumpConfig } as unknown as DshLauncher)

    await expect(remover.remove({ installationId }, execution())).rejects.toThrow('aborted after profile write')
    expect(await readFile(patchPath, 'utf8')).not.toContain('time-context')
    await expect(store.getInstallation(installationId)).resolves.toMatchObject({ removed: false })

    await expect(remover.remove({ installationId }, execution())).resolves.toMatchObject({ removed: true })
    expect(dumpConfig).toHaveBeenCalledTimes(1)
    await expect(store.getInstallation(installationId)).resolves.toMatchObject({ removed: true })
  })

  it('calls Host tool_roundtrip once and keeps the receipt free of args, output, env, and paths', async () => {
    const { root, store, ctx } = await installHarness(attestedReview())
    let verifyHostCalls = 0
    const verifyHostArgs: unknown[] = []
    const launcher = {
      install: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
      profileTargetAbsent: async () => true,
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
})
