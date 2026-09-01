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
  disposeError?: Error
  childCwd?: string
  emitShell?: (emit: (exec: {
    name: string
    arguments: unknown
  }, result: { isError: boolean; value?: unknown; content: unknown[]; meta?: unknown }) => void) => Promise<void> | void
} = {}) {
  const modes: string[] = []
  const services = sandboxServices(cwd, modes)
  const catalog = creatorCatalogServices()
  const disposed = vi.fn(async () => {
    lifecycle.onDispose?.()
    if (lifecycle.disposeError) throw lifecycle.disposeError
  })
  const followups: UserMessage[] = []
  let createOptions: CreateAgentOptions | undefined
  let preExecuteInstalled = false
  let resultInstalled = false
  let resultHandler: ((exec: unknown, result: unknown) => void) | undefined
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
        async whenIdle() {
          if (lifecycle.emitShell && resultHandler) {
            await lifecycle.emitShell((exec, result) => resultHandler?.(exec, result))
          }
          await lifecycle.whenIdle?.()
        },
      } as unknown as Agent
      try {
        await options.setup?.({
          agent: child,
          get(name: string) {
            if (name === 'tools') return catalog.tools
            if (name === 'skills') return catalog.skills
            return undefined
          },
          on: (name: string, handler?: (...args: unknown[]) => unknown) => {
            if (name === 'tools/pre-execute') preExecuteInstalled = true
            if (name === 'tools/result') {
              resultInstalled = true
              resultHandler = handler as (exec: unknown, result: unknown) => void
            }
          },
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
    get resultInstalled() { return resultInstalled },
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
  it('instructs the child to materialize declared dependencies with a safe pnpm install', () => {
    const instruction = managedChildTesting.childInstruction('/managed', testingCreatorWorkOrder('/managed'))
    expect(instruction).toContain('pnpm install --ignore-scripts')
    expect(instruction).toContain('no package arguments')
    expect(instruction).toContain('pnpm add/update/remove/dlx')
    expect(instruction).toContain('npx')
    expect(instruction).toMatch(/genuinely run builds and tests/)
    expect(instruction).toMatch(/72-step soft budget/)
    expect(instruction).not.toMatch(/Host rejects dependency mutation/)
    expect(instruction).not.toMatch(/Do not run package install/)
    expect(instruction).not.toMatch(/Do not install or claim success/)
  })

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

  it('scales the step budget with extra acceptance targets and caps it', () => {
    const base = testingCreatorWorkOrder('/managed')
    expect(managedChildTesting.childStepBudgetFor(base)).toEqual({
      soft: managedChildTesting.CHILD_SOFT_STEP_LIMIT,
      hard: managedChildTesting.CHILD_HARD_STEP_LIMIT,
    })
    const scaled = managedChildTesting.childStepBudgetFor({
      ...base,
      acceptanceTargets: Array.from({ length: 8 }, (_, index) => `target ${index + 1}`),
    })
    expect(scaled).toEqual({ soft: 92, hard: 100 })
    const capped = managedChildTesting.childStepBudgetFor({
      ...base,
      acceptanceTargets: Array.from({ length: 40 }, (_, index) => `target ${index + 1}`),
    })
    expect(capped).toEqual({
      soft: managedChildTesting.CHILD_SOFT_STEP_CAP,
      hard: managedChildTesting.CHILD_HARD_STEP_CAP,
    })
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
    expect(live.resultInstalled).toBe(true)
    expect(live.guardInstalled).toBe(true)
    expect(live.followups).toHaveLength(1)
    expect(result.taskResult).toMatch(/AUTOEVO_CHILD_COMPLETED$/u)
    expect(result.hostObservedChecks).toEqual([])
    expect(result.creator).toEqual(request.expectedReceipt(result.sessionId))
    expect(live.disposed).toHaveBeenCalledOnce()
  })

  it('records Host-observed shell command results from the child tools/result stream', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'autoevo-child-observe-'))
    temporary.push(cwd)
    const live = runtime(cwd, true, {
      emitShell(emit) {
        emit(
          { name: 'pwsh', arguments: { command: 'pnpm test', cwd } },
          { isError: false, value: { exitCode: 0, stdout: '1 passed' }, content: [] },
        )
        emit(
          { name: 'pwsh', arguments: { command: 'git status', cwd } },
          { isError: false, value: { exitCode: 0 }, content: [] },
        )
        emit(
          { name: 'read', arguments: { path: 'package.json' } },
          { isError: false, value: '{}', content: [] },
        )
      },
    })
    const host = new DshManagedChildHost(live.ctx, live.runner)
    const result = await host.run({ parent: parentAgent(cwd, live.ctx), ...childRequest(cwd) })
    expect(result.hostObservedChecks).toEqual([
      { command: 'pnpm test', exitCode: 0, matchesAcceptance: true, stdoutTail: '1 passed' },
      { command: 'git status', exitCode: 0, matchesAcceptance: false },
    ])
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

  it('does not send a followup when cancellation occurs immediately after the sandbox probe', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'autoevo-child-probe-abort-'))
    temporary.push(cwd)
    const live = runtime(cwd)
    const controller = new AbortController()
    const reason = new Error('cancel after sandbox probe')
    const probe = vi.fn(async () => {
      controller.abort(reason)
      return {
        ok: true as const,
        mode: 'workspace-write' as const,
        cwd,
        platform: process.platform,
        enforcement: 'partial' as const,
        isolation: 'integrity-partial' as const,
        note: 'test probe',
      }
    })
    const host = new DshManagedChildHost(live.ctx, live.runner, probe)

    await expect(host.run({
      parent: parentAgent(cwd, live.ctx),
      ...childRequest(cwd),
      signal: controller.signal,
    })).rejects.toBe(reason)
    expect(probe).toHaveBeenCalledOnce()
    expect(live.followups).toEqual([])
    expect(live.disposed).toHaveBeenCalledOnce()
  })

  it('preserves the exact managed-child primary error when dispose also fails', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'autoevo-child-primary-dispose-'))
    temporary.push(cwd)
    const primary = new Error('managed child primary failure')
    const cleanup = new Error('managed child dispose failure')
    const live = runtime(cwd, true, {
      whenIdle: async () => { throw primary },
      disposeError: cleanup,
    })
    const host = new DshManagedChildHost(live.ctx, live.runner)

    let failure: unknown
    try {
      await host.run({ parent: parentAgent(cwd, live.ctx), ...childRequest(cwd) })
    } catch (error) {
      failure = error
    }
    expect(failure).toBe(primary)
    expect(live.disposed).toHaveBeenCalledOnce()
  })

  it('rejects with the managed-child dispose error when the primary operation succeeds', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'autoevo-child-success-dispose-'))
    temporary.push(cwd)
    const cleanup = new Error('managed child dispose failure')
    const live = runtime(cwd, true, { disposeError: cleanup })
    const host = new DshManagedChildHost(live.ctx, live.runner)

    let failure: unknown
    try {
      await host.run({ parent: parentAgent(cwd, live.ctx), ...childRequest(cwd) })
    } catch (error) {
      failure = error
    }
    expect(failure).toBe(cleanup)
    expect(live.disposed).toHaveBeenCalledOnce()
  })

  it('preserves managed-child cancellation classification when dispose fails', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'autoevo-child-cancel-dispose-'))
    temporary.push(cwd)
    let resolveIdle!: () => void
    const idle = new Promise<void>((resolve) => { resolveIdle = resolve })
    const live = runtime(cwd, true, {
      whenIdle: () => idle,
      onDispose: resolveIdle,
      disposeError: new Error('managed child dispose failure'),
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

    await expect(running).rejects.toMatchObject({
      code: 'command_failed',
      details: { cancelled: true },
    })
    expect(live.disposed).toHaveBeenCalledOnce()
  })
})
