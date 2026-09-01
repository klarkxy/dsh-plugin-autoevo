import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { testReview } from '../helpers/records.js'
import { testRuntimeConfig } from '../helpers/runtime-config.js'
import { trackTempDirs } from '../helpers/temp-dirs.js'
import type { ReviewRecord, VerificationEvidence } from '../../src/contracts.js'
import { EvolutionError } from '../../src/errors.js'
import { PluginInstaller, type ProfileHotLoader } from '../../src/lifecycle/install.js'
import type { DshLauncher } from '../../src/lifecycle/launcher.js'
import { dependencySpecDigest } from '../../src/resolver/installed-origin.js'
import { sha256 } from '../../src/state/hashes.js'
import { StateStore } from '../../src/state/store.js'

const temporary = trackTempDirs()

const passedEvidence: VerificationEvidence = {
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
  reason: 'Host proved the expected tool round-trip.',
}

async function fixture(options: {
  approval?: () => Promise<'allowed-once'>
} = {}): Promise<{
  root: string
  store: StateStore
  review: ReviewRecord
  ctx: Context
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-install-cancel-'))
  temporary.push(root)
  const store = new StateStore(root)
  const base = testReview({
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
      toolFixtures: [{ tool: 'calculator', available: true, safe: true, hostValidated: true }],
      kind: 'bundle',
      verificationLayer: 'tool_roundtrip',
    },
  })
  const artifactRoot = path.join(root, 'review-artifact')
  const artifactPath = path.join(artifactRoot, 'package', 'reviewed.tgz')
  const artifact = Buffer.from('reviewed cancellation artifact')
  await mkdir(path.dirname(artifactPath), { recursive: true })
  await writeFile(artifactPath, artifact)
  const installSpec = `file:${artifactPath.replaceAll('\\', '/')}`
  const review: ReviewRecord = {
    ...base,
    installSpec,
    artifact: {
      sha256: sha256(artifact),
      bytes: artifact.byteLength,
      entryCount: base.inspectedFiles.length,
      ownedRoot: artifactRoot,
    },
    ...(base.mechanicalFacts
      ? { mechanicalFacts: {
          ...base.mechanicalFacts,
          manifest: { ...base.mechanicalFacts.manifest, materializable: true, installSpec },
        } }
      : {}),
  }
  await store.put('reviews', review)
  const ctx = {
    get(name: string) {
      if (name !== 'approval') return undefined
      return { request: options.approval ?? (async () => 'allowed-once' as const) }
    },
  } as unknown as Context
  return { root, store, review, ctx }
}

function exec(signal?: AbortSignal): ToolRunContext {
  return {
    callId: 'install-cancellation',
    agent: { session: { header: { cwd: process.cwd() } } },
    ...(signal ? { signal } : {}),
  } as unknown as ToolRunContext
}

function launcher(overrides: Partial<DshLauncher> = {}): DshLauncher {
  return {
    install: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
    profileSourceMatches: async () => true,
    profileTargetAbsent: async () => true,
    readInstalledVerificationFixtures: async () => ({ calculator: { arguments: { expression: '1+1' } } }),
    verifyHost: async () => passedEvidence,
    ...overrides,
  } as unknown as DshLauncher
}

function input(review: ReviewRecord, installationId: string) {
  return {
    reviewId: review.id,
    installationId,
    targetProfile: 'web',
    retention: 'persistent' as const,
    verificationTask: 'verify calculator',
  }
}

function replacementInput(review: ReviewRecord, installationId: string, oldSpec: string) {
  return {
    ...input(review, installationId),
    replacement: {
      profile: 'web',
      packageName: review.manifest.packageName!,
      oldSpecDigest: dependencySpecDigest(oldSpec),
      oldDependencySpec: oldSpec,
    },
  }
}

function installer(options: {
  ctx: Context
  root: string
  store: StateStore
  launcher: DshLauncher
  hotLoader?: ProfileHotLoader
  preflightProfile?: string
}): PluginInstaller {
  return new PluginInstaller(
    options.ctx,
    testRuntimeConfig(options.root, { dshHome: path.join(options.root, 'dsh-home') }),
    options.store,
    options.launcher,
    async () => true,
    undefined,
    options.hotLoader ?? (async () => ({
      evidence: { attempted: false, loaded: false, method: 'unsupported', reason: 'restart' },
    })),
    undefined,
    options.preflightProfile,
  )
}

describe('effect-aware install cancellation', () => {
  it('does not approve or install when already cancelled, and catches approval implementations that ignore cancellation', async () => {
    const pre = await fixture()
    const preController = new AbortController()
    const preReason = new Error('cancel before install')
    preController.abort(preReason)
    const preInstall = vi.fn()
    await expect(installer({
      ...pre,
      launcher: launcher({ install: preInstall }),
    }).install(input(pre.review, `installation_${'1'.repeat(24)}`), exec(preController.signal))).rejects.toBe(preReason)
    expect(preInstall).not.toHaveBeenCalled()

    const approvalController = new AbortController()
    const approvalReason = new Error('approval ignored cancellation')
    const approvalInstall = vi.fn()
    const duringApproval = await fixture({
      approval: async () => {
        approvalController.abort(approvalReason)
        return 'allowed-once'
      },
    })
    await expect(installer({
      ...duringApproval,
      launcher: launcher({ install: approvalInstall }),
    }).install(
      input(duringApproval.review, `installation_${'2'.repeat(24)}`),
      exec(approvalController.signal),
    )).rejects.toBe(approvalReason)
    expect(approvalInstall).not.toHaveBeenCalled()
  })

  it('never retries a transient install failure after cancellation', async () => {
    const current = await fixture()
    const controller = new AbortController()
    const reason = new Error('cancel transient retry')
    const install = vi.fn(async () => {
      controller.abort(reason)
      throw new EvolutionError('command_failed', 'transient pnpm failure', {
        recovery: { kind: 'same_authority_once', owner: 'pnpm', code: 'ERR_PNPM_EPERM' },
      })
    })
    const installationId = `installation_${'3'.repeat(24)}`
    await expect(installer({
      ...current,
      launcher: launcher({ install, profileSourceMatches: async () => false, profileTargetAbsent: async () => true }),
    }).install(input(current.review, installationId), exec(controller.signal))).rejects.toBe(reason)
    expect(install).toHaveBeenCalledTimes(1)
    await expect(current.store.getInstallation(installationId)).resolves.toMatchObject({
      installPhase: 'completed',
      installState: 'not_installed',
      installOutcome: 'failed_absent',
      removed: false,
      installFailure: { code: 'operation_cancelled' },
    })
  })

  it('cleans and seals an aborted isolated preflight without touching the destination', async () => {
    const current = await fixture()
    const controller = new AbortController()
    const reason = new Error('cancel after preflight verification')
    const installProfiles: string[] = []
    const installationId = `installation_${'4'.repeat(24)}`
    const trialRoot = current.store.trialRoot(installationId)
    const verifyHost = vi.fn(async () => {
      controller.abort(reason)
      return passedEvidence
    })
    await expect(installer({
      ...current,
      preflightProfile: 'autoevo-verify',
      launcher: launcher({
        install: async (_home, profile) => {
          installProfiles.push(profile)
          return { exitCode: 0, signal: null, stdout: '', stderr: '' }
        },
        profileTargetAbsent: async () => true,
        verifyHost,
      }),
    }).install(input(current.review, installationId), exec(controller.signal))).rejects.toBe(reason)
    expect(installProfiles).toEqual(['autoevo-verify'])
    expect(verifyHost).toHaveBeenCalledTimes(1)
    await expect(access(trialRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(current.store.getInstallation(installationId)).resolves.toMatchObject({
      installPhase: 'completed',
      installState: 'not_installed',
      installOutcome: 'failed_absent',
      removed: true,
      installFailure: { code: 'operation_cancelled', stage: 'preflight' },
    })
  })

  it('does not claim an aborted preflight was removed when owned cleanup fails', async () => {
    const current = await fixture()
    const controller = new AbortController()
    const reason = new Error('cancel preflight with cleanup failure')
    const installationId = `installation_${'a'.repeat(24)}`
    const subject = installer({
      ...current,
      preflightProfile: 'autoevo-verify',
      launcher: launcher({
        profileTargetAbsent: async () => true,
        verifyHost: async () => {
          controller.abort(reason)
          return passedEvidence
        },
      }),
    })
    const internal = subject as unknown as { removeOwnedDirectory: () => Promise<void> }
    internal.removeOwnedDirectory = async () => { throw new Error('owned cleanup failed') }

    await expect(subject.install(input(current.review, installationId), exec(controller.signal))).rejects.toBe(reason)
    await expect(access(current.store.trialRoot(installationId))).resolves.toBeUndefined()
    await expect(current.store.getInstallation(installationId)).resolves.toMatchObject({
      installPhase: 'completed',
      installState: 'unknown',
      installOutcome: 'recovery_required',
      removed: false,
      installFailure: { code: 'operation_cancelled', stage: 'preflight' },
    })
  })

  it('reconciles a destination that mutated before cancellation without verifying or hot-loading', async () => {
    const current = await fixture()
    const controller = new AbortController()
    const reason = new Error('cancel after destination mutation')
    const verifyHost = vi.fn(async () => passedEvidence)
    const hotLoader = vi.fn(async () => ({
      evidence: { attempted: true, loaded: true, method: 'loader' as const, reason: 'loaded' },
    }))
    const installationId = `installation_${'5'.repeat(24)}`
    await expect(installer({
      ...current,
      launcher: launcher({
        install: async () => {
          controller.abort(reason)
          return { exitCode: 0, signal: null, stdout: '', stderr: '' }
        },
        profileSourceMatches: async () => true,
        verifyHost,
      }),
      hotLoader,
    }).install(input(current.review, installationId), exec(controller.signal))).rejects.toBe(reason)
    expect(verifyHost).not.toHaveBeenCalled()
    expect(hotLoader).not.toHaveBeenCalled()
    await expect(current.store.getInstallation(installationId)).resolves.toMatchObject({
      installState: 'installed',
      installOutcome: 'recovery_required',
      installed: false,
      verification: { attempted: false },
      installFailure: { code: 'operation_cancelled' },
    })
  })

  it('keeps replacement state unknown when live dependency reads fail during cancellation settlement', async () => {
    const current = await fixture()
    const controller = new AbortController()
    const reason = new Error('cancel replacement with unreadable live spec')
    const oldSpec = `github:acme/calculator#${'b'.repeat(40)}`
    const installationId = `installation_${'b'.repeat(24)}`
    const profileDependencySpec = vi.fn()
      .mockResolvedValueOnce(oldSpec)
      .mockResolvedValueOnce(oldSpec)
      .mockRejectedValueOnce(new Error('live profile unreadable'))
    const install = vi.fn(async () => {
      controller.abort(reason)
      return { exitCode: 0, signal: null, stdout: '', stderr: '' }
    })

    await expect(installer({
      ...current,
      launcher: launcher({ install, profileSourceMatches: async () => false, profileDependencySpec }),
    }).install(replacementInput(current.review, installationId, oldSpec), exec(controller.signal))).rejects.toBe(reason)
    expect(install).toHaveBeenCalledTimes(1)
    expect(profileDependencySpec).toHaveBeenCalledTimes(3)
    await expect(current.store.getInstallation(installationId)).resolves.toMatchObject({
      installState: 'unknown',
      installOutcome: 'recovery_required',
      installed: false,
      replacement: { state: 'unknown' },
    })
  })

  it('records a replacement as absent only after a successful live dependency read returns undefined', async () => {
    const current = await fixture()
    const controller = new AbortController()
    const reason = new Error('cancel replacement after confirmed absence')
    const oldSpec = `github:acme/calculator#${'c'.repeat(40)}`
    const installationId = `installation_${'c'.repeat(24)}`
    const profileDependencySpec = vi.fn()
      .mockResolvedValueOnce(oldSpec)
      .mockResolvedValueOnce(oldSpec)
      .mockResolvedValueOnce(undefined)
    const install = vi.fn(async () => {
      controller.abort(reason)
      return { exitCode: 0, signal: null, stdout: '', stderr: '' }
    })

    await expect(installer({
      ...current,
      launcher: launcher({ install, profileSourceMatches: async () => false, profileDependencySpec }),
    }).install(replacementInput(current.review, installationId, oldSpec), exec(controller.signal))).rejects.toBe(reason)
    expect(install).toHaveBeenCalledTimes(1)
    expect(profileDependencySpec).toHaveBeenCalledTimes(3)
    await expect(current.store.getInstallation(installationId)).resolves.toMatchObject({
      installState: 'not_installed',
      installOutcome: 'failed_absent',
      installed: false,
      replacement: { state: 'absent' },
    })
  })

  it('persists passed Host evidence and restart truth when cancellation wins before hot-load', async () => {
    const current = await fixture()
    const controller = new AbortController()
    const reason = new Error('cancel after host evidence')
    const hotLoader = vi.fn()
    const installationId = `installation_${'6'.repeat(24)}`
    await expect(installer({
      ...current,
      launcher: launcher({
        verifyHost: async () => {
          controller.abort(reason)
          return passedEvidence
        },
      }),
      hotLoader,
    }).install(input(current.review, installationId), exec(controller.signal))).rejects.toBe(reason)
    expect(hotLoader).not.toHaveBeenCalled()
    await expect(current.store.getInstallation(installationId)).resolves.toMatchObject({
      installOutcome: 'verified',
      installState: 'installed',
      installed: true,
      verified: true,
      loaded: false,
      restartRequired: true,
      verification: { status: 'passed' },
    })
  })

  it('waits for hot-load evidence, persists the actual loaded result, then throws the exact reason', async () => {
    const current = await fixture()
    const controller = new AbortController()
    const reason = new Error('cancel after hot-load effect')
    const installationId = `installation_${'7'.repeat(24)}`
    const hotLoader = vi.fn(async ({ signal }: Parameters<ProfileHotLoader>[0]) => {
      expect(signal).toBe(controller.signal)
      controller.abort(reason)
      return {
        evidence: { attempted: true, loaded: true, method: 'loader' as const, reason: 'loaded before cancellation' },
      }
    })
    await expect(installer({ ...current, launcher: launcher(), hotLoader })
      .install(input(current.review, installationId), exec(controller.signal))).rejects.toBe(reason)
    expect(hotLoader).toHaveBeenCalledTimes(1)
    await expect(current.store.getInstallation(installationId)).resolves.toMatchObject({
      installOutcome: 'verified',
      installed: true,
      loaded: true,
      restartRequired: false,
      hotReload: { attempted: true, loaded: true, method: 'loader' },
    })
  })

  it('persists pending hot-load ambiguity before returning the exact abort reason', async () => {
    const current = await fixture()
    const controller = new AbortController()
    const reason = new Error('cancel pending Fiber after mutation')
    const installationId = `installation_${'a'.repeat(24)}`
    let entered!: () => void
    const pending = new Promise<void>((resolve) => { entered = resolve })
    const hotLoader = vi.fn(async ({ signal }: Parameters<ProfileHotLoader>[0]) => {
      expect(signal).toBe(controller.signal)
      entered()
      await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }))
      return {
        evidence: { attempted: true, loaded: false, method: 'failed' as const, reason: 'Fiber await aborted after Loader mutation began.' },
        rollbackFailed: true,
      }
    })
    const operation = installer({ ...current, launcher: launcher(), hotLoader })
      .install(input(current.review, installationId), exec(controller.signal))
    await pending
    controller.abort(reason)

    await expect(operation).rejects.toBe(reason)
    await expect(current.store.getInstallation(installationId)).resolves.toMatchObject({
      installOutcome: 'recovery_required',
      installed: false,
      verified: false,
      loaded: false,
      restartRequired: false,
      hotReload: { attempted: true, loaded: false, method: 'failed' },
    })
  })

  it('seals recovery with a stable failure when hot-load throws after cancellation', async () => {
    const current = await fixture()
    const controller = new AbortController()
    const reason = new Error('cancel while hot-load throws')
    const installationId = `installation_${'8'.repeat(24)}`
    const hotLoader = vi.fn(async () => {
      controller.abort(reason)
      throw new Error('arbitrary loader detail must not be persisted')
    })
    await expect(installer({ ...current, launcher: launcher(), hotLoader })
      .install(input(current.review, installationId), exec(controller.signal))).rejects.toBe(reason)
    const record = await current.store.getInstallation(installationId)
    expect(record).toMatchObject({
      installOutcome: 'recovery_required',
      installState: 'installed',
      installed: false,
      verified: false,
      verification: { status: 'passed' },
      installFailure: { code: 'operation_cancelled', stage: 'load' },
      hotReload: { attempted: true, loaded: false, method: 'failed' },
    })
    expect(JSON.stringify(record)).not.toContain('arbitrary loader detail')
  })

  it('prioritizes settlement persistence failure and leaves the provisional journal as recovery anchor', async () => {
    const current = await fixture()
    const controller = new AbortController()
    const reason = new Error('cancel before settlement persistence')
    const installationId = `installation_${'9'.repeat(24)}`
    const originalPut = current.store.put.bind(current.store)
    let installationPuts = 0
    vi.spyOn(current.store, 'put').mockImplementation(async (collection, value) => {
      if (collection === 'installations') {
        installationPuts += 1
        if (installationPuts === 3) throw new Error('settlement persistence failed')
      }
      return originalPut(collection, value)
    })
    const operation = installer({
      ...current,
      launcher: launcher({
        install: async () => {
          controller.abort(reason)
          return { exitCode: 0, signal: null, stdout: '', stderr: '' }
        },
      }),
    }).install(input(current.review, installationId), exec(controller.signal))
    await expect(operation).rejects.toMatchObject({
      code: 'command_failed',
      details: { installationId, recoveryRequired: true, stage: 'persist' },
    })
    await expect(operation).rejects.not.toBe(reason)
    await expect(current.store.getInstallation(installationId)).resolves.toMatchObject({
      installPhase: 'destination_installing',
      installOutcome: 'pending',
    })
  })
})
