import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { POLICY_VERSION, type InstallationRecord, type ResolutionRecord, type ReviewRecord } from '../../src/contracts.js'
import { CreationGuard } from '../../src/creation-guard.js'
import { StateStore } from '../../src/state/store.js'
import { WorkflowEngine } from '../../src/workflow/engine.js'
import type { WorkflowHost, WorkflowRecord } from '../../src/workflow/contracts.js'

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

function managedReview(resolutionId: string): ReviewRecord {
  return {
    schemaVersion: 1,
    id: `review_${'9'.repeat(64)}`,
    policyVersion: POLICY_VERSION,
    createdAt: '2026-08-17T00:01:00.000Z',
    resolutionId,
    requirement: 'create a calculator plugin',
    sourceSnapshot: {
      kind: 'local',
      path: 'C:/managed/calculator',
      baseReviewId: `review_${'8'.repeat(64)}`,
      baseCommit: '7'.repeat(40),
      statusHash: '6'.repeat(64),
    },
    inspectedFiles: [],
    manifest: {
      kind: 'bundle',
      packageName: 'managed-calculator',
      scripts: [],
      dependencies: [],
      peerDependencies: {},
      expectedTools: ['calculator'],
    },
    fit: 'full',
    confidence: 0.95,
    securityRisk: 'low',
    maintained: true,
    license: 'MIT',
    compatibility: { status: 'compatible', reason: 'verified', runtimeVersion: '0.1.0-rc.6' },
    missingCapabilities: [],
    findings: [],
    recommendation: 'use',
    installSpec: 'file:C:/managed/managed-calculator.tgz',
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
    async applyDecision(current, resume) {
      const next = {
        ...current,
        authorization: {
          state: resume.optionId === 'stop' ? 'stopped' as const : current.authorization!.state,
          resolutionId: current.id,
          reason: resume.optionId,
        },
      }
      await store.put('resolutions', next)
      return next
    },
    async applyNavigation(current, navigation) {
      const next = {
        ...current,
        authorization: {
          state: navigation.kind === 'stop'
            ? 'stopped' as const
            : navigation.kind === 'reuse_local'
              ? 'reuse_local' as const
              : current.authorization!.state,
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

describe('workflow engine', () => {
  it('starts, checkpoints, and parks on await_selection with a bound interrupt', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-engine-'))
    temporary.push(root)
    const store = new StateStore(root)
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_engine' })
    const record = resolution()
    const engine = new WorkflowEngine(store, guard, host(store, record))
    const view = await engine.start('run a PowerShell command', exec())
    expect(view.workflow.status).toBe('interrupted')
    expect(view.workflow.cursor).toBe('await_selection')
    expect(view.workflow.interrupt?.options.map((item) => item.id)).toContain('reuse_local')
    expect(view.workflow.interrupt?.interruptId).toMatch(/^interrupt_/u)
    expect(view.workflow.interrupt?.ownerSessionId).toBe('session-1')
    expect(view.workflow.interrupt?.bootId).toBe('boot_engine')
    const stored = await store.getWorkflow(view.workflow.id)
    expect(stored.generation).toBe(1)
    expect(stored.resolutionId).toBe(record.id)
  })

  it('rejects a concurrent resume while the workflow is running', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-engine-lock-'))
    temporary.push(root)
    const store = new StateStore(root)
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_engine' })
    const record = resolution()
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const engine = new WorkflowEngine(store, guard, {
      ...host(store, record),
      async applyNavigation(current, navigation) {
        await blocked
        return host(store, record).applyNavigation!(current, navigation, [])
      },
    })
    const turn = exec()
    const started = await engine.start('calculator', turn)
    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: '先停' }] })
    const first = engine.resume({
      workflowId: started.workflow.id,
      interruptId: started.workflow.interrupt!.interruptId,
      navigation: { kind: 'stop' },
    }, turn)
    await expect(engine.resume({
      workflowId: started.workflow.id,
      interruptId: started.workflow.interrupt!.interruptId,
      navigation: { kind: 'stop' },
    }, turn)).rejects.toThrow(/already running/i)
    release()
    await expect(first).resolves.toMatchObject({ workflow: { cursor: 'stopped' } })
  })

  it('fails closed when the run is cancelled', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-engine-cancel-'))
    temporary.push(root)
    const store = new StateStore(root)
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_engine' })
    const controller = new AbortController()
    controller.abort()
    const engine = new WorkflowEngine(store, guard, host(store, resolution()))
    await expect(engine.start('calculator', { ...exec(), signal: controller.signal })).rejects.toThrow(/cancelled/i)
  })

  it('converts an interrupted-by-restart running workflow to recovery_required without replaying side effects', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-engine-restart-running-'))
    temporary.push(root)
    const store = new StateStore(root)
    const record = resolution()
    const running: WorkflowRecord = {
      schemaVersion: 1,
      id: `workflow_${'f'.repeat(24)}`,
      policyVersion: POLICY_VERSION,
      createdAt: '2026-08-17T00:00:00.000Z',
      updatedAt: '2026-08-17T00:00:00.000Z',
      requirement: 'calculator',
      requirementNormalized: 'calculator',
      cwd: process.cwd(),
      ownerSessionId: 'session-1',
      bootId: 'boot_old',
      resolutionId: record.id,
      status: 'running',
      cursor: 'install_verify',
      generation: 4,
    }
    await store.put('workflows', running)
    await store.put('resolutions', record)
    const installReviewed = vi.fn()
    const engine = new WorkflowEngine(
      store,
      new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_new' }),
      { ...host(store, record), installReviewed },
    )
    const recovered = await engine.start('calculator', exec())
    expect(installReviewed).not.toHaveBeenCalled()
    expect(recovered.workflow).toMatchObject({ status: 'completed', cursor: 'recovery_required' })
    expect(recovered.workflow.lastFailure?.code).toBe('service_restart_incomplete')
  })

  it('resumes stop from the host turn and completes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-engine-stop-'))
    temporary.push(root)
    const store = new StateStore(root)
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_engine' })
    const record = resolution()
    const engine = new WorkflowEngine(store, guard, host(store, record))
    const turn = exec()
    const started = await engine.start('calculator', turn)
    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: '先停' }] })
    const stopped = await engine.resume({
      workflowId: started.workflow.id,
      interruptId: started.workflow.interrupt!.interruptId,
      navigation: { kind: 'stop' },
    }, turn)
    expect(stopped.workflow.status).toBe('completed')
    expect(stopped.workflow.cursor).toBe('stopped')
    expect(stopped.resolution?.authorization?.state).toBe('stopped')
    expect(stopped.workflow.selectionReceipt).toMatchObject({ kind: 'stop', candidateIds: [] })
    expect(stopped.workflow.actionCommitment?.endpoint).toEqual({ kind: 'none' })
    expect(stopped.workflow.executionLease).toBeUndefined()
  })

  it('fails closed with a clear restart message for an unfinished prior-policy workflow', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-engine-policy-'))
    temporary.push(root)
    const store = new StateStore(root)
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_engine' })
    const record = resolution()
    const applyDecision = vi.fn(async (current: ResolutionRecord) => current)
    const engine = new WorkflowEngine(store, guard, { ...host(store, record), applyDecision })
    const turn = exec()
    const started = await engine.start('calculator', turn)
    const legacy = await store.getWorkflow(started.workflow.id)
    legacy.policyVersion = '4'
    await store.put('workflows', legacy)
    const restarted = await engine.resume({
      workflowId: legacy.id,
      interruptId: legacy.interrupt!.interruptId,
      navigation: { kind: 'stop' },
    }, turn)
    expect(applyDecision).not.toHaveBeenCalled()
    expect(restarted.lifecycleState).toBe('interrupted')
    expect(restarted.workflow.status).toBe('completed')
    expect(restarted.workflow.interrupt).toBeUndefined()
    expect(restarted.nextStep).toMatch(/Policy V5|capability_workflow again/i)
  })

  it('binds a managed local review to an interrupt candidate and completes create-to-install', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-engine-managed-install-'))
    temporary.push(root)
    const store = new StateStore(root)
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_engine' })
    const record = resolution('create a calculator plugin')
    record.decision = 'inspect_remote'
    record.localCandidates = []
    record.remoteCandidates = []
    record.remoteDiscoveryComplete = true
    const review = managedReview(record.id)
    const installation: InstallationRecord = {
      schemaVersion: 1,
      id: `installation_${'5'.repeat(24)}`,
      createdAt: '2026-08-17T00:02:00.000Z',
      reviewId: review.id,
      targetProfile: 'web',
      retention: 'temporary',
      dshHome: 'C:/dsh',
      packageName: 'managed-calculator',
      installSpec: review.installSpec!,
      installOutcome: 'verified',
      installed: true,
      loaded: true,
      verified: true,
      restartRequired: false,
      removed: false,
      verification: { attempted: true, expectedTools: ['calculator'], calledTools: ['calculator'], resultTools: ['calculator'], failedTools: [], sessionFiles: [], taskResultObserved: true, reason: 'verified' },
    }
    const base = host(store, record)
    const workflowHost: WorkflowHost = {
      ...base,
      async listInstallProfiles() { return ['web'] },
      async prepareCreate(current) {
        await store.put('reviews', review)
        return { resolution: current, review }
      },
      async latestReview() { return review },
      async installReviewed() {
        await store.put('installations', installation)
        return installation
      },
    }
    const engine = new WorkflowEngine(store, guard, workflowHost)
    const turn = exec()
    const started = await engine.start(record.requirement, turn)
    expect(started.workflow.interrupt?.options.map((item) => item.id)).toContain('create_new')

    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: '重新做一个' }] })
    const reviewed = await engine.resume({
      workflowId: started.workflow.id,
      interruptId: started.workflow.interrupt!.interruptId,
      decision: { action: 'create_new' },
    }, turn)
    const useOption = reviewed.workflow.interrupt?.options.find((item) => item.id === 'use_this')
    expect(useOption?.candidateIds).toHaveLength(1)
    expect(reviewed.workflow.candidateSnapshot?.find((item) => item.id === useOption!.candidateIds![0])).toMatchObject({
      kind: 'local',
      name: 'managed-calculator',
      fit: 'full',
    })
    expect(reviewed.workflow.reviewIdsByCandidate?.[useOption!.candidateIds![0]!]).toBe(review.id)

    let committed: WorkflowRecord | undefined
    workflowHost.installReviewed = async (_review, _input, _exec, current) => {
      committed = structuredClone(current)
      await store.put('installations', installation)
      return installation
    }
    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: '用这个' }] })
    const installed = await engine.resume({
      workflowId: reviewed.workflow.id,
      interruptId: reviewed.workflow.interrupt!.interruptId,
      decision: { action: 'use_this', candidateId: useOption!.candidateIds![0]! },
    }, turn)
    expect(committed?.actionCommitment).toMatchObject({
      requestedAction: 'use_this',
      reviewId: review.id,
      retention: 'temporary',
      endpoint: { kind: 'none' },
    })
    expect(committed?.executionLease).toBeUndefined()
    expect(installed.workflow).toMatchObject({ status: 'completed', cursor: 'installed' })
    expect(installed.workflow.actionCommitment).toBeUndefined()
    expect(installed.workflow.executionLease).toBeUndefined()
    expect(installed.installation).toMatchObject({ id: installation.id, verified: true })
  })

  it('rejects read-only navigation outside the current candidate snapshot without consuming authorization', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-engine-nav-snapshot-'))
    temporary.push(root)
    const store = new StateStore(root)
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_engine' })
    const record = resolution()
    const engine = new WorkflowEngine(store, guard, host(store, record))
    const turn = exec()
    const started = await engine.start('calculator', turn)
    await expect(engine.resume({
      workflowId: started.workflow.id,
      interruptId: started.workflow.interrupt!.interruptId,
      navigation: { kind: 'stop' },
      decision: { action: 'stop' },
    }, turn)).rejects.toThrow(/either navigation or decision/i)
    await expect(engine.resume({
      workflowId: started.workflow.id,
      interruptId: started.workflow.interrupt!.interruptId,
      navigation: {
        kind: 'review_candidates',
        candidateIds: [`candidate_${'f'.repeat(24)}`],
      },
    }, turn)).rejects.toThrow(/outside the current candidate snapshot/i)
    expect((await store.getWorkflow(started.workflow.id)).consumedInterruptIds).toEqual([])
  })

  it('rejects navigation without a fresh host turn and rejects same-turn replay', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-engine-fresh-turn-'))
    temporary.push(root)
    const store = new StateStore(root)
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_engine' })
    const engine = new WorkflowEngine(store, guard, host(store, resolution()))
    const turn = exec()
    const started = await engine.start('calculator', turn)
    await expect(engine.resume({
      workflowId: started.workflow.id,
      interruptId: started.workflow.interrupt!.interruptId,
      navigation: { kind: 'stop' },
    }, turn)).rejects.toThrow(/No host-claimed user turn/i)
    expect((await store.getWorkflow(started.workflow.id)).consumedInterruptIds).toEqual([])

    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: '先停' }] })
    const stopped = await engine.resume({
      workflowId: started.workflow.id,
      interruptId: started.workflow.interrupt!.interruptId,
      navigation: { kind: 'stop' },
    }, turn)
    expect(stopped.workflow.cursor).toBe('stopped')
    expect(stopped.workflow.selectionReceipt?.kind).toBe('stop')

    await expect(engine.resume({
      workflowId: started.workflow.id,
      interruptId: started.workflow.interrupt!.interruptId,
      navigation: { kind: 'stop' },
    }, turn)).rejects.toThrow(/already consumed|not waiting/i)
  })

  it('builds a mixed 3-5 local/remote snapshot whose option candidateIds stay inside it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-engine-mixed-'))
    temporary.push(root)
    const store = new StateStore(root)
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_engine' })
    const record = resolution()
    record.decision = 'inspect_remote'
    record.remoteDiscoveryComplete = true
    record.localCandidates = [
      {
        kind: 'tool',
        name: 'pwsh',
        description: 'Run a PowerShell command',
        availability: 'available',
        confidence: 0.9,
        fit: 'full',
      },
      {
        kind: 'tool',
        name: 'telegram_send',
        description: 'Send Telegram messages',
        availability: 'available_via_tool_search',
        confidence: 0.4,
        fit: 'partial',
      },
    ]
    record.remoteCandidates = [
      { repository: 'acme/one', name: 'one', description: '', stars: 4, updatedAt: null, topics: [] },
      { repository: 'acme/two', name: 'two', description: '', stars: 3, updatedAt: null, topics: [] },
      { repository: 'acme/three', name: 'three', description: '', stars: 2, updatedAt: null, topics: [] },
      { repository: 'acme/four', name: 'four', description: '', stars: 1, updatedAt: null, topics: [] },
    ]
    const engine = new WorkflowEngine(store, guard, host(store, record))
    const started = await engine.start('calculator', exec())
    const snapshot = started.workflow.candidateSnapshot ?? []
    expect(snapshot.length).toBeGreaterThanOrEqual(3)
    expect(snapshot.length).toBeLessThanOrEqual(5)
    expect(snapshot.some((item) => item.kind === 'local')).toBe(true)
    expect(snapshot.some((item) => item.kind === 'remote')).toBe(true)
    const optionIds = (started.workflow.interrupt?.options ?? []).flatMap((option) => option.candidateIds ?? [])
    const snapshotIds = new Set(snapshot.map((item) => item.id))
    expect(optionIds.every((id) => snapshotIds.has(id))).toBe(true)
  })

  it('records search_more seen ids, omits them from the next snapshot, and rejects the old interrupt', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-engine-search-more-'))
    temporary.push(root)
    const store = new StateStore(root)
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_engine' })
    const record = resolution()
    record.decision = 'inspect_remote'
    record.remoteDiscoveryComplete = true
    record.remoteCandidates = [
      { repository: 'acme/one', name: 'one', description: '', stars: 6, updatedAt: null, topics: [] },
      { repository: 'acme/two', name: 'two', description: '', stars: 5, updatedAt: null, topics: [] },
      { repository: 'acme/three', name: 'three', description: '', stars: 4, updatedAt: null, topics: [] },
      { repository: 'acme/four', name: 'four', description: '', stars: 3, updatedAt: null, topics: [] },
      { repository: 'acme/five', name: 'five', description: '', stars: 2, updatedAt: null, topics: [] },
      { repository: 'acme/six', name: 'six', description: '', stars: 1, updatedAt: null, topics: [] },
    ]
    const engine = new WorkflowEngine(store, guard, host(store, record))
    const turn = exec()
    const started = await engine.start('calculator', turn)
    const firstIds = (started.workflow.candidateSnapshot ?? []).map((item) => item.id)
    const oldInterrupt = started.workflow.interrupt!.interruptId
    expect(firstIds.length).toBeGreaterThan(0)

    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: '再找找' }] })
    const more = await engine.resume({
      workflowId: started.workflow.id,
      interruptId: oldInterrupt,
      navigation: { kind: 'search_more' },
    }, turn)
    expect(more.workflow.seenCandidateIds).toEqual(expect.arrayContaining(firstIds))
    expect(more.workflow.rejectedCandidateIds).toEqual(expect.arrayContaining(firstIds))
    const nextIds = (more.workflow.candidateSnapshot ?? []).map((item) => item.id)
    for (const id of firstIds) expect(nextIds).not.toContain(id)
    expect(more.workflow.interrupt?.interruptId).not.toBe(oldInterrupt)
    expect(more.workflow.executionLease).toBeUndefined()

    await expect(engine.resume({
      workflowId: started.workflow.id,
      interruptId: oldInterrupt,
      navigation: { kind: 'search_more' },
    }, turn)).rejects.toThrow(/already consumed|not waiting|does not match the current workflow interrupt/i)
  })

  it('binds reuse_local receipt, commitment, and lease to the candidate digest', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-engine-reuse-lease-'))
    temporary.push(root)
    const store = new StateStore(root)
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_engine' })
    const engine = new WorkflowEngine(store, guard, host(store, resolution()))
    const turn = exec()
    const started = await engine.start('calculator', turn)
    const candidate = started.workflow.candidateSnapshot!.find((item) => item.localName === 'pwsh')!
    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: '用已有的' }] })
    const reused = await engine.resume({
      workflowId: started.workflow.id,
      interruptId: started.workflow.interrupt!.interruptId,
      navigation: { kind: 'reuse_local', candidateIds: [candidate.id] },
    }, turn)
    expect(reused.workflow.selectionReceipt?.candidateDigests[candidate.id]).toBe(candidate.digest)
    expect(reused.workflow.actionCommitment).toMatchObject({
      candidateId: candidate.id,
      candidateDigest: candidate.digest,
      requestedAction: 'reuse_local',
      endpoint: { kind: 'exact_tool', name: 'pwsh' },
    })
    expect(reused.workflow.executionLease).toMatchObject({
      candidateId: candidate.id,
      candidateDigest: candidate.digest,
      endpoint: { kind: 'exact_tool', name: 'pwsh' },
    })
    expect(guard.activeExecutionLease(turn.agent)?.candidateDigest).toBe(candidate.digest)

    const forged = {
      ...reused.workflow.executionLease!,
      candidateDigest: '9'.repeat(64),
      endpoint: { kind: 'exact_tool' as const, name: 'weather' },
      requestedAction: 'stop' as const,
    }
    expect(() => guard.grantHostSelection(
      turn.agent,
      reused.workflow.selectionReceipt!,
      reused.workflow.actionCommitment!,
      forged,
    )).toThrow(/not bound to the current receipt and commitment/i)
  })
})

describe('workflow record identity', () => {
  it('uses a workflow_ id that the store accepts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-engine-id-'))
    temporary.push(root)
    const store = new StateStore(root)
    const record: WorkflowRecord = {
      schemaVersion: 1,
      id: `workflow_${'a'.repeat(24)}`,
      policyVersion: POLICY_VERSION,
      createdAt: '2026-08-17T00:00:00.000Z',
      updatedAt: '2026-08-17T00:00:00.000Z',
      requirement: 'calculator',
      status: 'interrupted',
      cursor: 'await_selection',
      generation: 1,
    }
    await store.put('workflows', record)
    await expect(store.getWorkflow(record.id)).resolves.toMatchObject({ id: record.id })
  })
})
