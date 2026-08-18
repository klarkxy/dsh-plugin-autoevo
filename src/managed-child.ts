import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import { setSandboxMode, type SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { SessionId } from '@deepseek-ai/dsh-session'
import { EvolutionError } from './errors.js'
import { ExecutionGuard } from './execution-guard.js'
import type { CommandRunner } from './process/runner.js'
import { probeWorkspaceWriteSandbox } from './sandbox-probe.js'

const CHILD_RESULT_MARKER = 'AUTOEVO_CHILD_COMPLETED'

export interface ManagedChildRequest {
  parent: Agent
  cwd: string
  task: string
  signal?: AbortSignal
}

export interface ManagedChildResult {
  sessionId: string
  taskResult: string
  sandbox: Awaited<ReturnType<typeof probeWorkspaceWriteSandbox>>
}

export interface ManagedChildHost {
  run(request: ManagedChildRequest): Promise<ManagedChildResult>
}

interface LiveServices {
  agents: AgentRegistry
  sandbox: SandboxProvider
  sandboxPolicy: SandboxPolicyService
  fs: FileSystem
  agentPresets: {
    mount(agentCtx: Context, id?: string): Promise<{ id: string }>
    composedPreset(agentCtx: Context): string | undefined
  }
}

function requireLiveServices(ctx: Context): LiveServices {
  const agents = ctx.get('agents') as AgentRegistry | undefined
  const sandbox = ctx.get('sandbox') as SandboxProvider | undefined
  const sandboxPolicy = ctx.get('sandboxPolicy') as SandboxPolicyService | undefined
  const fs = ctx.get('fs') as FileSystem | undefined
  const agentPresets = ctx.get('agentPresets') as LiveServices['agentPresets'] | undefined
  if (!agents || !sandbox || !sandboxPolicy || !fs || !agentPresets) {
    throw new EvolutionError('invalid_input', 'DSH Agent, preset, sandbox, sandbox-policy, and sandboxed filesystem services are required for managed modify/create', {
      reason: 'missing_child_runtime_service',
    })
  }
  return { agents, sandbox, sandboxPolicy, fs, agentPresets }
}

function assistantText(agent: Agent): string {
  const messages = agent.session.deriveMessages()
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'assistant') continue
    return message.content
      .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim()
  }
  return ''
}

function assertCompletedTurn(agent: Agent): void {
  const lastEnd = [...agent.session.events].reverse().find((event) => event.type === 'turn/end')
  if (!lastEnd || lastEnd.type !== 'turn/end' || lastEnd.data.reason.kind !== 'completed') {
    throw new EvolutionError('command_failed', 'Managed child did not complete its implementation turn', {
      reason: lastEnd?.type === 'turn/end' ? lastEnd.data.reason.kind : 'missing_turn_end',
    })
  }
}

function childInstruction(task: string, cwd: string): string {
  return `You are the AutoEvo managed-source implementation child.

Your exact workspace is: ${JSON.stringify(cwd)}

Implement only this Host-authored task:
${task}

Rules enforced by the Host:
- Work only inside the exact workspace. Do not inspect or change sibling paths.
- Do not call AutoEvo decision tools, Cordis mutation, plugin install/remove, delegation, push, tag, release, or PR tools.
- Run appropriate local tests when available. Do not install new dependencies from the network.
- Do not commit; the Host performs the reviewed hookless unsigned commit after you return.
- Finish with a short result whose final line is exactly ${CHILD_RESULT_MARKER}.
`
}

/** Real Host-owned DSH child lifecycle. */
export class DshManagedChildHost implements ManagedChildHost {
  constructor(
    private readonly ctx: Context,
    private readonly runner: CommandRunner,
  ) {}

  async run(request: ManagedChildRequest): Promise<ManagedChildResult> {
    const services = requireLiveServices(this.ctx)
    const parentAgents = request.parent.ctx.get('agents') as AgentRegistry | undefined
    if (!parentAgents) {
      throw new EvolutionError('invalid_input', 'Initiating parent Agent context cannot access the Agent registry')
    }
    const cwd = path.resolve(request.cwd)
    const parentDepth = request.parent.session.header.delegationDepth ?? 0
    if (parentDepth !== 0) {
      throw new EvolutionError('invalid_input', 'Managed AutoEvo children may only be launched from a top-level parent session', {
        parentDepth,
      })
    }
    const childGuard = new ExecutionGuard({ role: 'child' })
    const sessionId = SessionId(`autoevo-child-${randomUUID()}`)
    const handle = await parentAgents.create({
      sessionId,
      meta: {
        cwd,
        parentSession: request.parent.id,
        origin: 'subagent',
        delegationDepth: 1,
        agentPreset: 'code',
      },
      agentOptions: { ...request.parent.options },
      ...(request.signal ? { signal: request.signal } : {}),
      setup: async (agentCtx) => {
        const child = agentCtx.agent
        if (!child || child.id !== sessionId || path.resolve(child.session.header.cwd ?? '') !== cwd) {
          throw new EvolutionError('invalid_input', 'DSH child setup did not bind the expected session identity and managed cwd')
        }
        setSandboxMode(child.session, 'workspace-write')
        const mounted = await services.agentPresets.mount(agentCtx, 'code')
        if (mounted.id !== 'code' || services.agentPresets.composedPreset(agentCtx) !== 'code') {
          throw new EvolutionError('invalid_input', 'Managed child did not mount the expected code preset')
        }
        agentCtx.on('tools/pre-execute', (exec, next) => childGuard.preExecute(exec, next))
        agentCtx.tools.guard((exec) => childGuard.guard(exec))
        agentCtx.systemPrompt.section({
          name: 'autoevo:managed-child-boundary',
          order: 119,
          text: 'This is a Host-owned AutoEvo managed-source child. The session cwd and workspace-write sandbox are fixed to one managed Git repository. AutoEvo decisions, Cordis mutation, delegation, plugin mutation, and publication are forbidden.',
        })
      },
    })

    try {
      if (!services.agents.isOwnedBy(handle.agent.id, request.parent)) {
        throw new EvolutionError('invalid_input', 'Created child is not owned by the initiating parent Agent')
      }
      if (path.resolve(handle.agent.session.header.cwd ?? '') !== cwd) {
        throw new EvolutionError('invalid_input', 'Created child cwd does not match the managed source repository')
      }
      const sandbox = await probeWorkspaceWriteSandbox({
        sandbox: services.sandbox,
        sandboxPolicy: services.sandboxPolicy,
        fs: services.fs,
        runner: this.runner,
      }, handle.agent.session, cwd, request.signal)

      handle.agent.followup(createUserMessage({
        source: { kind: 'plugin', plugin: 'autoevo', form: 'relay' },
        content: [{ type: 'text', text: childInstruction(request.task, cwd) }],
      }))
      await handle.agent.whenIdle()
      assertCompletedTurn(handle.agent)
      const taskResult = assistantText(handle.agent)
      if (!taskResult.endsWith(CHILD_RESULT_MARKER)) {
        throw new EvolutionError('command_failed', 'Managed child completed without the required task-result marker')
      }
      return { sessionId: String(handle.agent.id), taskResult, sandbox }
    } finally {
      await handle.dispose()
    }
  }
}

export const _testing = { assistantText, assertCompletedTurn, childInstruction, CHILD_RESULT_MARKER }
