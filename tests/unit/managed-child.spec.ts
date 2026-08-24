import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Agent, AgentHandle, AgentRegistry, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { trackTempDirs } from '../helpers/temp-dirs.js'
import {
  testingCreatorPreflight,
  testingCreatorWorkOrder,
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

// DshManagedChildHost.run refuses before touching any service; only the
// agents.create recorder matters, proving no child Agent is ever created.
function runtime() {
  let createOptions: CreateAgentOptions | undefined
  const agents = {
    async create(options: CreateAgentOptions): Promise<AgentHandle> {
      createOptions = options
      throw new Error('child Agent creation is not expected')
    },
  } as unknown as AgentRegistry
  const ctx = {
    get(name: string) {
      if (name === 'agents') return agents
      return undefined
    },
  } as unknown as Context
  const runner: CommandRunner = {
    async run() {
      throw new Error('shell runner is not expected')
    },
  }
  return { ctx, runner, get createOptions() { return createOptions } }
}

function childRequest(cwd: string) {
  return {
    cwd,
    workOrder: testingCreatorWorkOrder(cwd),
    preflight: testingCreatorPreflight(),
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

  it('refuses to create a child Agent', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'autoevo-child-host-'))
    temporary.push(cwd)
    const live = runtime()
    const host = new DshManagedChildHost(live.ctx, live.runner)
    await expect(host.run({ parent: parentAgent(cwd, live.ctx), ...childRequest(cwd) }))
      .rejects.toThrow(/no longer creates child Agents/i)
    expect(live.createOptions).toBeUndefined()
  })
})
