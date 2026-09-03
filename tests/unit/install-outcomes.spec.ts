import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { testReview } from '../helpers/records.js'
import { testRuntimeConfig } from '../helpers/runtime-config.js'
import { trackTempDirs } from '../helpers/temp-dirs.js'
import type { RuntimeConfig } from '../../src/config.js'
import { POLICY_VERSION, type ReviewRecord, type VerificationEvidence } from '../../src/contracts.js'
import { EvolutionError } from '../../src/errors.js'
import { dependencySpecDigest } from '../../src/resolver/installed-origin.js'
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
import { hashObject, sha256 } from '../../src/state/hashes.js'
import { compactAgentView } from '../../src/workflow/agent-view.js'
import type { WorkflowRecord } from '../../src/workflow/contracts.js'

const temporary = trackTempDirs()

function review(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return testReview(overrides)
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
  return testRuntimeConfig(root, { dshHome: path.join(root, 'persistent-dsh-home') })
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

async function putFrozenReview(root: string, store: StateStore, record: ReviewRecord): Promise<ReviewRecord> {
    const artifactRoot = path.join(root, 'review-artifacts', `${record.id}-${Math.random().toString(16).slice(2)}`)
    const artifactPath = path.join(artifactRoot, 'package', 'reviewed.tgz')
    const artifactBytes = Buffer.from(`artifact:${record.id}`)
    await mkdir(path.dirname(artifactPath), { recursive: true })
    await writeFile(artifactPath, artifactBytes)
    const installSpec = `file:${artifactPath.replaceAll('\\', '/')}`
    const frozen: ReviewRecord = {
      ...record,
      installSpec,
      artifact: {
        sha256: sha256(artifactBytes),
        bytes: artifactBytes.byteLength,
        entryCount: record.inspectedFiles.length,
        ownedRoot: artifactRoot,
      },
      ...(record.mechanicalFacts ? {
        mechanicalFacts: {
          ...record.mechanicalFacts,
          manifest: { ...record.mechanicalFacts.manifest, materializable: true, installSpec },
        },
      } : {}),
    }
    await store.put('reviews', frozen)
    return frozen
}

async function setup(record?: ReviewRecord): Promise<{ root: string; store: StateStore; ctx: Context }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-outcome-'))
  temporary.push(root)
  const store = new StateStore(root)
  if (record) await putFrozenReview(root, store, record)
  const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
  return { root, store, ctx }
}

function launcherWithHost(evidence: VerificationEvidence, sourceMatches = true) {
  const verifyHost = vi.fn(async () => evidence)
  const verify = vi.fn(async () => { throw new Error('LLM verify must not drive mechanical verification') })
  const launcher = {
    install: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
    profileTargetAbsent: async () => true,
    profileSourceMatches: async () => sourceMatches,
    readInstalledVerificationFixtures: async () => jsonFixtures(),
    verifyHost,
    verify,
  } as unknown as DshLauncher
  return { launcher, verifyHost, verify }
}

describe('fail-closed install outcomes', () => {
  it('rejects missing and mismatched install specifications without synthesizing a fallback', () => {
    expect(() => installTesting.assertStrictInstallSpec(review({ installSpec: null }))).toThrow(/Host-owned frozen file artifact/i)
    expect(() => installTesting.assertStrictInstallSpec(review({
      installSpec: `github:acme/calculator#${'d'.repeat(40)}`,
    }))).toThrow(/Host-owned frozen file artifact/i)
    expect(installTesting.assertStrictInstallSpec(review())).toMatch(/^file:/u)
  })

  it('returns failed_absent when the install command fails and the target is confirmed absent', async () => {
    const { root, store, ctx } = await setup(review())
    const launcher = {
      install: async () => { throw new EvolutionError('command_failed', 'dsh exited with code 1', {
        exitCode: 1,
        diagnosticSummary: 'ERR_PNPM_EPERM failed at C:\\Users\\Jane Doe\\profile; token=top-secret',
        diagnosticHash: 'a'.repeat(64),
      }) },
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
      installFailure: {
        summary: 'ERR_PNPM_EPERM failed at [path]; [credential]',
        message: 'dsh exited with code 1',
        exitCode: 1,
        diagnosticHash: 'a'.repeat(64),
      },
    })
    expect(result.upstreamProject).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain('Jane Doe')
    expect(JSON.stringify(result)).not.toContain('top-secret')
  })

  it('binds a release-age exception to the failed receipt and applies it only after fresh approval', async () => {
    const currentReview = review()
    const { root, store } = await setup(currentReview)
    const workflowId = `workflow_${'6'.repeat(24)}`
    const diagnosticHash = 'a'.repeat(64)
    const exactPackages = ['@deepseek-ai/dsh-file-viewer@0.2.5', 'ds-harness-remote@0.3.35']
    const dshHome = path.join(root, 'persistent-dsh-home')
    const profileRoot = path.join(dshHome, 'profiles', 'persistent')
    await mkdir(profileRoot, { recursive: true })
    await writeFile(path.join(profileRoot, 'pnpm-lock.yaml'), [
      "'@deepseek-ai/dsh-file-viewer@0.2.5':",
      "'ds-harness-remote@0.3.35':",
    ].join('\n'))
    const firstCtx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const failingLauncher = {
      install: async () => { throw new EvolutionError('command_failed', 'dsh exited with code 1', {
        exitCode: 1,
        diagnosticHash,
        recovery: {
          kind: 'minimum_release_age', owner: 'pnpm', code: 'ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION',
          policyKey: 'minimumReleaseAge',
          entries: [
            { packageName: 'ds-harness-remote', version: '0.3.35', reason: 'published recently' },
            { packageName: '@deepseek-ai/dsh-file-viewer', version: '0.2.5', reason: 'published recently' },
          ],
        },
      }) },
      profileTargetAbsent: async () => true,
    } as unknown as DshLauncher
    const failed = await new PluginInstaller(firstCtx, config(root), store, failingLauncher, async () => true).install({
      reviewId: currentReview.id,
      targetProfile: 'persistent',
      retention: 'persistent',
      verificationTask: 'test calculator',
    }, execution(), { workflow: { id: workflowId } })
    expect(failed.installFailure?.recovery).toMatchObject({
      kind: 'minimum_release_age', scope: 'host_profile', exceptionEligible: true,
    })

    const approvalReasons: string[] = []
    const retryCtx = {
      get: () => ({ request: async (request: { reason: string }) => {
        approvalReasons.push(request.reason)
        return 'allowed-once'
      } }),
    } as unknown as Context
    const install = vi.fn(async (..._args: unknown[]) => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }))
    const retryLauncher = {
      install,
      profileTargetAbsent: async () => true,
      profileSourceMatches: async () => true,
      readInstalledVerificationFixtures: async () => jsonFixtures(),
      verifyHost: async () => hostPassedEvidence,
    } as unknown as DshLauncher
    const retried = await new PluginInstaller(retryCtx, config(root), store, retryLauncher, async () => true).install({
      reviewId: currentReview.id,
      targetProfile: 'persistent',
      retention: 'persistent',
      verificationTask: 'test calculator',
      recoveryPlan: {
        id: `recovery_${hashObject({
          workflowId,
          installationId: failed.id,
          reviewId: currentReview.id,
          diagnosticHash,
          exactPackages,
        }).slice(0, 24)}`,
        operation: 'retry_install',
        strategy: 'minimum_release_age_exception',
        sourceInstallationId: failed.id,
        diagnosticHash,
        exactPackages,
        effectScope: 'single_install_command',
      },
    }, execution(), { workflow: { id: workflowId, lastInstallationId: failed.id } })

    expect(retried.id).not.toBe(failed.id)
    expect(retried.installOutcome).toBe('awaiting_user_test')
    expect(install).toHaveBeenCalledTimes(1)
    expect(install.mock.calls[0]?.[5]).toEqual({ minimumReleaseAgeExcludes: exactPackages })
    expect(approvalReasons).toHaveLength(1)
    expect(approvalReasons[0]).toContain(exactPackages[0])
    expect(approvalReasons[0]).toContain(exactPackages[1])
    expect(approvalReasons[0]).toMatch(/one install command|本次安装命令/u)
    expect((await store.getInstallation(failed.id)).installOutcome).toBe('failed_absent')
  })

  it('parks a pnpm store mismatch and retries only with the unchanged Host-read profile store', async () => {
    const currentReview = review()
    const { root, store } = await setup(currentReview)
    const workflowId = `workflow_${'7'.repeat(24)}`
    const diagnosticHash = 'b'.repeat(64)
    const profileStoreFingerprint = 'c'.repeat(64)
    const firstCtx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const failingLauncher = {
      install: async () => { throw new EvolutionError('command_failed', 'dsh exited with code 1', {
        exitCode: 1,
        diagnosticHash,
        recovery: {
          kind: 'profile_store_mismatch', owner: 'pnpm', code: 'ERR_PNPM_UNEXPECTED_STORE',
        },
      }) },
      profileStoreFingerprint: async () => profileStoreFingerprint,
      profileTargetAbsent: async () => true,
    } as unknown as DshLauncher
    const failed = await new PluginInstaller(firstCtx, config(root), store, failingLauncher, async () => true).install({
      reviewId: currentReview.id,
      targetProfile: 'persistent',
      retention: 'persistent',
      verificationTask: 'test calculator',
    }, execution(), { workflow: { id: workflowId } })
    expect(failed.installFailure?.recovery).toEqual({
      kind: 'profile_store_mismatch',
      owner: 'pnpm',
      code: 'ERR_PNPM_UNEXPECTED_STORE',
      profileStoreFingerprint,
      scope: 'host_profile',
      reuseEligible: true,
    })

    const approvalReasons: string[] = []
    const retryCtx = {
      get: () => ({ request: async (request: { reason: string }) => {
        approvalReasons.push(request.reason)
        return 'allowed-once'
      } }),
    } as unknown as Context
    const install = vi.fn(async (..._args: unknown[]) => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }))
    const retryLauncher = {
      install,
      profileTargetAbsent: async () => true,
      profileStoreFingerprint: async () => profileStoreFingerprint,
      profileSourceMatches: async () => true,
      readInstalledVerificationFixtures: async () => jsonFixtures(),
      verifyHost: async () => hostPassedEvidence,
    } as unknown as DshLauncher
    const retried = await new PluginInstaller(retryCtx, config(root), store, retryLauncher, async () => true).install({
      reviewId: currentReview.id,
      targetProfile: 'persistent',
      retention: 'persistent',
      verificationTask: 'test calculator',
      recoveryPlan: {
        id: `recovery_${hashObject({
          workflowId,
          installationId: failed.id,
          reviewId: currentReview.id,
          diagnosticHash,
          profileStoreFingerprint,
        }).slice(0, 24)}`,
        operation: 'retry_install',
        strategy: 'profile_store_reuse',
        sourceInstallationId: failed.id,
        diagnosticHash,
        profileStoreFingerprint,
        effectScope: 'single_install_command',
      },
    }, execution(), { workflow: { id: workflowId, lastInstallationId: failed.id } })

    expect(retried.installOutcome).toBe('awaiting_user_test')
    expect(retried.recoveryAttempt).toMatchObject({
      strategy: 'profile_store_reuse',
      sourceInstallationId: failed.id,
    })
    expect(install).toHaveBeenCalledTimes(1)
    expect(install.mock.calls[0]?.[5]).toEqual({ expectedProfileStoreFingerprint: profileStoreFingerprint })
    expect(approvalReasons).toHaveLength(1)
    expect(approvalReasons[0]).toMatch(/reuse the pnpm store|复用目标 profile/u)
    expect(approvalReasons[0]).not.toMatch(/--store-dir|config\.store-dir/u)
    expect((await store.getInstallation(failed.id)).installOutcome).toBe('failed_absent')
  })

  it('runs one install attempt and exposes a transient failure for an explicit retry', async () => {
    const currentReview = review()
    const { root, store, ctx } = await setup(currentReview)
    const install = vi.fn(async (..._args: unknown[]) => {
      throw new EvolutionError('command_failed', 'temporary registry failure')
    })
    const launcher = {
      install,
      profileTargetAbsent: async () => true,
    } as unknown as DshLauncher
    const result = await new PluginInstaller(ctx, config(root), store, launcher, async () => true).install({
      reviewId: currentReview.id,
      targetProfile: 'persistent',
      retention: 'persistent',
      verificationTask: 'test calculator',
    }, execution())

    expect(install).toHaveBeenCalledTimes(1)
    expect(result.installFailure?.recovery).toBeUndefined()
    expect(result.installOutcome).toBe('failed_absent')
  })

  it('returns recovery_required with unknown state when a failed target is present but exact source is unproven', async () => {
    const { root, store, ctx } = await setup(review())
    const profileTargetAbsent = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false)
    const launcher = {
      install: async () => { throw new Error('timeout after manifest update') },
      profileTargetAbsent,
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
      // Presence alone cannot prove that the reviewed source won the mutation.
      installState: 'unknown',
      installed: false,
      verified: false,
    })
  })

  it('reports verified success only after Host tool_roundtrip and never calls a semantic verifier', async () => {
    const { root, store, ctx } = await setup(attestedReview())
    const { launcher, verifyHost, verify } = launcherWithHost(hostPassedEvidence)
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
      upstreamProject: { repository: 'acme/calculator' },
    })
  })

  it('keeps a verified persistent install usable but requests restart when hot-load is unsupported', async () => {
    const { root, store, ctx } = await setup(attestedReview())
    const { launcher } = launcherWithHost(hostPassedEvidence)
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

  it('preflights the exact source in isolated minimal DSH before installing into the live profile', async () => {
    const { root, store, ctx } = await setup(attestedReview())
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
      'autoevo-verify',
    )
    const result = await installer.install({
      reviewId: review().id,
      targetProfile: 'web',
      retention: 'persistent',
    }, execution())

    expect(install).toHaveBeenCalledTimes(2)
    expect(install.mock.calls[0]?.[1]).toBe('autoevo-verify')
    expect(install.mock.calls[1]?.[0]).toBe(config(root).dshHome)
    expect(install.mock.calls[1]?.[1]).toBe('web')
    expect(install.mock.calls[0]?.[2]).toBe(install.mock.calls[1]?.[2])
    expect(result).toMatchObject({
      installPhase: 'completed',
      targetProfile: 'web',
      installOutcome: 'verified',
      loaded: false,
      restartRequired: true,
      preflight: { profile: 'autoevo-verify', passed: true, sourceMatched: true },
    })
  })

  it('does not mutate the destination when isolated minimal DSH preflight fails', async () => {
    const { root, store, ctx } = await setup(attestedReview())
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
      ctx, config(root), store, launcher, async () => true, undefined, undefined, undefined, 'autoevo-verify',
    ).install({ reviewId: review().id, targetProfile: 'web', retention: 'persistent' }, execution())

    expect(install).toHaveBeenCalledTimes(1)
    expect(install.mock.calls[0]?.[1]).toBe('autoevo-verify')
    expect(result).toMatchObject({
      installPhase: 'completed',
      installOutcome: 'failed_absent',
      installState: 'not_installed',
      installed: false,
      preflight: { passed: false },
    })
  })

  it('rechecks destination absence after preflight and refuses a concurrent install race', async () => {
    const { root, store, ctx } = await setup(attestedReview())
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
      ctx, config(root), store, launcher, async () => true, undefined, undefined, undefined, 'autoevo-verify',
    )

    await expect(installer.install({
      reviewId: review().id,
      targetProfile: 'web',
      retention: 'persistent',
    }, execution())).rejects.toThrow(/refusing to overwrite or remove a user-owned installation/i)
    expect(absenceChecks).toBe(2)
    expect(install).toHaveBeenCalledTimes(1)
    expect(install.mock.calls[0]?.[1]).toBe('autoevo-verify')
  })

  it('rehashes a managed local artifact after preflight before destination mutation', async () => {
    const { root, store, ctx } = await setup()
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
    const frozen = await putFrozenReview(root, store, local)
    const install = vi.fn(async (
      _home: string, _profile: string, _spec: string, _cwd: string, _signal?: AbortSignal,
    ) => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }))
    const artifact = frozen.installSpec!.slice('file:'.length)
    const launcher = {
      profileTargetAbsent: async () => true,
      install,
      profileSourceMatches: async () => true,
      readInstalledVerificationFixtures: async () => jsonFixtures(),
      verifyHost: async () => {
        await writeFile(artifact, 'changed after preflight')
        return hostPassedEvidence
      },
    } as unknown as DshLauncher
    const installer = new PluginInstaller(
      ctx, config(root), store, launcher, async () => true, undefined, undefined, undefined, 'autoevo-verify',
    )

    await expect(installer.install({
      reviewId: local.id,
      targetProfile: 'web',
      retention: 'persistent',
    }, execution())).rejects.toThrow(/bytes changed between isolated preflight and destination install/i)
    expect(install).toHaveBeenCalledTimes(1)
    expect(install.mock.calls[0]?.[1]).toBe('autoevo-verify')
  })

  it('rehashes the frozen artifact after approval before isolated execution', async () => {
    const { root, store } = await setup()
    const frozen = await putFrozenReview(root, store, attestedReview())
    const artifact = frozen.installSpec!.slice('file:'.length)
    const request = vi.fn(async () => {
      await writeFile(artifact, 'changed while approval was pending')
      return 'allowed-once'
    })
    const ctx = { get: () => ({ request }) } as unknown as Context
    const install = vi.fn()
    const launcher = {
      profileTargetAbsent: async () => true,
      install,
    } as unknown as DshLauncher
    const installer = new PluginInstaller(
      ctx, config(root), store, launcher, async () => true, undefined, undefined, undefined, 'autoevo-verify',
    )

    await expect(installer.install({
      reviewId: frozen.id,
      targetProfile: 'web',
      retention: 'persistent',
    }, execution())).rejects.toThrow(/changed after user approval and before isolated preflight/i)
    expect(request).toHaveBeenCalledTimes(1)
    expect(install).not.toHaveBeenCalled()
  })

  it('refuses to overwrite an existing destination package before approval or preflight', async () => {
    const { root, store } = await setup(attestedReview())
    const request = vi.fn(async () => 'allowed-once')
    const ctx = { get: () => ({ request }) } as unknown as Context
    const install = vi.fn()
    const launcher = { profileTargetAbsent: async () => false, install } as unknown as DshLauncher
    const installer = new PluginInstaller(
      ctx, config(root), store, launcher, async () => true, undefined, undefined, undefined, 'autoevo-verify',
    )

    await expect(installer.install({
      reviewId: review().id,
      targetProfile: 'web',
      retention: 'persistent',
    }, execution())).rejects.toThrow(/refusing to overwrite or remove a user-owned installation/i)
    expect(request).not.toHaveBeenCalled()
    expect(install).not.toHaveBeenCalled()
  })

  it('persists a same-package replacement when the frozen old spec still matches live profile state', async () => {
    const oldSpec = `github:acme/calculator#${'c'.repeat(40)}`
    const newCommit = 'd'.repeat(40)
    const newSpec = `github:acme/calculator#${newCommit}`
    const current = attestedReview({
      sourceSnapshot: {
        kind: 'github',
        repository: 'acme/calculator',
        requestedRef: newCommit,
        commit: newCommit,
        defaultBranch: 'main',
      },
      installSpec: newSpec,
    })
    const { root, store, ctx } = await setup(current)
    const predecessorId = `installation_${'b'.repeat(24)}`
    await store.put('installations', {
      schemaVersion: 1,
      id: predecessorId,
      createdAt: '2026-08-01T00:00:00.000Z',
      reviewId: `review_${'c'.repeat(64)}`,
      targetProfile: process.platform === 'win32' ? 'WEB' : 'web',
      retention: 'persistent',
      dshHome: process.platform === 'win32'
        ? path.join(root, 'persistent-dsh-home').toUpperCase()
        : path.join(root, 'persistent-dsh-home'),
      packageName: 'DSH-TOOL-CALCULATOR',
      installSpec: oldSpec,
      installPhase: 'completed',
      installState: 'installed',
      installOutcome: 'awaiting_user_test',
      installed: true,
      loaded: false,
      verified: false,
      restartRequired: true,
      removed: false,
      supersededByInstallationId: `installation_${'9'.repeat(24)}`,
      verification: {
        attempted: false,
        expectedTools: ['calculator'],
        calledTools: [],
        resultTools: [],
        failedTools: [],
        sessionFiles: [],
        taskResultObserved: false,
        reason: 'predecessor',
      },
    })
    const normalizedPredecessor = await store.getInstallation(predecessorId)
    const { supersededByInstallationId: _ignoredForward, ...foreignPredecessor } = normalizedPredecessor
    void _ignoredForward
    await store.put('installations', {
      ...foreignPredecessor,
      id: `installation_${'a'.repeat(24)}`,
      dshHome: path.join(root, 'foreign-dsh-home'),
      targetProfile: 'web',
      packageName: 'dsh-tool-calculator',
    })
    const strictHistory = vi.spyOn(store, 'listInstallationsStrictExcluding')
    const launcher = {
      install: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
      profileTargetAbsent: async () => false,
      profileDependencySpec: async () => oldSpec,
      profileSourceMatches: async (_home: string, _profile: string, _name: string, spec: string) => spec.startsWith('file:'),
      verifyHost: async () => hostPassedEvidence,
      readInstalledVerificationFixtures: async () => jsonFixtures(),
    } as unknown as DshLauncher
    const installer = new PluginInstaller(
      ctx, config(root), store, launcher, async () => true, undefined, async () => ({
        evidence: { attempted: true, loaded: false, method: 'unsupported', reason: 'replacement requires restart' },
      }),
      undefined,
      'autoevo-verify',
    )
    const result = await installer.install({
      reviewId: current.id,
      targetProfile: 'web',
      retention: 'persistent',
      replacement: {
        profile: 'web',
        packageName: 'dsh-tool-calculator',
        oldSpecDigest: dependencySpecDigest(oldSpec),
        oldDependencySpec: oldSpec,
        predecessorInstallationId: `installation_${'8'.repeat(24)}`,
      },
    }, execution())
    expect(result.replacement?.state).toBe('new_present')
    expect(result.predecessorInstallationId).toBe(predecessorId)
    expect(strictHistory).toHaveBeenCalledWith(result.id)
    expect(await strictHistory.mock.results[0]?.value).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: result.id }),
    ]))
    expect((await store.getInstallation(predecessorId)).supersededByInstallationId)
      .toBe(`installation_${'9'.repeat(24)}`)
  })

  it('records final receipt ambiguity without invoking a stale Loader rollback after hot-load', async () => {
    const current = attestedReview()
    const { root, store, ctx } = await setup(current)
    const installationId = `installation_${'f'.repeat(24)}`
    const originalPut = store.put.bind(store)
    let installationWrites = 0
    vi.spyOn(store, 'put').mockImplementation(async (kind, value) => {
      if (kind === 'installations') {
        installationWrites += 1
        if (installationWrites === 3) throw new Error('final receipt write rejected')
      }
      await originalPut(kind, value)
    })
    const staleRollback = vi.fn(async () => undefined)
    const { launcher } = launcherWithHost(hostPassedEvidence)
    const installer = new PluginInstaller(
      ctx, config(root), store, launcher, async () => true, undefined, async () => ({
        evidence: { attempted: true, loaded: true, method: 'loader', reason: 'hot-loaded before receipt failure' },
        // A legacy/injected callback must not regain authority over the Loader.
        rollback: staleRollback,
      }),
    )

    await expect(installer.install({
      reviewId: current.id,
      installationId,
      targetProfile: 'persistent',
      retention: 'persistent',
    }, execution())).rejects.toMatchObject({ code: 'command_failed', details: { recoveryRequired: true } })
    expect(staleRollback).not.toHaveBeenCalled()
    await expect(store.getInstallation(installationId)).resolves.toMatchObject({
      installState: 'unknown',
      installOutcome: 'recovery_required',
      installed: false,
      loaded: false,
      verified: false,
      hotReload: { attempted: true, loaded: true, method: 'loader' },
    })
  })

  it('refuses replacement when the live spec drifted from the frozen installed target', async () => {
    const { root, store, ctx } = await setup(attestedReview())
    const install = vi.fn()
    const launcher = {
      install,
      profileTargetAbsent: async () => false,
      profileDependencySpec: async () => 'github:acme/calculator#main',
    } as unknown as DshLauncher
    const installer = new PluginInstaller(
      ctx, config(root), store, launcher, async () => true, undefined, undefined, undefined, 'autoevo-verify',
    )
    await expect(installer.install({
      reviewId: attestedReview().id,
      targetProfile: 'web',
      retention: 'persistent',
      replacement: {
        profile: 'web',
        packageName: 'dsh-tool-calculator',
        oldSpecDigest: 'a'.repeat(64),
        oldDependencySpec: `github:acme/calculator#${'c'.repeat(40)}`,
      },
    }, execution())).rejects.toThrow(/drifted from the frozen installed target/i)
    expect(install).not.toHaveBeenCalled()
  })

  it('rechecks the live profile owner immediately before any persistent mutation', async () => {
    const { root, store } = await setup(attestedReview())
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
      'autoevo-verify',
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

  it('reports activated after Host bundle_activation and never claims verified', async () => {
    const none = attestedReview({
      manifest: {
        ...review().manifest,
        packageName: 'dsh-subscription-auth',
        expectedTools: [],
      },
      runtimeSurface: attestedSurface([]),
    })
    const { root, store, ctx } = await setup(none)
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
      profileTargetAbsent: async () => true,
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
    let verifyHostCalls = 0
    const launcher = {
      install: async () => {
        installs += 1
        throw new Error('must not install')
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
    expect(verifyHostCalls).toBe(0)
    expect(store.installationWrites).toBe(0)
  })

  it('reports recovery rather than restart when hot-load runtime state is ambiguous', async () => {
    const { root, store, ctx } = await setup(attestedReview())
    const { launcher } = launcherWithHost(hostPassedEvidence)
    const installer = new PluginInstaller(ctx, config(root), store, launcher, async () => true, undefined, async () => ({
      evidence: { attempted: true, loaded: false, method: 'failed', reason: 'activation state is ambiguous' },
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
    const none = attestedReview({
      manifest: {
        ...review().manifest,
        packageName: 'dsh-subscription-auth',
        expectedTools: [],
      },
      runtimeSurface: attestedSurface([]),
    })
    const { root, store, ctx } = await setup(none)
    const ambiguousActivation = vi.fn(async () => ({
      evidence: { attempted: true, loaded: false, method: 'failed' as const, reason: 'activation state is ambiguous' },
      rollbackFailed: true,
    }))
    const activatedLauncher = {
      install: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
      profileTargetAbsent: async () => true,
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
      ctx, config(root), store, activatedLauncher, async () => true, undefined, ambiguousActivation,
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
    expect(ambiguousActivation).toHaveBeenCalledTimes(1)

    await putFrozenReview(root, store, review())
    const awaitingLauncher = {
      install: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
      profileTargetAbsent: async () => true,
      profileSourceMatches: async () => true,
      readInstalledVerificationFixtures: async () => jsonFixtures(),
      verifyHost: async () => { throw new Error('manual_runtime must not spawn') },
    } as unknown as DshLauncher
    const awaiting = await new PluginInstaller(
      ctx, config(root), store, awaitingLauncher, async () => true, undefined, ambiguousActivation,
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
    expect(ambiguousActivation).toHaveBeenCalledTimes(1)
  })

  it('requires the target profile to bind the exact reviewed source before verification can succeed', async () => {
    const { root, store, ctx } = await setup(attestedReview())
    const { launcher, verifyHost, verify } = launcherWithHost(hostPassedEvidence, false)
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
    const { root, store, ctx } = await setup()
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
    await putFrozenReview(root, store, local)
    const launcher = { profileTargetAbsent: async () => true } as unknown as DshLauncher
    const installer = new PluginInstaller(ctx, config(root), store, launcher, async () => true)
    await expect(installer.install({
      reviewId: local.id,
      targetProfile: 'persistent',
      retention: 'persistent',
      expectedArtifactSha256: 'f'.repeat(64),
      verificationTask: 'test calculator',
    }, execution())).rejects.toThrow(/receipt does not match the reviewed frozen package/i)
  })

  it('cannot verify when Host tool results are missing, even if a verifier would approve', async () => {
    const { root, store, ctx } = await setup(attestedReview())
    const { launcher } = launcherWithHost({
      ...hostPassedEvidence,
      calledTools: [],
      resultTools: [],
      failedTools: [],
      status: 'failed',
      exitCode: 1,
      reason: 'no successful Host tool result',
    })
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


})
describe('install authorization uses verdict and hard boundaries', () => {
  it('records contribution eligibility only for verified full-fit local installs and exposes it on the compact view', async () => {
    async function installLocal(options: {
      fit: ReviewRecord['fit']
      verification: VerificationEvidence
      license?: string
    }) {
      const { root, store, ctx } = await setup()
      const tgz = path.join(root, 'plugin.tgz')
      await writeFile(tgz, 'reviewed bytes')
      const local = attestedReview({
        sourceSnapshot: {
          kind: 'local',
          path: path.join(root, 'source'),
          baseReviewId: `review_${'b'.repeat(64)}`,
          baseCommit: 'c'.repeat(40),
          statusHash: 'd'.repeat(64),
        },
        installSpec: `file:${tgz.replaceAll('\\', '/')}`,
        fit: options.fit,
        license: options.license ?? 'MIT',
        recommendation: 'use',
      })
      await putFrozenReview(root, store, local)
      const installer = new PluginInstaller(
        ctx,
        config(root),
        store,
        {
          profileTargetAbsent: async () => true,
          install: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
          profileSourceMatches: async () => true,
          readInstalledVerificationFixtures: async () => jsonFixtures(),
          verifyHost: async () => options.verification,
        } as unknown as DshLauncher,
        async () => true,
        undefined,
        async () => ({
          evidence: { attempted: true, loaded: true, method: 'loader', reason: 'hot-loaded' },
        }),
        undefined,
        'autoevo-verify',
      )
      const result = await installer.install({
        reviewId: local.id,
        targetProfile: 'web',
        retention: 'persistent',
      }, execution())
      return result
    }

    const eligible = await installLocal({ fit: 'full', verification: hostPassedEvidence })
    expect(eligible.installOutcome).toBe('verified')
    expect(eligible.contributionAdvice).toEqual({
      eligible: true,
      reason: expect.stringMatching(/Potentially eligible to suggest/i),
    })
    const workflow: WorkflowRecord = {
      schemaVersion: 2,
      id: `workflow_${'a'.repeat(24)}`,
      policyVersion: POLICY_VERSION,
      createdAt: '2026-08-23T00:00:00.000Z',
      updatedAt: '2026-08-23T00:00:00.000Z',
      requirement: 'orbit-search',
      status: 'completed',
      cursor: 'installed',
      generation: 1,
    }
    const card = compactAgentView({
      workflow,
      installation: eligible,
      lifecycleState: 'verified',
    })
    expect(card.state).toBe('completed')
    expect(card.facts.installation).toMatchObject({
      outcome: 'verified',
      verified: true,
      may_claim_verified: true,
      contribution: {
        eligible: true,
        reason: expect.stringMatching(/explicit approval/i),
      },
    })
    expect(JSON.stringify(card.facts.installation)).not.toMatch(/use_this|interrupt_|workflow_/)

    const partial = await installLocal({ fit: 'partial', verification: hostPassedEvidence })
    expect(partial.contributionAdvice?.eligible).toBe(false)
    expect(compactAgentView({
      workflow,
      installation: partial,
      lifecycleState: 'verified',
    }).facts.installation).toMatchObject({
      contribution: { eligible: false },
    })

    const unverified = await installLocal({ fit: 'full', verification: hostFailedEvidence })
    expect(unverified.verified).toBe(false)
    expect(unverified.contributionAdvice?.eligible === true).toBe(false)
  })
})
