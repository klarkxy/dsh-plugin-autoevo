import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { testResolution, testReview } from '../helpers/records.js'
import { testRuntimeConfig } from '../helpers/runtime-config.js'
import { trackTempDirs } from '../helpers/temp-dirs.js'
import type { RuntimeConfig } from '../../src/config.js'
import {
  POLICY_VERSION,
  classifyRuntimeSurface,
  type ResolutionRecord,
  type ReviewRecord,
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
import { isDirectlyUsableReview } from '../../src/review/direct-use.js'
import { _testing as serviceTesting } from '../../src/service.js'
import { StateStore } from '../../src/state/store.js'
import { WORKFLOW_OPTIONS, type WorkflowHost } from '../../src/workflow/contracts.js'
import { WorkflowEngine } from '../../src/workflow/engine.js'

const temporary = trackTempDirs()

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
  const record = testResolution({
    createdAt: '2026-08-17T00:00:00.000Z',
    remoteCandidates: [],
    authorization: { state: 'selection_required', resolutionId: id, reason: 'wait' },
  })
  delete record.selectedRepositories
  return record
}

function review(policyVersion = POLICY_VERSION): ReviewRecord {
  return testReview({ policyVersion, createdAt: '2026-08-19T00:00:00.000Z', resolutionId: resolution().id })
}

function config(root: string): RuntimeConfig {
  return testRuntimeConfig(root, { dshHome: path.join(root, 'persistent-dsh-home') })
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
    async listInstallProfiles() { return ['web'] },
    managedWorkAvailable() { return true },
    async refineRemote(current) { return current },
    async previewGithubCandidates() { return { previews: [], failures: [] } },
    async reviewExisting() { throw new Error('not used') },
    async reviewGithubBatch() { throw new Error('not used') },
    async prepareModify() { throw new Error('not used') },
    async prepareCreate() { throw new Error('not used') },
    async finishManagedWork() { throw new Error('not used') },
  }
}

describe('Policy V14 legacy invalidation', () => {
  it('exports Policy V14 contracts and semantic hosts for consumers', () => {
    expect(POLICY_VERSION).toBe('14')
    expect(exportedPolicyVersion).toBe('14')
    expect(typeof DshSemanticReviewerHost).toBe('function')
    expect(typeof DshSemanticVerifierHost).toBe('function')
    expect(typeof lifecycleStateFor).toBe('function')
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
    routed.manifest = { ...routed.manifest, expectedRoute: { provider: 'provider-alpha', model: 'model-alpha-v1' } }
    expect(selectInstallVerificationLayer({
      review: routed,
      declaredFixtures: { calculator: { arguments: { expression: '1+1' } } },
    }).layer).toBe('manual_runtime')
  })

  it('keeps old reviews readable but never usable for use/install', () => {
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

  it.each(['4', '7'] as const)(
    'does not execute old interrupt/decision/receipt/commitment/lease on resume (policy %s)',
    async (policyVersion) => {
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
      }, false)
      const turn = exec()
      const started = await engine.start('calculator', turn)
      const legacy = await store.getWorkflow(started.workflow.id)
      const interruptId = legacy.interrupt!.interruptId
      legacy.policyVersion = policyVersion
      legacy.selectionReceipt = {
        id: `receipt_${policyVersion}`,
        workflowId: legacy.id,
        interruptId,
        snapshotDigest: 'a'.repeat(64),
        kind: 'use_this',
        candidateIds: [`candidate_${'c'.repeat(24)}`],
        candidateDigests: {},
        hostTurnId: `turn_${policyVersion}`,
        ownerSessionId: 'session-1',
        bootId: 'boot_engine',
        createdAt: '2026-08-17T00:00:00.000Z',
      }
      legacy.actionCommitment = {
        id: `commit_${policyVersion}`,
        selectionReceiptId: `receipt_${policyVersion}`,
        snapshotDigest: 'a'.repeat(64),
        frozenIdentity: { kind: 'none' },
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
      expect(restarted.workflow.policyVersion).toBe(policyVersion)
      expect(restarted.lifecycleState).not.toBe('verified')
      expect(restarted.workflow.interrupt).toBeUndefined()
      expect(restarted.workflow.selectionReceipt).toBeUndefined()
      expect(restarted.workflow.actionCommitment).toBeUndefined()
      expect(restarted.workflow.lastFailure).toMatchObject({
        stage: 'workflow',
        code: 'policy_restart_required',
        retryable: false,
      })
    },
  )

  it('starts a fresh V14 workflow instead of replaying an unfinished old-policy one', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-policy-start-'))
    temporary.push(root)
    const store = new StateStore(root)
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_engine' })
    const record = resolution()
    const applyDecision = vi.fn(async (current: ResolutionRecord) => current)
    const engine = new WorkflowEngine(store, guard, host(store, record, applyDecision), false)
    const turn = exec()
    const started = await engine.start('calculator', turn)
    const legacy = await store.getWorkflow(started.workflow.id)
    legacy.policyVersion = '7'
    await store.put('workflows', legacy)

    const fresh = await engine.start('calculator', turn)
    expect(fresh.workflow.id).not.toBe(legacy.id)
    expect(fresh.workflow.policyVersion).toBe(POLICY_VERSION)
    expect(fresh.lifecycleState).toBe('selected')
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
