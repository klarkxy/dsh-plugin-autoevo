import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { POLICY_VERSION, type ResolutionRecord } from '../../src/contracts.js'
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
    expect(view.workflow.interrupt?.options.map((item) => item.id)).toContain('use_local')
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
      async applyDecision(current, resume) {
        await blocked
        return host(store, record).applyDecision(current, resume)
      },
    })
    const turn = exec()
    const started = await engine.start('calculator', turn)
    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: '先停' }] })
    const first = engine.resume({
      workflowId: started.workflow.id,
      interruptId: started.workflow.interrupt!.interruptId,
    }, turn)
    await expect(engine.resume({
      workflowId: started.workflow.id,
      interruptId: started.workflow.interrupt!.interruptId,
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
    }, turn)
    expect(stopped.workflow.status).toBe('completed')
    expect(stopped.workflow.cursor).toBe('stopped')
    expect(stopped.resolution?.authorization?.state).toBe('stopped')
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
