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

  it('does not auto-retry a transient failure during a sealed profile-store recovery', async () => {
    const currentReview = review()
    const { root, store } = await setup(currentReview)
    const workflowId = `workflow_${'8'.repeat(24)}`
    const diagnosticHash = 'd'.repeat(64)
    const profileStoreFingerprint = 'e'.repeat(64)
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const failed = await new PluginInstaller(ctx, config(root), store, {
      install: async () => { throw new EvolutionError('command_failed', 'dsh exited with code 1', {
        exitCode: 1,
        diagnosticHash,
        recovery: {
          kind: 'profile_store_mismatch', owner: 'pnpm', code: 'ERR_PNPM_UNEXPECTED_STORE',
        },
      }) },
      profileStoreFingerprint: async () => profileStoreFingerprint,
      profileTargetAbsent: async () => true,
    } as unknown as DshLauncher, async () => true).install({
      reviewId: currentReview.id,
      targetProfile: 'persistent',
      retention: 'persistent',
      verificationTask: 'test calculator',
    }, execution(), { workflow: { id: workflowId } })

    const install = vi.fn(async (..._args: unknown[]) => {
      throw new EvolutionError('command_failed', 'temporary registry failure', {
        recovery: { kind: 'same_authority_once', owner: 'pnpm', code: 'ERR_PNPM_FETCH_503' },
      })
    })
    const retried = await new PluginInstaller(ctx, config(root), store, {
      install,
      profileStoreFingerprint: async () => profileStoreFingerprint,
      profileTargetAbsent: async () => true,
    } as unknown as DshLauncher, async () => true).install({
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

    expect(install).toHaveBeenCalledTimes(1)
    expect(retried.installOutcome).toBe('failed_absent')
    expect(retried.recoveryAttempt).toMatchObject({
      strategy: 'profile_store_reuse',
      sourceInstallationId: failed.id,
    })
    expect((await store.getInstallation(failed.id)).installOutcome).toBe('failed_absent')
  })

  it('retries an allowlisted transient install failure once with the same authority', async () => {
    const currentReview = review()
    const { root, store, ctx } = await setup(currentReview)
    let attempts = 0
    const install = vi.fn(async (..._args: unknown[]) => {
      attempts += 1
      if (attempts === 1) {
        throw new EvolutionError('command_failed', 'temporary registry failure', {
          recovery: { kind: 'same_authority_once', owner: 'pnpm', code: 'ERR_PNPM_FETCH_503' },
        })
      }
      return { exitCode: 0, signal: null, stdout: '', stderr: '' }
    })
    const launcher = {
      install,
      profileTargetAbsent: async () => true,
      profileSourceMatches: async () => true,
      readInstalledVerificationFixtures: async () => jsonFixtures(),
      verifyHost: async () => hostPassedEvidence,
    } as unknown as DshLauncher
    const result = await new PluginInstaller(ctx, config(root), store, launcher, async () => true).install({
      reviewId: currentReview.id,
      targetProfile: 'persistent',
      retention: 'persistent',
      verificationTask: 'test calculator',
    }, execution())

    expect(install).toHaveBeenCalledTimes(2)
    expect(install.mock.calls[1]).toEqual(install.mock.calls[0])
    expect(result.installOutcome).toBe('awaiting_user_test')
  })

  it('does not retry a forged same-authority recovery code outside the pnpm allowlist', async () => {
    const currentReview = review()
    const { root, store, ctx } = await setup(currentReview)
    const install = vi.fn(async (..._args: unknown[]) => {
      throw new EvolutionError('command_failed', 'not a transient pnpm failure', {
        recovery: { kind: 'same_authority_once', owner: 'pnpm', code: 'ERR_PNPM_ARBITRARY' },
      })
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

  it('returns recovery_required when the install command fails but the target is present', async () => {
    const { root, store, ctx } = await setup(review())
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
    const { root, store, ctx } = await setup(review())
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
    const { root, store, ctx } = await setup(attestedReview())
    const { launcher, verifyHost, verify } = launcherWithHost(hostFailedEvidence)
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

  it('uses isolated minimal DSH only for activation preflight when the real result requires a user test', async () => {
    const manual = attestedReview({
      runtimeSurface: {
        ...attestedSurface(),
        networkSignal: true,
        verificationLayer: 'manual_runtime',
      },
    })
    const { root, store, ctx } = await setup(manual)
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
      'autoevo-verify',
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
      targetProfile: 'web',
      retention: 'persistent',
      dshHome: path.join(root, 'persistent-dsh-home'),
      packageName: 'dsh-tool-calculator',
      installSpec: oldSpec,
      installState: 'installed',
      installOutcome: 'awaiting_user_test',
      installed: true,
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
        reason: 'predecessor',
      },
    })
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
        predecessorInstallationId: predecessorId,
      },
    }, execution())
    expect(result.replacement?.state).toBe('new_present')
    expect(result.predecessorInstallationId).toBe(predecessorId)
    expect((await store.getInstallation(predecessorId)).supersededByInstallationId).toBe(result.id)
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

  it('does not pass provider, route, or expected-text into verifyHost', async () => {
    const routed = review({
      manifest: {
        ...review().manifest,
        expectedRoute: { provider: 'provider-alpha', model: 'model-alpha-v1' },
      },
      runtimeSurface: {
        ...attestedSurface(),
        expectedRoute: { provider: 'provider-alpha', model: 'model-alpha-v1' },
        llmRegistered: true,
        verificationLayer: 'manual_runtime',
      },
    })
    const { root, store, ctx } = await setup(routed)
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
      verificationTask: 'invoke nebula relay',
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
    const unattested = attestedReview({
      runtimeSurface: {
        ...attestedSurface(),
        toolFixtures: [{ tool: 'calculator', available: true, safe: true, hostValidated: false }],
        verificationLayer: 'manual_runtime',
      },
    })
    const { root, store, ctx } = await setup(unattested)
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
    const { root, store, ctx } = await setup(attestedReview())
    const { launcher } = launcherWithHost(hostPassedEvidence)
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
    const none = attestedReview({
      manifest: {
        ...review().manifest,
        packageName: 'dsh-subscription-auth',
        expectedTools: [],
      },
      runtimeSurface: attestedSurface([]),
    })
    const { root, store, ctx } = await setup(none)
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

    await putFrozenReview(root, store, review())
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
    const { root, store, ctx } = await setup(attestedReview())
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
    const { root, store, ctx } = await setup(attestedReview())
    const { launcher, verifyHost } = launcherWithHost(hostFailedEvidence)
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
    const launcher = {} as unknown as DshLauncher
    const installer = new PluginInstaller(ctx, config(root), store, launcher, async () => true)
    await expect(installer.install({
      reviewId: local.id,
      targetProfile: 'persistent',
      retention: 'persistent',
      expectedArtifactSha256: 'f'.repeat(64),
      verificationTask: 'test calculator',
    }, execution())).rejects.toThrow(/receipt does not match the reviewed frozen package/i)
  })

  it('verifies a Host tool round-trip without using expected-text substring or a model verifier', async () => {
    const { root, store, ctx } = await setup(attestedReview())
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

  it('does not consult a bound semantic verifier on the Host mechanical path', async () => {
    const { root, store, ctx } = await setup(attestedReview())
    const { launcher } = launcherWithHost(hostPassedEvidence)
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
    const bound = withApprovedVerdict(riskyReview())
    const { root, store } = await setup(bound)
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

  it('keeps missing or rejected semantic verdicts advisory when mechanical boundaries pass', async () => {
    const missing = riskyReview()
    const { root, store, ctx } = await setup(missing)
    const launcher = { install: async () => { throw new Error('must not install') } } as unknown as DshLauncher
    const installer = new PluginInstaller(ctx, config(root), store, launcher, async () => true, async () => undefined)
    const missingResult = await installer.install({
      reviewId: missing.id,
      targetProfile: 'web',
      retention: 'temporary',
      verificationTask: 'test calculator',
    }, execution())
    expect(missingResult).toMatchObject({ installOutcome: 'failed_absent', installFailure: { stage: 'install' } })

    const rejected = withApprovedVerdict(riskyReview())
    rejected.reviewerVerdict = { ...rejected.reviewerVerdict!, decision: 'rejected' }
    await putFrozenReview(root, store, rejected)
    const rejectedResult = await installer.install({
      reviewId: rejected.id,
      targetProfile: 'web',
      retention: 'temporary',
      verificationTask: 'test calculator',
    }, execution())
    expect(rejectedResult).toMatchObject({ installOutcome: 'failed_absent', installFailure: { stage: 'install' } })
  })

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
