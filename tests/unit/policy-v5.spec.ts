import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeConfig } from '../../src/config.js'
import {
  POLICY_VERSION,
  classifyRuntimeSurface,
  type InstallOutcome,
  type ResolutionRecord,
  type ReviewRecord,
  type VerificationLayerKind,
  type VerificationStatus,
  type VerificationVerdict,
} from '../../src/contracts.js'
import { CreationGuard } from '../../src/creation-guard.js'
import {
  POLICY_VERSION as exportedPolicyVersion,
  DshSemanticReviewerHost,
  DshSemanticVerifierHost,
  lifecycleStateFor,
} from '../../src/index.js'
import { selectInstallVerificationLayer } from '../../src/host-verification-driver.js'
import { PluginInstaller } from '../../src/lifecycle/install.js'
import type { DshLauncher } from '../../src/lifecycle/launcher.js'
import { assertDirectUseAllowed, isDirectlyUsableReview } from '../../src/review/direct-use.js'
import { _testing as serviceTesting } from '../../src/service.js'
import { verificationVerdictAllowsCompletion } from '../../src/semantic-verifier.js'
import { StateStore } from '../../src/state/store.js'
import { WORKFLOW_OPTIONS, type WorkflowHost } from '../../src/workflow/contracts.js'
import { WorkflowEngine } from '../../src/workflow/engine.js'

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((entry) => rm(entry, { recursive: true, force: true })))
})

function exec(sessionId = 'session-1'): ToolRunContext {
  return {
    callId: 'call-1',
    rootCallId: 'call-1',
    token: Symbol('call-1'),
    signal: new AbortController().signal,
    agent: {
      id: sessionId,
      session: { header: { id: sessionId, cwd: process.cwd(), version: 0, createdAt: 0 } },
    },
  } as unknown as ToolRunContext
}

function resolution(): ResolutionRecord {
  const id = `resolution_${'b'.repeat(24)}`
  return {
    schemaVersion: 2,
    id,
    policyVersion: POLICY_VERSION,
    createdAt: '2026-08-17T00:00:00.000Z',
    requirement: 'calculator',
    cwd: 'C:/workspace',
    decision: 'inspect_remote',
    localCandidates: [],
    remoteCandidates: [],
    remoteDiscoveryComplete: true,
    authorization: { state: 'selection_required', resolutionId: id, reason: 'wait' },
    queries: [],
    reasons: [],
  }
}

function review(policyVersion = POLICY_VERSION): ReviewRecord {
  return {
    schemaVersion: 1,
    id: `review_${'a'.repeat(64)}`,
    policyVersion,
    createdAt: '2026-08-19T00:00:00.000Z',
    resolutionId: resolution().id,
    requirement: 'calculator',
    sourceSnapshot: {
      kind: 'github',
      repository: 'acme/calculator',
      requestedRef: 'main',
      commit: 'c'.repeat(40),
      defaultBranch: 'main',
    },
    inspectedFiles: [],
    manifest: {
      kind: 'bundle',
      packageName: 'dsh-tool-calculator',
      bundlePatch: './cordis.patch.yml',
      scripts: [],
      dependencies: [],
      peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.1.0-rc.6 <0.2.0' },
      expectedTools: ['calculator'],
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

function host(store: StateStore, record: ResolutionRecord, applyDecision = vi.fn(async (current: ResolutionRecord) => current)): WorkflowHost {
  return {
    async bootstrapResolution(requirement) {
      const next = { ...record, requirement }
      await store.put('resolutions', next)
      return next
    },
    async discoverRemote(current) { return current },
    async ensureMarket(current) {
      return { resolution: current, market: { status: 'empty', reason: 'none' } }
    },
    async reviewGithub() { throw new Error('not used') },
    async reviewLocal() { throw new Error('not used') },
    async installReviewed() { throw new Error('must not install') },
    applyDecision,
    async applyNavigation(current, navigation) {
      const next = {
        ...current,
        authorization: {
          state: navigation.kind === 'stop' ? 'stopped' as const : current.authorization!.state,
          resolutionId: current.id,
          reason: navigation.kind,
        },
      }
      await store.put('resolutions', next)
      return next
    },
    async latestReview() { return undefined },
    getResolution(id) { return store.getResolution(id) },
    getReview(id) { return store.getReview(id) },
    getInstallation(id) { return store.getInstallation(id) },
  }
}

describe('Policy V8 legacy invalidation', () => {
  it('exports Policy V8 contracts and semantic hosts for consumers', () => {
    expect(POLICY_VERSION).toBe('8')
    expect(exportedPolicyVersion).toBe('8')
    expect(typeof DshSemanticReviewerHost).toBe('function')
    expect(typeof DshSemanticVerifierHost).toBe('function')
    expect(typeof lifecycleStateFor).toBe('function')
    const layers: VerificationLayerKind[] = ['bundle_activation', 'tool_roundtrip', 'manual_runtime']
    const statuses: VerificationStatus[] = [
      'passed',
      'pending_user_test',
      'blocked_precondition',
      'failed',
      'uncertain',
    ]
    const outcomes: InstallOutcome[] = [
      'pending',
      'verified',
      'failed_absent',
      'recovery_required',
      'activated',
      'awaiting_user_test',
    ]
    expect(layers).toHaveLength(3)
    expect(statuses).toHaveLength(5)
    expect(outcomes).toContain('activated')
    expect(outcomes).toContain('awaiting_user_test')
    expect(classifyRuntimeSurface({
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
    })).toBe('bundle_activation')
  })

  it('requires Host-validated fixtures for tool_roundtrip and treats plugin-declared safe as manual_runtime', () => {
    const facts = {
      llmDependency: false,
      llmRegistered: false,
      credentialsDependency: false,
      credentialsRegistered: false,
      networkSignal: false,
      environmentSignal: false,
      processSignal: false,
      skillOnly: false,
      unsafeTools: false,
      expectedTools: ['calculator'] as const,
      kind: 'bundle' as const,
    }
    expect(classifyRuntimeSurface({
      ...facts,
      toolFixtures: [{ tool: 'calculator', available: true, safe: true, hostValidated: false }],
    })).toBe('manual_runtime')
    expect(classifyRuntimeSurface({
      ...facts,
      toolFixtures: [{ tool: 'calculator', available: true, safe: true, hostValidated: true }],
    })).toBe('tool_roundtrip')
    expect(classifyRuntimeSurface({
      ...facts,
      expectedTools: [],
      toolFixtures: [],
      llmDependency: true,
    })).toBe('manual_runtime')
    expect(classifyRuntimeSurface({
      ...facts,
      expectedTools: [],
      toolFixtures: [],
      environmentSignal: true,
    })).toBe('manual_runtime')
  })

  it('selects Host verification layers without treating candidate safe:true or expectedRoute as drivers', () => {
    const current = review()
    expect(selectInstallVerificationLayer({
      review: current,
      declaredFixtures: { calculator: { safe: true } },
    }).layer).toBe('manual_runtime')
    expect(selectInstallVerificationLayer({
      review: current,
      declaredFixtures: { calculator: { arguments: { expression: '1+1' }, safe: true } },
    })).toMatchObject({ layer: 'manual_runtime', fixtures: [] })
    const hostAttested = review()
    hostAttested.runtimeSurface = {
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
    }
    expect(selectInstallVerificationLayer({
      review: hostAttested,
      declaredFixtures: { calculator: { arguments: { expression: '1+1' } } },
    }).fixtures[0]).toEqual({ tool: 'calculator', arguments: { expression: '1+1' } })
    const routed = review()
    routed.manifest = { ...routed.manifest, expectedRoute: { provider: 'xai-oauth', model: 'grok-4.5' } }
    expect(selectInstallVerificationLayer({
      review: routed,
      declaredFixtures: { calculator: { arguments: { expression: '1+1' } } },
    }).layer).toBe('manual_runtime')
  })

  it('keeps old reviews readable but never usable for use/install', () => {
    const current = review()
    const legacy = review('4')
    legacy.reviewerVerdict = {
      requestId: `reviewer_${'1'.repeat(24)}`,
      reviewId: legacy.id,
      requirementHash: '2'.repeat(64),
      snapshotDigest: '3'.repeat(64),
      candidateDigest: '4'.repeat(64),
      reviewerSessionId: 'reviewer-session',
      reviewerVersion: '1',
      decision: 'approved',
      evidence: ['old'],
      conditions: [],
      semanticCoverage: 'full',
      createdAt: '2026-08-19T00:00:03.000Z',
    }
    expect(isDirectlyUsableReview(legacy)).toBe(false)
    expect(() => assertDirectUseAllowed(legacy)).toThrow(/predates the current policy/i)
    expect(isDirectlyUsableReview(current)).toBe(true)

    const oldResolution = resolution()
    oldResolution.policyVersion = '4'
    oldResolution.decisions = [{
      id: `decision_${'a'.repeat(24)}`,
      phase: 'gate2',
      action: 'create_new',
      selectedRepositories: [],
      createdAt: '2026-08-17T00:00:00.000Z',
    }]
    oldResolution.authorization = {
      state: 'create_authorized',
      resolutionId: oldResolution.id,
      reason: 'stale create grant',
    }
    expect(serviceTesting.authorizationForResolution(oldResolution, []).state).toBe('selection_required')
  })

  it('rejects an old-policy review at the installer even with a verified-looking verifier receipt', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-policy-old-review-'))
    temporary.push(root)
    const store = new StateStore(root)
    const legacy = review('4')
    await store.put('reviews', legacy)
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const launcher = {
      install: async () => { throw new Error('must not install') },
    } as unknown as DshLauncher
    const verifier = {
      run: vi.fn(async () => {
        throw new Error('verifier must not override a legacy review')
      }),
    }
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
    await expect(installer.install({
      reviewId: legacy.id,
      targetProfile: 'web',
      retention: 'temporary',
      verificationTask: 'test calculator',
    }, exec())).rejects.toThrow(/predates the current policy/i)
    expect(verifier.run).not.toHaveBeenCalled()
  })

  it('does not execute old interrupt/decision/receipt/verdict/commitment/lease on resume', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-policy-resume-'))
    temporary.push(root)
    const store = new StateStore(root)
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_engine' })
    const record = resolution()
    const applyDecision = vi.fn(async (current: ResolutionRecord) => current)
    const installReviewed = vi.fn(async () => {
      throw new Error('must not install')
    })
    const engine = new WorkflowEngine(store, guard, {
      ...host(store, record, applyDecision),
      installReviewed,
    })
    const turn = exec()
    const started = await engine.start('calculator', turn)
    const legacy = await store.getWorkflow(started.workflow.id)
    const interruptId = legacy.interrupt!.interruptId
    legacy.policyVersion = '4'
    legacy.selectionReceipt = {
      id: 'receipt_legacy',
      workflowId: legacy.id,
      interruptId,
      snapshotDigest: 'a'.repeat(64),
      kind: 'use_this',
      candidateIds: [`candidate_${'c'.repeat(24)}`],
      candidateDigests: {},
      hostTurnId: 'turn_legacy',
      ownerSessionId: 'session-1',
      bootId: 'boot_engine',
      createdAt: '2026-08-17T00:00:00.000Z',
    }
    legacy.actionCommitment = {
      id: 'commit_legacy',
      selectionReceiptId: 'receipt_legacy',
      snapshotDigest: 'a'.repeat(64),
      frozenIdentity: { kind: 'none' },
      requestedAction: 'use_this',
      endpoint: { kind: 'none' },
      allowedParameterConstraints: {},
      createdAt: '2026-08-17T00:00:00.000Z',
    }
    legacy.executionLease = {
      id: 'lease_legacy',
      commitmentId: 'commit_legacy',
      selectionReceiptId: 'receipt_legacy',
      workflowId: legacy.id,
      ownerSessionId: 'session-1',
      bootId: 'boot_engine',
      hostTurnId: 'turn_legacy',
      interruptId,
      snapshotDigest: 'a'.repeat(64),
      requestedAction: 'use_this',
      endpoint: { kind: 'none' },
      allowedParameterConstraints: {},
      createdAt: '2026-08-17T00:00:00.000Z',
    }
    await store.put('workflows', legacy)

    const beforeForeignResume = await store.getWorkflow(legacy.id)
    await expect(engine.resume({
      workflowId: legacy.id,
      interruptId,
      decision: { action: 'use_this', candidateId: `candidate_${'c'.repeat(24)}` },
    }, exec('session-foreign'))).rejects.toThrow(/different owner session/i)
    expect(await store.getWorkflow(legacy.id)).toEqual(beforeForeignResume)

    const restarted = await engine.resume({
      workflowId: legacy.id,
      interruptId,
      decision: { action: 'use_this', candidateId: `candidate_${'c'.repeat(24)}` },
    }, turn)
    expect(applyDecision).not.toHaveBeenCalled()
    expect(installReviewed).not.toHaveBeenCalled()
    expect(restarted.lifecycleState).toBe('interrupted')
    expect(restarted.workflow.status).toBe('completed')
    expect(restarted.workflow.policyVersion).toBe('4')
    expect(restarted.lifecycleState).not.toBe('verified')
    expect(restarted.workflow.interrupt).toBeUndefined()
    expect(restarted.workflow.selectionReceipt).toBeUndefined()
    expect(restarted.workflow.actionCommitment).toBeUndefined()
    expect(restarted.workflow.executionLease).toBeUndefined()
    expect(restarted.workflow.lastFailure).toMatchObject({
      stage: 'workflow',
      code: 'policy_restart_required',
      retryable: false,
    })

    const staleVerdict: VerificationVerdict = {
      requestId: 'verifier_legacy',
      installationId: `installation_${'c'.repeat(24)}`,
      reviewId: review('4').id,
      requirementHash: '8'.repeat(64),
      evidenceDigest: '9'.repeat(64),
      verifierSessionId: 'verifier-session',
      verifierVersion: '1',
      decision: 'verified',
      evidence: ['legacy'],
      conditions: [],
      createdAt: '2026-08-19T00:00:02.000Z',
    }
    expect(verificationVerdictAllowsCompletion(staleVerdict, {
      installationId: staleVerdict.installationId,
      reviewId: review().id,
      requirement: 'calculator',
      evidenceDigest: '1'.repeat(64),
    })).toBe(false)
  })

  it('does not migrate unfinished V7 execution authorization onto Policy V8', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-policy-v7-resume-'))
    temporary.push(root)
    const store = new StateStore(root)
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_engine' })
    const record = resolution()
    const applyDecision = vi.fn(async (current: ResolutionRecord) => current)
    const installReviewed = vi.fn(async () => {
      throw new Error('must not install')
    })
    const engine = new WorkflowEngine(store, guard, {
      ...host(store, record, applyDecision),
      installReviewed,
    })
    const turn = exec()
    const started = await engine.start('calculator', turn)
    const legacy = await store.getWorkflow(started.workflow.id)
    const interruptId = legacy.interrupt!.interruptId
    legacy.policyVersion = '7'
    legacy.actionCommitment = {
      id: 'commit_v7',
      selectionReceiptId: 'receipt_v7',
      snapshotDigest: 'a'.repeat(64),
      frozenIdentity: { kind: 'none' },
      requestedAction: 'use_this',
      endpoint: { kind: 'none' },
      allowedParameterConstraints: {},
      createdAt: '2026-08-17T00:00:00.000Z',
    }
    legacy.executionLease = {
      id: 'lease_v7',
      commitmentId: 'commit_v7',
      selectionReceiptId: 'receipt_v7',
      workflowId: legacy.id,
      ownerSessionId: 'session-1',
      bootId: 'boot_engine',
      hostTurnId: 'turn_v7',
      interruptId,
      snapshotDigest: 'a'.repeat(64),
      requestedAction: 'use_this',
      endpoint: { kind: 'none' },
      allowedParameterConstraints: {},
      createdAt: '2026-08-17T00:00:00.000Z',
    }
    await store.put('workflows', legacy)

    const restarted = await engine.resume({
      workflowId: legacy.id,
      interruptId,
      decision: { action: 'use_this', candidateId: `candidate_${'c'.repeat(24)}` },
    }, turn)
    expect(applyDecision).not.toHaveBeenCalled()
    expect(installReviewed).not.toHaveBeenCalled()
    expect(restarted.lifecycleState).toBe('interrupted')
    expect(restarted.workflow.status).toBe('completed')
    expect(restarted.workflow.policyVersion).toBe('7')
    expect(restarted.workflow.actionCommitment).toBeUndefined()
    expect(restarted.workflow.executionLease).toBeUndefined()
    expect(restarted.workflow.lastFailure).toMatchObject({
      stage: 'workflow',
      code: 'policy_restart_required',
      retryable: false,
    })
  })

  it('starts a fresh V8 workflow instead of replaying an unfinished old-policy one', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-policy-start-'))
    temporary.push(root)
    const store = new StateStore(root)
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_engine' })
    const record = resolution()
    const applyDecision = vi.fn(async (current: ResolutionRecord) => current)
    const engine = new WorkflowEngine(store, guard, host(store, record, applyDecision))
    const turn = exec()
    const started = await engine.start('calculator', turn)
    const legacy = await store.getWorkflow(started.workflow.id)
    legacy.policyVersion = '7'
    await store.put('workflows', legacy)

    const fresh = await engine.start('calculator', turn)
    expect(fresh.workflow.id).not.toBe(legacy.id)
    expect(fresh.workflow.policyVersion).toBe(POLICY_VERSION)
    expect(fresh.lifecycleState).toBe('awaiting_confirmation')
    const parked = await store.getWorkflow(legacy.id)
    expect(parked.status).toBe('completed')
    expect(parked.lastFailure?.code).toBe('policy_restart_required')
    expect(parked.interrupt).toBeUndefined()
    expect(applyDecision).not.toHaveBeenCalled()
  })

  it('presents use_this and search_more as primary confirmation actions', () => {
    expect(WORKFLOW_OPTIONS.use_this.placement).toBe('primary')
    expect(WORKFLOW_OPTIONS.review_existing.placement).toBe('primary')
    expect(WORKFLOW_OPTIONS.search_more.placement).toBe('primary')
    expect(WORKFLOW_OPTIONS.modify_this.placement).toBe('advanced')
    expect(WORKFLOW_OPTIONS.create_new.placement).toBe('advanced')
    expect(WORKFLOW_OPTIONS.stop.placement).toBe('recovery')
  })
})
