import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Agent, AgentHandle, AgentRegistry, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { trackTempDirs } from '../helpers/temp-dirs.js'
import {
  CREATOR_PRESET_ID,
  mintCreatorReceipt,
  requiredCreatorCatalog,
  testingCreatorPreflight,
  testingCreatorWorkOrder,
  _testing as creatorTesting,
} from '../../src/creator-foundation.js'
import { DshManagedChildHost, _testing as managedChildTesting } from '../../src/managed-child.js'
import type { CommandRunner } from '../../src/process/runner.js'

const temporary = trackTempDirs()

function parentAgent(cwd: string, ctx: Context): Agent {
  return {
    id: 'parent-session',
    options: { provider: 'test', model: 'test-model' },
    session: { header: { id: 'parent-session', cwd, version: 0, createdAt: 0 }, events: [] },
    ctx,
  } as unknown as Agent
}

function sandboxServices(cwd: string, modes: string[]) {
  const contains = (parent: string, candidate: string) => {
    const relative = path.relative(parent, candidate)
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  }
  const fs = {
    sandboxMode: 'read-only',
    async resolve(candidate: string) { return candidate },
    contains,
    async writeText(candidate: string, body: string) {
      if (!contains(cwd, candidate)) throw new Error('FS_SANDBOX_DENIED')
      await writeFile(candidate, body)
      return { version: 'v1' }
    },
  } as unknown as FileSystem
  const sandbox = {
    confine(argv: readonly string[]) {
      return { argv: [...argv], enforcement: 'partial' as const, denialSignatures: [], runnerFailureRules: [] }
    },
  } as unknown as SandboxProvider
  const sandboxPolicy = {
    resolve: ({ session }: { session: Session }) => ({
      mode: 'workspace-write',
      workspaceRoot: session.header.cwd!,
      sessionId: session.id,
    }),
  } as unknown as SandboxPolicyService
  const runner: CommandRunner = {
    async run(request) {
      const candidate = request.argv.at(-1)!
      if (!contains(cwd, candidate)) return { exitCode: 1, signal: null, stdout: '', stderr: 'denied' }
      await writeFile(candidate, 'shell probe\n')
      return { exitCode: 0, signal: null, stdout: '', stderr: '' }
    },
  }
  return { fs, sandbox, sandboxPolicy, runner, modes }
}

function creatorCatalogServices() {
  const required = requiredCreatorCatalog()
  const tools = new Set(required.tools)
  const skills = required.skills.map((name) => ({ name }))
  return {
    tools: {
      schemas: () => [...tools].map((name) => ({ name })),
      get: (name: string) => (tools.has(name) ? { name } : undefined),
      guard: () => undefined,
    },
    skills: { list: async () => skills },
  }
}

function runtime(cwd: string, owned = true, lifecycle: {
  whenIdle?: () => Promise<void>
  onDispose?: () => void
  childCwd?: string
} = {}) {
  const modes: string[] = []
  const services = sandboxServices(cwd, modes)
  const catalog = creatorCatalogServices()
  const disposed = vi.fn(async () => { lifecycle.onDispose?.() })
  const followups: UserMessage[] = []
  let createOptions: CreateAgentOptions | undefined
  let preExecuteInstalled = false
  let guardInstalled = false
  let composedPreset: string | undefined
  const agents = {
    async create(options: CreateAgentOptions): Promise<AgentHandle> {
      createOptions = options
      const session = {
        id: options.sessionId,
        header: {
          id: options.sessionId,
          cwd: lifecycle.childCwd ?? options.meta?.cwd,
          parentSession: options.meta?.parentSession,
          origin: 'subagent',
          delegationDepth: 1,
          version: 0,
          createdAt: 0,
        },
        events: [{ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }],
        append(type: string, data: { mode: string }) { if (type === 'sandbox/mode') modes.push(data.mode) },
        deriveMessages: () => [{ role: 'assistant', content: [{ type: 'text', text: 'implemented\nAUTOEVO_CHILD_COMPLETED' }] }],
      } as unknown as Session
      const child = {
        id: options.sessionId,
        options: options.agentOptions ?? {},
        session,
        followup(message: UserMessage) { followups.push(message) },
        async whenIdle() { await lifecycle.whenIdle?.() },
      } as unknown as Agent
      try {
        await options.setup?.({
          agent: child,
          get(name: string) {
            if (name === 'tools') return catalog.tools
            if (name === 'skills') return catalog.skills
            return undefined
          },
          on: (name: string) => { if (name === 'tools/pre-execute') preExecuteInstalled = true },
          tools: { ...catalog.tools, guard: () => { guardInstalled = true } },
          skills: catalog.skills,
          systemPrompt: { section: () => undefined },
        } as unknown as Context)
      } catch (error) {
        await disposed()
        throw error
      }
      return { agent: child, dispose: disposed }
    },
    isOwnedBy: () => owned,
  } as unknown as AgentRegistry
  const ctx = {
    get(name: string) {
      if (name === 'agents') return agents
      if (name === 'sandbox') return services.sandbox
      if (name === 'sandboxPolicy') return services.sandboxPolicy
      if (name === 'fs') return services.fs
      if (name === 'tools') return catalog.tools
      if (name === 'skills') return catalog.skills
      if (name === 'agentPresets') return {
        async mount(_agentCtx: unknown, id?: string) {
          composedPreset = id
          return { id: id ?? CREATOR_PRESET_ID, trust: 'system' }
        },
        composedPreset() { return composedPreset },
        async read(id: string) {
          return id === CREATOR_PRESET_ID ? creatorTesting.TESTING_CORDIS_COMPOSITION : ''
        },
      }
      return undefined
    },
  } as unknown as Context
  return {
    ctx,
    runner: services.runner,
    disposed,
    followups,
    modes,
    get createOptions() { return createOptions },
    get preExecuteInstalled() { return preExecuteInstalled },
    get guardInstalled() { return guardInstalled },
  }
}

function childRequest(cwd: string) {
  const preflight = testingCreatorPreflight()
  return {
    cwd,
    workOrder: testingCreatorWorkOrder(cwd),
    preflight,
    expectedReceipt: (sessionId: string) => mintCreatorReceipt(preflight, sessionId),
  }
}

describe('real Host-managed child lifecycle', () => {
  it('injects a final-only instruction at the soft budget and rejects the hard-limit step', async () => {
    const budget = new managedChildTesting.ChildTurnBudget()
    const next = vi.fn(async () => ({ kind: 'enter' as const, messages: [] }))

    await expect(budget.preStep(managedChildTesting.CHILD_SOFT_STEP_LIMIT - 1, [], next))
      .resolves.toEqual({ kind: 'enter', messages: [] })
    expect(budget.denialReason()).toBeUndefined()

    const forced = await budget.preStep(managedChildTesting.CHILD_SOFT_STEP_LIMIT, [], next)
    expect(forced.kind).toBe('enter')
    expect(forced.kind === 'enter' && forced.messages.at(-1)?.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining(managedChildTesting.CHILD_RESULT_MARKER),
    })
    expect(budget.denialReason()).toBe(managedChildTesting.CHILD_BUDGET_DENIAL)
    await expect(budget.preStep(managedChildTesting.CHILD_HARD_STEP_LIMIT, [], next))
      .resolves.toEqual({ kind: 'reject' })
  })

  it('creates an owned child whose real session cwd and sandbox root are the managed repository', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'autoevo-child-host-'))
    temporary.push(cwd)
    const live = runtime(cwd)
    const host = new DshManagedChildHost(live.ctx, live.runner)
    const request = childRequest(cwd)
    const result = await host.run({ parent: parentAgent(cwd, live.ctx), ...request })

    expect(live.createOptions?.meta).toMatchObject({
      cwd,
      parentSession: 'parent-session',
      origin: 'subagent',
      delegationDepth: 1,
      agentPreset: CREATOR_PRESET_ID,
    })
    expect(live.createOptions?.agentOptions).toEqual({ provider: 'test', model: 'test-model' })
    expect(live.modes).toEqual(['workspace-write'])
    expect(result.sandbox).toMatchObject({ cwd, mode: 'workspace-write' })
    expect(live.preExecuteInstalled).toBe(true)
    expect(live.guardInstalled).toBe(true)
    expect(live.followups).toHaveLength(1)
    expect(result.taskResult).toMatch(/AUTOEVO_CHILD_COMPLETED$/u)
    expect(result.creator).toEqual(request.expectedReceipt(result.sessionId))
    expect(live.disposed).toHaveBeenCalledOnce()
  })

  it('fails closed and disposes when the created session cwd drifts from the managed root', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'autoevo-child-cwd-'))
    const outside = await mkdtemp(path.join(os.tmpdir(), 'autoevo-child-outside-'))
    temporary.push(cwd, outside)
    const live = runtime(cwd, true, { childCwd: outside })
    const host = new DshManagedChildHost(live.ctx, live.runner)

    await expect(host.run({ parent: parentAgent(cwd, live.ctx), ...childRequest(cwd) }))
      .rejects.toThrow(/expected session identity and managed cwd/i)
    expect(live.modes).toEqual([])
    expect(live.followups).toEqual([])
    expect(live.disposed).toHaveBeenCalledOnce()
  })

  it('fails closed on ownership mismatch and still disposes the child', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'autoevo-child-owner-'))
    temporary.push(cwd)
    const live = runtime(cwd, false)
    const host = new DshManagedChildHost(live.ctx, live.runner)

    await expect(host.run({ parent: parentAgent(cwd, live.ctx), ...childRequest(cwd) }))
      .rejects.toThrow(/not owned/i)
    expect(live.disposed).toHaveBeenCalledOnce()
  })

  it('disposes a running child promptly when the parent turn is cancelled', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'autoevo-child-cancel-'))
    temporary.push(cwd)
    let resolveIdle!: () => void
    const idle = new Promise<void>((resolve) => { resolveIdle = resolve })
    const live = runtime(cwd, true, {
      whenIdle: () => idle,
      onDispose: () => resolveIdle(),
    })
    const host = new DshManagedChildHost(live.ctx, live.runner)
    const controller = new AbortController()
    const running = host.run({
      parent: parentAgent(cwd, live.ctx),
      ...childRequest(cwd),
      signal: controller.signal,
    })
    await vi.waitFor(() => expect(live.followups).toHaveLength(1))
    controller.abort()
    await expect(running).rejects.toThrow(/cancelled by the user/i)
    expect(live.disposed).toHaveBeenCalledOnce()
  })
})
