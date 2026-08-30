import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { CreationGuard } from '../../src/creation-guard.js'
import {
  DshRepairChildHost,
  FaultRepairMode,
  _testing,
  type RepairChildHost,
  type RepairChildResult,
} from '../../src/repair-mode.js'

function parentAgent(id = 'session-parent'): Agent {
  return {
    id,
    options: { provider: 'test', model: 'test-model' },
    session: {
      header: { id, cwd: 'C:\\workspace', delegationDepth: 0 },
    },
  } as unknown as Agent
}

function execution(agent: Agent): ToolRunContext {
  return {
    agent,
    signal: new AbortController().signal,
  } as unknown as ToolRunContext
}

describe('full-access fault repair gate', () => {
  it('requires a fresh user turn, consumes the ticket once, and relays the sealed objective', async () => {
    const guard = new CreationGuard({ bootId: 'boot-repair' })
    const parent = parentAgent()
    guard.rememberUserMessage(parent, { content: [{ type: 'text', text: 'prepare a repair' }] })
    const result: RepairChildResult = {
      sessionId: 'autoevo-repair-result',
      taskResult: `repaired and verified\n${_testing.REPAIR_RESULT_MARKER}`,
      permissionPreset: 'danger-full-access',
      permissionSource: 'permission_preset',
      agentPreset: 'standard',
    }
    const child: RepairChildHost = { run: vi.fn(async () => result) }
    const mode = new FaultRepairMode(guard, child)
    const prepared = mode.prepare({
      objective: 'repair npm resolution and finish the original task',
      failureContext: 'npm shim could not locate its JavaScript CLI',
    }, execution(parent))

    expect(prepared).toMatchObject({
      objective: 'repair npm resolution and finish the original task',
      status: 'awaiting_confirmation',
      permissionPreset: 'danger-full-access',
      approvalPolicy: 'never',
      scope: 'local_machine',
      confirmationRequired: true,
    })
    await expect(mode.resume({ repairId: prepared.repairId }, execution(parent)))
      .rejects.toThrow(/fresh user turn/i)

    guard.rememberUserMessage(parent, { content: [{ type: 'text', text: '同意，开始完整权限修理' }] })
    await expect(mode.resume({ repairId: prepared.repairId }, execution(parent))).resolves.toEqual({
      status: 'completed',
      ...result,
    })
    expect(child.run).toHaveBeenCalledWith(expect.objectContaining({
      parent,
      cwd: 'C:\\workspace',
      objective: 'repair npm resolution and finish the original task',
      failureContext: 'npm shim could not locate its JavaScript CLI',
    }))
    await expect(mode.resume({ repairId: prepared.repairId }, execution(parent)))
      .rejects.toThrow(/already consumed/i)
  })

  it('rejects a cross-session confirmation', async () => {
    const guard = new CreationGuard({ bootId: 'boot-repair' })
    const parent = parentAgent('session-one')
    const other = parentAgent('session-two')
    guard.rememberUserMessage(parent, { content: [{ type: 'text', text: 'prepare' }] })
    guard.rememberUserMessage(other, { content: [{ type: 'text', text: 'confirm' }] })
    const mode = new FaultRepairMode(guard, { run: vi.fn() })
    const prepared = mode.prepare({ objective: 'repair the Host' }, execution(parent))
    guard.rememberUserMessage(other, { content: [{ type: 'text', text: 'yes' }] })
    await expect(mode.resume({ repairId: prepared.repairId }, execution(other)))
      .rejects.toThrow(/different Agent session/i)
  })
})

describe('DSH full-access repair Agent lifecycle', () => {
  it('mounts standard with danger-full-access, runs the task, and always disposes', async () => {
    const parent = parentAgent()
    let relayed = ''
    let createdId = ''
    const disposed = vi.fn(async () => {})
    const permissionSet = vi.fn()
    const childSession = {
      header: { id: '', cwd: 'C:\\workspace', delegationDepth: 1 },
      events: [{ type: 'turn/end', data: { reason: { kind: 'completed' } } }],
      deriveMessages: () => [{
        role: 'assistant',
        content: [{ type: 'text', text: `changed files and verified tests\n${_testing.REPAIR_RESULT_MARKER}` }],
      }],
    }
    const child = {
      id: '',
      options: parent.options,
      session: childSession,
      followup: vi.fn((message: { content: Array<{ type: string; text?: string }> }) => {
        relayed = message.content.map((block) => block.text ?? '').join('\n')
      }),
      whenIdle: vi.fn(async () => {}),
    } as unknown as Agent
    const registry = {
      create: vi.fn(async (options: {
        sessionId: string
        setup: (ctx: Context) => Promise<void>
      }) => {
        createdId = String(options.sessionId)
        ;(child as unknown as { id: string }).id = createdId
        childSession.header.id = createdId
        const agentCtx = {
          agent: child,
          systemPrompt: { section: vi.fn() },
        } as unknown as Context
        await options.setup(agentCtx)
        return { agent: child, dispose: disposed }
      }),
      isOwnedBy: vi.fn(() => true),
    } as unknown as AgentRegistry
    ;(parent as unknown as { ctx: Context }).ctx = {
      get: (name: string) => name === 'agents' ? registry : undefined,
    } as unknown as Context
    const hostCtx = {
      get: (name: string) => {
        if (name === 'permissionPresets') {
          return {
            names: ['workspace-write', 'danger-full-access'],
            set: permissionSet,
            current: () => 'danger-full-access',
          }
        }
        if (name === 'agentPresets') {
          return {
            mount: vi.fn(async () => ({ id: 'standard', trust: 'system' })),
            composedPreset: () => 'standard',
          }
        }
        return undefined
      },
    } as unknown as Context

    const result = await new DshRepairChildHost(hostCtx).run({
      parent,
      cwd: 'C:\\workspace',
      objective: 'repair any necessary project, Profile, plugin, or Host runtime fault',
      failureContext: 'ordinary permissions could not complete the task',
    })

    expect(createdId).toMatch(/^autoevo-repair-/u)
    expect(permissionSet).toHaveBeenCalledWith(childSession, 'danger-full-access')
    expect(relayed).toContain('unrestricted local file effects')
    expect(relayed).toContain('arbitrary shell commands')
    expect(relayed).toContain('not limited to predefined repair actions')
    expect(result).toMatchObject({
      sessionId: createdId,
      permissionPreset: 'danger-full-access',
      permissionSource: 'permission_preset',
      agentPreset: 'standard',
    })
    expect(disposed).toHaveBeenCalledTimes(1)
  })

  it('uses the equivalent durable sandbox and approval knobs on DSH 0.1.1', () => {
    const events: Array<{ type: string; data: Record<string, string> }> = []
    const session = {
      events,
      append(type: string, data: Record<string, string>) {
        events.push({ type, data })
      },
    } as unknown as Agent['session']
    const source = _testing.applyFullAccess({
      agents: {} as AgentRegistry,
      agentPresets: {} as never,
    }, session)

    expect(source).toBe('compatibility_knobs')
    expect(events).toEqual([
      { type: 'sandbox/mode', data: { mode: 'danger-full-access' } },
      { type: 'approval/policy', data: { policy: 'never' } },
    ])
  })
})
