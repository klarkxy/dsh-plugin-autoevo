import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { POLICY_VERSION, type InstallationRecord, type ResolutionRecord } from '../../src/contracts.js'
import { CreationGuard } from '../../src/creation-guard.js'
import { EvolutionError } from '../../src/errors.js'
import { StateStore } from '../../src/state/store.js'
import { WorkflowEngine } from '../../src/workflow/engine.js'
import type { WorkflowHost, WorkflowRecord, WorkflowView } from '../../src/workflow/contracts.js'

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

function resolution(requirement = 'calculator'): ResolutionRecord {
  const id = `resolution_${'b'.repeat(24)}`
  return {
    schemaVersion: 2,
    id,
    policyVersion: POLICY_VERSION,
    createdAt: '2026-08-17T00:00:00.000Z',
    requirement,
    cwd: 'C:/workspace',
    decision: 'use_local',
    localCandidates: [{
      kind: 'tool',
      name: 'pwsh',
      description: 'Run a PowerShell command',
      availability: 'available',
      confidence: 0.9,
      fit: 'full',
    }],
    remoteCandidates: [],
    remoteDiscoveryComplete: true,
    authorization: { state: 'selection_required', resolutionId: id, reason: 'wait' },
    queries: [],
    reasons: ['local hit'],
  }
}

function host(store: StateStore, record: ResolutionRecord): WorkflowHost {
  return {
    async bootstrapResolution(requirement) {
      const next = { ...record, requirement }
      await store.put('resolutions', next)
      return next
    },
    async discoverRemote(current) {
      return current
    },
    async ensureMarket(current) {
      return { resolution: current, market: { status: 'empty', reason: 'none' } }
    },
    async reviewGithub() {
      throw new Error('not used')
    },
    async reviewLocal() {
      throw new Error('not used')
    },
    async installReviewed() {
      throw new Error('not used')
    },
    async applyDecision(current) {
      return current
    },
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
    async latestReview() {
      return undefined
    },
    getResolution(id) {
      return store.getResolution(id)
    },
    getReview(id) {
      return store.getReview(id)
    },
    getInstallation(id) {
      return store.getInstallation(id)
    },
  }
}

async function startAndPresent(
  engine: WorkflowEngine,
  requirement: string,
  turn: ToolRunContext,
  count = 1,
): Promise<{ discovery: WorkflowView; selection: WorkflowView }> {
  const discovery = await engine.start(requirement, turn)
  const candidateIds = discovery.workflow.discoveryPool!.slice(0, count).map((item) => item.id)
  const selection = await engine.present({ workflowId: discovery.workflow.id, candidateIds }, turn)
  return { discovery, selection }
}

describe('workflow engine autonomous discovery', () => {
  it('starts at a model-controlled discovery checkpoint without an interrupt or candidate snapshot', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-engine-discovery-'))
    temporary.push(root)
    const store = new StateStore(root)
    const engine = new WorkflowEngine(store, new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_engine' }), host(store, resolution()))

    const view = await engine.start('run a PowerShell command', exec())

    expect(view.workflow).toMatchObject({ status: 'interrupted', cursor: 'await_discovery', generation: 1 })
    expect(view.workflow.interrupt).toBeUndefined()
    expect(view.workflow.candidateSnapshot).toBeUndefined()
    expect(view.workflow.discoveryPool).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'local', localName: 'pwsh', fit: 'full' }),
    ]))
    expect(view.workflow.discoveryBudget).toEqual({
      refinementRoundsUsed: 0,
      refinementQueriesUsed: [],
      explicitRepositories: [],
      maxRefinementRounds: 2,
      maxRefinementQueries: 5,
      maxCandidates: 20,
    })
    expect((await store.getWorkflow(view.workflow.id)).resolutionId).toBe(resolution().id)
  })

  it('binds profile install/configuration evidence into local candidate snapshots', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-engine-profile-evidence-'))
    temporary.push(root)
    const record = resolution('@dsh-external/dsh-conv-export')
    record.localCandidates[0] = {
      kind: 'plugin',
      name: '@dsh-external/dsh-conv-export',
      description: 'client conversation export',
      availability: 'installed_in_profile',
      confidence: 0.99,
      fit: 'full',
      profileEvidence: {
        source: 'host_profile_manifest',
        profile: 'web',
        packageName: '@dsh-external/dsh-conv-export',
        dependencySpec: 'workspace:*',
        configuredBundle: true,
      },
    }
    const store = new StateStore(root)
    const engine = new WorkflowEngine(store, new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_engine' }), host(store, record))
    const view = await engine.start(record.requirement, exec())
    const candidate = view.workflow.discoveryPool![0]!
    expect(candidate.installation).toEqual({
      source: 'host_profile_manifest',
      profile: 'web',
      package_name: '@dsh-external/dsh-conv-export',
      dependency_spec: 'workspace:*',
      configured_bundle: true,
    })

    const changed = { ...record, localCandidates: [{
      ...record.localCandidates[0]!,
      profileEvidence: { ...record.localCandidates[0]!.profileEvidence!, configuredBundle: false },
    }] }
    const secondRoot = await mkdtemp(path.join(os.tmpdir(), 'autoevo-engine-profile-digest-'))
    temporary.push(secondRoot)
    const secondStore = new StateStore(secondRoot)
    const second = new WorkflowEngine(secondStore, new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_engine' }), host(secondStore, changed))
    const changedView = await second.start(changed.requirement, exec('session-2'))
    expect(changedView.workflow.discoveryPool![0]!.digest).not.toBe(candidate.digest)
  })

  it('present seals one to five pool candidates into Gate 1 and blocks same-turn resume', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-engine-present-'))
    temporary.push(root)
    const store = new StateStore(root)
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_engine' })
    const engine = new WorkflowEngine(store, guard, host(store, resolution()))
    const turn = exec()
    const { discovery, selection } = await startAndPresent(engine, 'calculator', turn)

    expect(selection.workflow).toMatchObject({ status: 'interrupted', cursor: 'await_selection' })
    expect(selection.workflow.interrupt?.kind).toBe('await_selection')
    expect(selection.workflow.candidateSnapshot?.map((item) => item.id)).toEqual([
      discovery.workflow.discoveryPool![0]!.id,
    ])
    const parked = await engine.resume({
      workflowId: selection.workflow.id,
      interruptId: selection.workflow.interrupt!.interruptId,
      navigation: { kind: 'stop' },
    }, turn)
    expect(parked).toMatchObject({ status: 'parked', alreadyWaiting: true })
    expect(parked.workflow.consumedInterruptIds).toEqual([])
  })

  it('rejects invalid presentation sizes, duplicate ids, and candidates outside the discovery pool', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-engine-present-invalid-'))
    temporary.push(root)
    const store = new StateStore(root)
    const engine = new WorkflowEngine(store, new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_engine' }), host(store, resolution()))
    const discovery = await engine.start('calculator', exec())
    const id = discovery.workflow.discoveryPool![0]!.id

    await expect(engine.present({ workflowId: discovery.workflow.id, candidateIds: [] }, exec())).rejects.toThrow(/one to five/i)
    await expect(engine.present({
      workflowId: discovery.workflow.id,
      candidateIds: Array.from({ length: 6 }, (_, index) => `candidate_${String(index).padStart(24, '0')}`),
    }, exec())).rejects.toThrow(/one to five/i)
    await expect(engine.present({ workflowId: discovery.workflow.id, candidateIds: [id, id] }, exec())).rejects.toThrow(/unique/i)
    await expect(engine.present({ workflowId: discovery.workflow.id, candidateIds: [`candidate_${'f'.repeat(24)}`] }, exec())).rejects.toThrow(/discovery pool/i)
    expect((await store.getWorkflow(discovery.workflow.id)).cursor).toBe('await_discovery')
  })

  it('refines only at discovery, records its budget, and fails closed at the round cap', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-engine-refine-'))
    temporary.push(root)
    const store = new StateStore(root)
    const record = resolution()
    record.decision = 'inspect_remote'
    const base = host(store, record)
    const refineRemote = vi.fn(async (current: ResolutionRecord, input: { queries: string[]; repositories: string[] }) => {
      const next = {
        ...current,
        queries: [...current.queries, ...input.queries],
        remoteCandidates: [{ repository: `acme/${input.queries[0] ?? input.repositories[0]}`, name: 'remote', description: '', stars: 1, updatedAt: null, topics: [] }],
      }
      await store.put('resolutions', next)
      return next
    })
    const engine = new WorkflowEngine(store, new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_engine' }), { ...base, refineRemote })
    const turn = exec()
    const started = await engine.start('calculator', turn)
    const first = await engine.refine({ workflowId: started.workflow.id, queries: ['calculator plugin'] }, turn)
    const second = await engine.refine({ workflowId: started.workflow.id, repositories: ['acme/calculator'] }, turn)

    expect(refineRemote).toHaveBeenCalledTimes(2)
    expect(second.workflow).toMatchObject({ cursor: 'await_discovery', status: 'interrupted' })
    expect(second.workflow.discoveryBudget).toMatchObject({
      refinementRoundsUsed: 2,
      refinementQueriesUsed: ['calculator plugin'],
      explicitRepositories: ['acme/calculator'],
    })
    expect(second.workflow.discoveryPool).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'remote' })]))
    await expect(engine.refine({ workflowId: first.workflow.id, queries: ['one more'] }, turn)).rejects.toThrow(/round budget/i)
  })

  it('enforces the five-query discovery budget before calling the Host', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-engine-query-budget-'))
    temporary.push(root)
    const store = new StateStore(root)
    const record = resolution()
    const base = host(store, record)
    const refineRemote = vi.fn(async (current: ResolutionRecord) => current)
    const engine = new WorkflowEngine(store, new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_engine' }), { ...base, refineRemote })
    const started = await engine.start('calculator', exec())

    await engine.refine({ workflowId: started.workflow.id, queries: ['one', 'two', 'three', 'four', 'five'] }, exec())
    await expect(engine.refine({ workflowId: started.workflow.id, queries: ['six'] }, exec())).rejects.toThrow(/query budget/i)
    expect(refineRemote).toHaveBeenCalledTimes(1)
  })

  it('opens a stop/search gate when refinement is exhausted without a reviewable candidate', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-engine-exhausted-empty-'))
    temporary.push(root)
    const store = new StateStore(root)
    const record = resolution()
    record.localCandidates[0] = { ...record.localCandidates[0]!, fit: 'partial' }
    record.remoteDiscoveryComplete = false
    const base = host(store, record)
    const refineRemote = vi.fn(async (current: ResolutionRecord) => current)
    const engine = new WorkflowEngine(
      store,
      new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_engine' }),
      { ...base, refineRemote },
    )
    const turn = exec()
    const started = await engine.start('calculator', turn)

    await engine.refine({ workflowId: started.workflow.id, queries: ['first'] }, turn)
    const exhausted = await engine.refine({ workflowId: started.workflow.id, queries: ['second'] }, turn)

    expect(exhausted.workflow).toMatchObject({ cursor: 'await_confirmation', status: 'interrupted' })
    expect(exhausted.workflow.candidateSnapshot).toEqual([])
    expect(exhausted.workflow.interrupt?.options.map((option) => option.id)).toEqual(['search_more', 'stop'])
  })

  it('returns search_more from Gate 1 to autonomous discovery without retaining the sealed snapshot', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-engine-search-more-'))
    temporary.push(root)
    const store = new StateStore(root)
    const record = resolution()
    record.decision = 'inspect_remote'
    record.remoteCandidates = [
      { repository: 'acme/one', name: 'one', description: '', stars: 2, updatedAt: null, topics: [] },
      { repository: 'acme/two', name: 'two', description: '', stars: 1, updatedAt: null, topics: [] },
    ]
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_engine' })
    const engine = new WorkflowEngine(store, guard, host(store, record))
    const turn = exec()
    const { selection } = await startAndPresent(engine, 'calculator', turn, 2)
    const firstIds = selection.workflow.candidateSnapshot!.map((item) => item.id)
    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: '再找找' }] })

    const more = await engine.resume({
      workflowId: selection.workflow.id,
      interruptId: selection.workflow.interrupt!.interruptId,
      navigation: { kind: 'search_more' },
    }, turn)

    expect(more.workflow).toMatchObject({ status: 'interrupted', cursor: 'await_discovery' })
    expect(more.workflow.interrupt).toBeUndefined()
    expect(more.workflow.candidateSnapshot).toBeUndefined()
    expect(more.workflow.seenCandidateIds).toEqual(expect.arrayContaining(firstIds))
    expect(more.workflow.rejectedCandidateIds).toEqual(expect.arrayContaining(firstIds))
  })

  it('permits local reuse only after Gate 1 and binds the receipt and lease to the sealed candidate', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-engine-reuse-'))
    temporary.push(root)
    const store = new StateStore(root)
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_engine' })
    const engine = new WorkflowEngine(store, guard, host(store, resolution()))
    const turn = exec()
    const { selection } = await startAndPresent(engine, 'calculator', turn)
    const candidate = selection.workflow.candidateSnapshot![0]!
    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: '用已有的' }] })

    const reused = await engine.resume({
      workflowId: selection.workflow.id,
      interruptId: selection.workflow.interrupt!.interruptId,
      decision: { action: 'use_this', candidateId: candidate.id },
    }, turn)

    expect(reused.workflow).toMatchObject({ status: 'completed', cursor: 'reuse_local' })
    expect(reused.workflow.selectionReceipt).toMatchObject({ kind: 'reuse_local', candidateIds: [candidate.id] })
    expect(reused.workflow.selectionReceipt?.candidateDigests[candidate.id]).toBe(candidate.digest)
    expect(reused.workflow.executionLease).toMatchObject({ candidateId: candidate.id, candidateDigest: candidate.digest, endpoint: { kind: 'exact_tool', name: 'pwsh' } })
  })

  it('keeps Gate 1 candidate scope sealed for navigation and leaves authorization unconsumed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-engine-scope-'))
    temporary.push(root)
    const store = new StateStore(root)
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_engine' })
    const engine = new WorkflowEngine(store, guard, host(store, resolution()))
    const turn = exec()
    const { selection } = await startAndPresent(engine, 'calculator', turn)
    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: '用别的' }] })

    const invalid = await engine.resume({
      workflowId: selection.workflow.id,
      interruptId: selection.workflow.interrupt!.interruptId,
      navigation: { kind: 'reuse_local', candidateIds: [`candidate_${'f'.repeat(24)}`] },
    }, turn)

    expect(invalid.status).toBe('invalid_resume')
    expect(invalid.resumeHint).toMatch(/outside the current candidate snapshot/i)
    expect((await store.getWorkflow(selection.workflow.id)).consumedInterruptIds).toEqual([])
  })

  it('blocks the duplicate invalid action fingerprint after two same-turn attempts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-engine-invalid-breaker-'))
    temporary.push(root)
    const store = new StateStore(root)
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_engine' })
    const engine = new WorkflowEngine(store, guard, host(store, resolution()))
    const turn = exec()
    const { selection } = await startAndPresent(engine, 'calculator', turn)
    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: '停' }] })
    const input = {
      workflowId: selection.workflow.id,
      interruptId: selection.workflow.interrupt!.interruptId,
      navigation: { kind: 'reuse_local' as const, candidateIds: [`candidate_${'f'.repeat(24)}`] },
    }

    const first = await engine.resume(input, turn)
    const second = await engine.resume(input, turn)
    const blocked = await engine.resume(input, turn)

    expect(first.resumeHint).not.toMatch(/Repeated invalid action/i)
    expect(second.resumeHint).toMatch(/Repeated invalid action is blocked/i)
    expect(blocked.resumeHint).toMatch(/^Repeated invalid action is blocked until a fresh user turn\./i)
    expect(blocked.workflow.invalidResumeAttempt).toMatchObject({ count: 2 })
    expect(blocked.workflow.consumedInterruptIds).toEqual([])
  })

  it('diagnoses incomplete discovery without changing the autonomous checkpoint', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-engine-diagnose-'))
    temporary.push(root)
    const store = new StateStore(root)
    const record = resolution()
    record.remoteDiscoveryComplete = false
    record.reasons = [
      'Finder failed at C:\\Users\\Jane Doe\\token.txt; '
      + '\\\\server\\share\\private key.txt; /home/alice/.config/token; '
      + 'api_key=top-secret; see https://example.test/?token=abc',
    ]
    const engine = new WorkflowEngine(store, new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_engine' }), host(store, record))
    const started = await engine.start('calculator', exec())

    const diagnosed = await engine.diagnose({ workflowId: started.workflow.id, probes: ['discovery'] }, exec())

    expect(diagnosed.diagnosis?.facts).toEqual([expect.objectContaining({ probe: 'discovery', status: 'failed', code: 'search_incomplete' })])
    expect(JSON.stringify(diagnosed.diagnosis)).not.toContain('secret')
    expect(JSON.stringify(diagnosed.diagnosis)).not.toContain('Jane Doe')
    expect(JSON.stringify(diagnosed.diagnosis)).not.toContain('server')
    expect(JSON.stringify(diagnosed.diagnosis)).not.toContain('/home/alice')
    expect(JSON.stringify(diagnosed.diagnosis)).not.toContain('token=abc')
    expect(diagnosed.workflow).toMatchObject({ status: 'interrupted', cursor: 'await_discovery', generation: started.workflow.generation })
    const second = await engine.diagnose({ workflowId: started.workflow.id, probes: ['review'] }, exec())
    expect(second.diagnosis?.budget).toMatchObject({ maxCalls: 2, usedCalls: 2, maxProbes: 8, usedProbes: 2 })
    await expect(engine.diagnose({ workflowId: started.workflow.id, probes: ['discovery'] }, exec()))
      .rejects.toThrow(/call budget is exhausted/i)
  })

  it('cleans the exact linked installation and starts a new audited workflow after a fresh user recovery request', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-engine-recover-'))
    temporary.push(root)
    const store = new StateStore(root)
    const record = resolution('calculator')
    await store.put('resolutions', record)
    const workflowId = `workflow_${'a'.repeat(24)}`
    const installationId = `installation_${'d'.repeat(24)}`
    const installation: InstallationRecord = {
      schemaVersion: 1,
      id: installationId,
      createdAt: '2026-08-21T00:00:00.000Z',
      reviewId: `review_${'e'.repeat(24)}`,
      workflowId,
      targetProfile: 'headless',
      retention: 'persistent',
      dshHome: root,
      packageName: 'dsh-plugin-demo',
      installSpec: 'file:demo.tgz',
      installState: 'installed',
      installOutcome: 'recovery_required',
      installed: false,
      loaded: false,
      verified: false,
      restartRequired: false,
      removed: false,
      verification: {
        attempted: true,
        exitCode: 1,
        expectedTools: [],
        calledTools: [],
        resultTools: [],
        failedTools: [],
        sessionFiles: [],
        taskResultObserved: false,
        reason: 'child cause unknown',
      },
    }
    await store.put('installations', installation)
    const workflow: WorkflowRecord = {
      schemaVersion: 2,
      id: workflowId,
      policyVersion: POLICY_VERSION,
      createdAt: '2026-08-21T00:00:00.000Z',
      updatedAt: '2026-08-21T00:00:00.000Z',
      requirement: 'calculator',
      requirementNormalized: 'calculator',
      cwd: process.cwd(),
      ownerSessionId: 'session-1',
      bootId: 'boot_previous',
      resolutionId: record.id,
      status: 'running',
      cursor: 'install_verify',
      generation: 3,
      consumedInterruptIds: [],
      lastInstallationId: installationId,
    }
    await store.put('workflows', workflow)
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_engine' })
    const cleanupInstallation = vi.fn(async (id: string) => ({ installationId: id, removed: true, restartRequired: true }))
    const engine = new WorkflowEngine(store, guard, { ...host(store, record), cleanupInstallation })
    const turn = exec()
    const recoveredAfterRestart = await engine.start('calculator', turn)
    expect(recoveredAfterRestart).toMatchObject({
      status: 'parked',
      alreadyWaiting: true,
      workflow: { cursor: 'recovery_required', status: 'interrupted' },
    })
    expect(recoveredAfterRestart.workflow.interrupt?.kind).toBe('await_recovery')
    await expect(engine.recover({ workflowId: workflow.id }, turn)).rejects.toThrow(/interrupt_id/i)

    const sameTurn = await engine.recover({
      workflowId: workflow.id,
      interruptId: recoveredAfterRestart.workflow.interrupt!.interruptId,
    }, turn)
    expect(sameTurn).toMatchObject({ status: 'parked', alreadyWaiting: true })
    expect(cleanupInstallation).not.toHaveBeenCalled()

    const tampered = await store.getWorkflow(workflow.id)
    tampered.lastInstallationId = `installation_${'9'.repeat(24)}`
    await store.put('workflows', tampered)
    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: '清理掉并重新开始' }] })
    await expect(engine.recover({
      workflowId: workflow.id,
      interruptId: recoveredAfterRestart.workflow.interrupt!.interruptId,
    }, turn)).rejects.toThrow(/no longer matches the sealed workflow state/i)
    expect(cleanupInstallation).not.toHaveBeenCalled()

    tampered.lastInstallationId = installationId
    await store.put('workflows', tampered)

    const restarted = await engine.recover({
      workflowId: workflow.id,
      interruptId: recoveredAfterRestart.workflow.interrupt!.interruptId,
    }, turn)

    expect(cleanupInstallation).toHaveBeenCalledOnce()
    expect(cleanupInstallation).toHaveBeenCalledWith(installationId, expect.objectContaining({ agent: turn.agent }))
    expect(restarted.workflow).toMatchObject({
      cursor: 'await_discovery',
      status: 'interrupted',
      recoveredFromWorkflowId: workflow.id,
    })
    expect(restarted.workflow.id).not.toBe(workflow.id)
    const old = await store.getWorkflow(workflow.id)
    expect(old).toMatchObject({
      status: 'completed',
      cursor: 'recovery_required',
      recovery: {
        action: 'cleanup_and_restart',
        cleanup: 'removed',
        installationId,
        restartRequired: true,
        restartedAsWorkflowId: restarted.workflow.id,
      },
      lastFailure: { code: 'service_restart_incomplete' },
    })
    expect(old.interrupt).toBeUndefined()
  })

  it('restarts a completed installation from an explicit user request without forging a recovery interrupt', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-engine-completed-recover-'))
    temporary.push(root)
    const store = new StateStore(root)
    const record = resolution('calculator')
    await store.put('resolutions', record)
    const workflowId = `workflow_${'a'.repeat(24)}`
    const installationId = `installation_${'d'.repeat(24)}`
    const installation: InstallationRecord = {
      schemaVersion: 1,
      id: installationId,
      createdAt: '2026-08-21T00:00:00.000Z',
      reviewId: `review_${'e'.repeat(24)}`,
      workflowId,
      targetProfile: 'headless',
      retention: 'persistent',
      dshHome: root,
      packageName: 'dsh-plugin-demo',
      installSpec: 'file:demo.tgz',
      installState: 'installed',
      installOutcome: 'activated',
      installed: true,
      loaded: true,
      verified: false,
      restartRequired: false,
      removed: false,
      verification: {
        attempted: true,
        expectedTools: [],
        calledTools: [],
        resultTools: [],
        failedTools: [],
        sessionFiles: [],
        taskResultObserved: false,
        reason: 'bundle activated',
      },
    }
    await store.put('installations', installation)
    const workflow: WorkflowRecord = {
      schemaVersion: 2,
      id: workflowId,
      policyVersion: POLICY_VERSION,
      createdAt: '2026-08-21T00:00:00.000Z',
      updatedAt: '2026-08-21T00:00:00.000Z',
      requirement: 'calculator',
      requirementNormalized: 'calculator',
      cwd: process.cwd(),
      ownerSessionId: 'session-1',
      bootId: 'boot_engine',
      resolutionId: record.id,
      status: 'completed',
      cursor: 'activated',
      generation: 4,
      consumedInterruptIds: [`interrupt_${'c'.repeat(24)}`],
      lastInstallationId: installationId,
      lastReviewId: `review_${'e'.repeat(24)}`,
      selectionReceipt: { id: 'selection_old' } as unknown as NonNullable<WorkflowRecord['selectionReceipt']>,
      actionCommitment: { id: 'commitment_old' } as unknown as NonNullable<WorkflowRecord['actionCommitment']>,
      completionTurnId: 'turn_install',
    }
    await store.put('workflows', workflow)
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_engine' })
    const cleanupInstallation = vi.fn(async (id: string) => ({ installationId: id, removed: true, restartRequired: true }))
    const engine = new WorkflowEngine(store, guard, { ...host(store, record), cleanupInstallation })
    const turn = exec()

    const sameTurn = await engine.recover({ workflowId: workflow.id }, turn)
    expect(sameTurn).toMatchObject({ status: 'parked', alreadyWaiting: true })
    expect(cleanupInstallation).not.toHaveBeenCalled()
    expect((await store.listWorkflows()).map((item) => item.id)).toEqual([workflow.id])

    await expect(engine.recover({
      workflowId: workflow.id,
      interruptId: `interrupt_${'c'.repeat(24)}`,
    }, turn)).rejects.toThrow(/omit interrupt_id/i)
    expect(cleanupInstallation).not.toHaveBeenCalled()

    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: '清理掉，从头开始' }] })
    const denied = vi.fn(async () => {
      throw new EvolutionError('approval_required', 'The removal was not approved (denied)', { outcome: 'denied' })
    })
    const deniedEngine = new WorkflowEngine(store, guard, { ...host(store, record), cleanupInstallation: denied })
    await expect(deniedEngine.recover({ workflowId: workflow.id }, turn)).rejects.toMatchObject({
      code: 'approval_required',
    })
    expect(denied).toHaveBeenCalledOnce()
    expect(await store.getWorkflow(workflow.id)).toMatchObject({
      status: 'completed',
      cursor: 'activated',
      generation: 4,
    })
    expect((await store.getWorkflow(workflow.id)).recovery).toBeUndefined()
    expect((await store.listWorkflows()).map((item) => item.id)).toEqual([workflow.id])
    expect(await store.getInstallation(installationId)).toMatchObject({ removed: false })

    const restarted = await engine.recover({ workflowId: workflow.id }, turn)
    expect(cleanupInstallation).toHaveBeenCalledOnce()
    expect(cleanupInstallation).toHaveBeenCalledWith(installationId, expect.objectContaining({ agent: turn.agent }))
    expect(restarted.workflow.id).not.toBe(workflow.id)
    expect(restarted.workflow).toMatchObject({
      cursor: 'await_discovery',
      status: 'interrupted',
      generation: 1,
      recoveredFromWorkflowId: workflow.id,
    })
    expect(restarted.workflow.lastInstallationId).toBeUndefined()
    expect(restarted.workflow.lastReviewId).toBeUndefined()
    expect(restarted.workflow.selectionReceipt).toBeUndefined()
    expect(restarted.workflow.actionCommitment).toBeUndefined()
    expect(restarted.workflow.consumedVerificationAttempts).toBeUndefined()
    const old = await store.getWorkflow(workflow.id)
    expect(old).toMatchObject({
      status: 'completed',
      cursor: 'activated',
      lastInstallationId: installationId,
      lastReviewId: `review_${'e'.repeat(24)}`,
      recovery: {
        action: 'cleanup_and_restart',
        cleanup: 'removed',
        installationId,
        restartRequired: true,
        restartedAsWorkflowId: restarted.workflow.id,
      },
    })
    expect(old.interrupt).toBeUndefined()
    expect(old.selectionReceipt).toEqual({ id: 'selection_old' })

    await expect(engine.recover({ workflowId: workflow.id }, turn)).rejects.toThrow(/not waiting for a recovery decision/i)
  })

  it('rejects completed-install restart when the receipt is not the unreplaced owned success receipt', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-engine-completed-receipt-'))
    temporary.push(root)
    const store = new StateStore(root)
    const record = resolution('calculator')
    await store.put('resolutions', record)
    const workflowId = `workflow_${'a'.repeat(24)}`
    const installationId = `installation_${'d'.repeat(24)}`
    await store.put('installations', {
      schemaVersion: 1,
      id: installationId,
      createdAt: '2026-08-21T00:00:00.000Z',
      reviewId: `review_${'e'.repeat(24)}`,
      workflowId: `workflow_${'f'.repeat(24)}`,
      targetProfile: 'headless',
      retention: 'persistent',
      dshHome: root,
      packageName: 'dsh-plugin-demo',
      installSpec: 'file:demo.tgz',
      installOutcome: 'verified',
      installed: true,
      loaded: true,
      verified: true,
      restartRequired: false,
      removed: false,
      verification: {
        attempted: true,
        expectedTools: [],
        calledTools: [],
        resultTools: [],
        failedTools: [],
        sessionFiles: [],
        taskResultObserved: true,
        reason: 'verified',
      },
    } satisfies InstallationRecord)
    const workflow: WorkflowRecord = {
      schemaVersion: 2,
      id: workflowId,
      policyVersion: POLICY_VERSION,
      createdAt: '2026-08-21T00:00:00.000Z',
      updatedAt: '2026-08-21T00:00:00.000Z',
      requirement: 'calculator',
      requirementNormalized: 'calculator',
      cwd: process.cwd(),
      ownerSessionId: 'session-1',
      bootId: 'boot_engine',
      resolutionId: record.id,
      status: 'completed',
      cursor: 'installed',
      generation: 2,
      lastInstallationId: installationId,
    }
    await store.put('workflows', workflow)
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_engine' })
    const cleanupInstallation = vi.fn(async (id: string) => ({ installationId: id, removed: true, restartRequired: false }))
    const engine = new WorkflowEngine(store, guard, { ...host(store, record), cleanupInstallation })
    const turn = exec()
    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: '清理并重来' }] })
    await expect(engine.recover({ workflowId }, turn)).rejects.toThrow(/not owned by this recovery workflow/i)
    expect(cleanupInstallation).not.toHaveBeenCalled()
    expect((await store.listWorkflows()).map((item) => item.id)).toEqual([workflowId])
  })

  it('keeps a persisted current-policy Gate 1 interrupt readable for the owning session', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-engine-v5-compat-'))
    temporary.push(root)
    const store = new StateStore(root)
    const record = resolution()
    await store.put('resolutions', record)
    const persisted: WorkflowRecord = {
      schemaVersion: 1,
      id: `workflow_${'a'.repeat(24)}`,
      policyVersion: POLICY_VERSION,
      createdAt: '2026-08-17T00:00:00.000Z',
      updatedAt: '2026-08-17T00:00:00.000Z',
      requirement: 'calculator',
      requirementNormalized: 'calculator',
      cwd: process.cwd(),
      ownerSessionId: 'session-1',
      bootId: 'boot_engine',
      resolutionId: record.id,
      status: 'interrupted',
      cursor: 'await_selection',
      generation: 1,
      candidateSnapshot: [],
      consumedInterruptIds: [],
      interrupt: {
        kind: 'await_selection',
        interruptId: `interrupt_${'c'.repeat(24)}`,
        ownerSessionId: 'session-1',
        bootId: 'boot_engine',
        validAfterTurnId: `turn_${'d'.repeat(24)}`,
        snapshotDigest: 'e'.repeat(64),
        options: [],
        facts: {},
      },
    }
    await store.put('workflows', persisted)
    const engine = new WorkflowEngine(store, new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_engine' }), host(store, record))

    const resumed = await engine.start('calculator', exec())

    expect(resumed.workflow).toMatchObject({ id: persisted.id, schemaVersion: 1, cursor: 'await_selection' })
    expect(resumed.workflow.interrupt?.interruptId).toBe(persisted.interrupt!.interruptId)
  })
})
