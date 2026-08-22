import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeConfig } from '../../src/config.js'
import { CreationGuard } from '../../src/creation-guard.js'
import { CapabilityEvolutionService } from '../../src/service.js'
import { StateStore } from '../../src/state/store.js'
import { WorkflowEngine } from '../../src/workflow/engine.js'
import type { WorkflowHost } from '../../src/workflow/contracts.js'
import { POLICY_VERSION, type ResolutionRecord } from '../../src/contracts.js'

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((entry) => rm(entry, { recursive: true, force: true })))
})

function config(root: string): RuntimeConfig {
  return {
    dshHome: path.join(root, 'dsh-home'),
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

function exec(sessionId = 'session-alpha', cwd = process.cwd()): ToolRunContext {
  return {
    callId: 'call-1',
    rootCallId: 'call-1',
    token: Symbol('call-1'),
    signal: new AbortController().signal,
    agent: {
      id: sessionId,
      session: { header: { id: sessionId, cwd, version: 0, createdAt: 0 } },
    },
  } as unknown as ToolRunContext
}

function remember(guard: CreationGuard, agent: ToolRunContext['agent'], text: string): void {
  guard.rememberUserMessage(agent, { content: [{ type: 'text', text }] })
}

function marketplaceCtx(baseUrl: string): Context {
  return {
    baseUrl,
    tools: {
      schemas: () => [],
      get: (name: string) => name === 'find_dsh_plugin' ? {} : undefined,
      execute: async () => ({ isError: false, value: { results: [] }, content: [] }),
      register: () => undefined,
    },
    systemPrompt: { assemble: async () => ({ tools: [] }) },
    skills: { list: async () => [] },
    get: () => undefined,
  } as unknown as Context
}

function resolution(requirement = 'calculator'): ResolutionRecord {
  const id = `resolution_${'b'.repeat(24)}`
  return {
    schemaVersion: 2,
    id,
    policyVersion: POLICY_VERSION,
    createdAt: '2026-08-17T00:00:00.000Z',
    requirement,
    cwd: process.cwd(),
    decision: 'none',
    localCandidates: [],
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

describe('interrupt binding and host-turn decisions', () => {
  it('accepts same-session resume with matching interrupt_id after a fresh host turn', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-bind-ok-'))
    temporary.push(root)
    const store = new StateStore(root)
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_test_1' })
    const engine = new WorkflowEngine(store, guard, host(store, resolution()))
    const turn = exec()
    const started = await engine.start('calculator', turn)
    expect(started.workflow.interrupt?.interruptId).toMatch(/^interrupt_/u)
    expect(started.workflow.interrupt?.ownerSessionId).toBe('session-alpha')
    expect(started.workflow.interrupt?.bootId).toBe('boot_test_1')
    expect(started.workflow.interrupt?.snapshotDigest).toMatch(/^[a-f0-9]{64}$/u)
    remember(guard, turn.agent, '先停')
    const stopped = await engine.resume({
      workflowId: started.workflow.id,
      interruptId: started.workflow.interrupt!.interruptId,
      decision: { action: 'stop' },
    }, turn)
    expect(stopped.workflow.cursor).toBe('stopped')
  })

  it('rejects cross-session resume', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-bind-xsession-'))
    temporary.push(root)
    const store = new StateStore(root)
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_test_1' })
    const engine = new WorkflowEngine(store, guard, host(store, resolution()))
    const owner = exec('session-owner')
    const started = await engine.start('calculator', owner)
    const other = exec('session-other')
    remember(guard, other.agent, '先停')
    await expect(engine.resume({
      workflowId: started.workflow.id,
      interruptId: started.workflow.interrupt!.interruptId,
      decision: { action: 'stop' },
    }, other)).rejects.toThrow(/different owner session/i)
  })

  it('rejects replay of a consumed interrupt_id', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-bind-replay-'))
    temporary.push(root)
    const store = new StateStore(root)
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_test_1' })
    const engine = new WorkflowEngine(store, guard, host(store, resolution()))
    const turn = exec()
    const started = await engine.start('calculator', turn)
    const interruptId = started.workflow.interrupt!.interruptId
    remember(guard, turn.agent, '先停')
    await engine.resume({ workflowId: started.workflow.id, interruptId, decision: { action: 'stop' } }, turn)
    remember(guard, turn.agent, '先停')
    await expect(engine.resume({ workflowId: started.workflow.id, interruptId, decision: { action: 'stop' } }, turn))
      .rejects.toThrow(/already consumed|not waiting/i)
  })

  it('parks same-turn resume without consuming the interrupt or advancing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-bind-stale-'))
    temporary.push(root)
    const store = new StateStore(root)
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_test_1' })
    const engine = new WorkflowEngine(store, guard, host(store, resolution()))
    const turn = exec()
    remember(guard, turn.agent, '先停')
    const started = await engine.start('calculator', turn)
    const interruptId = started.workflow.interrupt!.interruptId
    const generation = started.workflow.generation
    // No new remember after interrupt: current turn equals validAfterTurnId watermark.
    const parked = await engine.resume({
      workflowId: started.workflow.id,
      interruptId,
      decision: { action: 'stop' },
    }, turn)
    expect(parked.status).toBe('parked')
    expect(parked.alreadyWaiting).toBe(true)
    expect(parked.workflow.interrupt?.interruptId).toBe(interruptId)
    expect(parked.workflow.generation).toBe(generation)
    expect(parked.workflow.cursor).toBe(started.workflow.cursor)
    expect(parked.workflow.status).toBe('interrupted')
    expect(parked.workflow.consumedInterruptIds).toEqual([])
  })

  it('invalidates interrupts across boot identity changes and requires a fresh confirmation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-bind-boot-'))
    temporary.push(root)
    const store = new StateStore(root)
    const guard1 = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_old' })
    const engine1 = new WorkflowEngine(store, guard1, host(store, resolution()))
    const turn = exec()
    const started = await engine1.start('calculator', turn)
    const oldInterrupt = started.workflow.interrupt!.interruptId

    const guard2 = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_new' })
    const engine2 = new WorkflowEngine(store, guard2, host(store, resolution()))
    remember(guard2, turn.agent, '先停')
    await expect(engine2.resume({
      workflowId: started.workflow.id,
      interruptId: oldInterrupt,
      decision: { action: 'stop' },
    }, turn)).rejects.toThrow(/service restart|reissued interrupt/i)

    const reused = await engine2.start('calculator', turn)
    expect(reused.workflow.id).toBe(started.workflow.id)
    expect(reused.workflow.interrupt?.bootId).toBe('boot_new')
    expect(reused.workflow.interrupt?.interruptId).not.toBe(oldInterrupt)
  })

  it('rejects candidate snapshot digest mismatch', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-bind-snap-'))
    temporary.push(root)
    const store = new StateStore(root)
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_test_1' })
    const engine = new WorkflowEngine(store, guard, host(store, resolution()))
    const turn = exec()
    const started = await engine.start('calculator', turn)
    const mutated = await store.getWorkflow(started.workflow.id)
    mutated.candidateSnapshot = [{
      id: `candidate_${'f'.repeat(24)}`,
      index: 1,
      kind: 'remote',
      name: 'forged',
      identity: 'acme/forged',
      repository: 'acme/forged',
      digest: 'f'.repeat(64),
    }]
    await store.put('workflows', mutated)
    remember(guard, turn.agent, '先停')
    await expect(engine.resume({
      workflowId: started.workflow.id,
      interruptId: started.workflow.interrupt!.interruptId,
      decision: { action: 'stop' },
    }, turn)).rejects.toThrow(/snapshot digest mismatch/i)
  })

  it('reuses an unfinished workflow for the same session, cwd, and normalized requirement', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-bind-reuse-'))
    temporary.push(root)
    const baseUrl = path.join(root, 'dsh-home', 'profiles', 'web')
    await mkdir(baseUrl, { recursive: true })
    await writeFile(path.join(baseUrl, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dependencies: {} }))
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_test_1' })
    const service = new CapabilityEvolutionService(
      marketplaceCtx(baseUrl),
      config(root),
      { run: async () => ({ exitCode: 0, signal: null, stdout: '0.1.0-rc.6\n', stderr: '' }) },
      new StateStore(root),
      guard,
    )
    const turn = exec('session-reuse', 'C:/workspace/app')
    const first = await service.start('Need a  Calculator  tool', turn)
    const second = await service.start('need a calculator tool', turn)
    expect(second.workflow.id).toBe(first.workflow.id)
    expect(second.workflow.interrupt?.interruptId).toBe(first.workflow.interrupt?.interruptId)
  })
})
