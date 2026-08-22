import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { Agent, AgentHandle, AgentRegistry, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import { setSandboxMode, type SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { SessionId, type UserMessage } from '@deepseek-ai/dsh-session'
import {
  CREATOR_PRESET_ID,
  assertChildCreatorCatalog,
  assertWorkOrderScope,
  formatCreatorWorkOrder,
  mintCreatorReceipt,
  preflightCreatorFoundation,
  type CreatorFoundationPreflight,
  type CreatorFoundationReceipt,
  type CreatorWorkOrder,
} from './creator-foundation.js'
import { EvolutionError } from './errors.js'
import { ExecutionGuard } from './execution-guard.js'
import type { CommandRunner } from './process/runner.js'
import { probeWorkspaceWriteSandbox } from './sandbox-probe.js'

const CHILD_RESULT_MARKER = 'AUTOEVO_CHILD_COMPLETED'
const CHILD_SOFT_STEP_LIMIT = 48
const CHILD_HARD_STEP_LIMIT = 52
const CHILD_BUDGET_DENIAL = 'Managed child execution budget is exhausted; stop calling tools and return the final result marker now.'

function childBudgetMessage(): UserMessage {
  return createUserMessage({
    source: { kind: 'plugin', plugin: 'autoevo', form: 'relay' },
    content: [{
      type: 'text',
      text: `Host execution budget reached. Do not call any more tools or attempt more verification. Summarize the changes and checks already completed, state any skipped check honestly, and finish now with final line exactly ${CHILD_RESULT_MARKER}.`,
    }],
  })
}

class ChildTurnBudget {
  private forcingFinal = false

  async preStep(
    step: number,
    messages: UserMessage[],
    next: () => Promise<PreStepDecision>,
  ): Promise<PreStepDecision> {
    if (step >= CHILD_HARD_STEP_LIMIT) {
      this.forcingFinal = true
      return { kind: 'reject' }
    }
    const decision = await next()
    if (decision.kind === 'reject' || step < CHILD_SOFT_STEP_LIMIT) return decision
    this.forcingFinal = true
    return { kind: 'enter', messages: [...decision.messages, childBudgetMessage()] }
  }

  denialReason(): string | undefined {
    return this.forcingFinal ? CHILD_BUDGET_DENIAL : undefined
  }
}

export interface ManagedChildRequest {
  parent: Agent
  cwd: string
  workOrder: CreatorWorkOrder
  preflight?: CreatorFoundationPreflight
  signal?: AbortSignal
}

export interface ManagedChildResult {
  sessionId: string
  taskResult: string
  sandbox: Awaited<ReturnType<typeof probeWorkspaceWriteSandbox>>
  creator: CreatorFoundationReceipt
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
    mount(agentCtx: Context, id?: string): Promise<{ id: string; trust?: string }>
    composedPreset(agentCtx: Context): string | undefined
    read(id: string): Promise<string>
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

function childInstruction(cwd: string, workOrder: CreatorWorkOrder): string {
  return `You are the AutoEvo managed-source implementation child on the official Creator (cordis) preset.

Your exact workspace is: ${JSON.stringify(cwd)}

Creator work order:
${formatCreatorWorkOrder(workOrder)}

Rules enforced by the Host:
- Official Creator constructs; AutoEvo governs. Load only cordis-plugin-development and editing-cordis-compositions. Do not load autoevo-plugin-creator.
- Use cordis_inspect_list, cordis_inspect_query, and cordis_inspect_self when you need live runtime facts. Never call cordis_define, cordis_run, cordis_stop, cordis_undefine, cordis_mount, or cordis_unmount.
- Work only inside the exact workspace. Do not inspect or change sibling paths.
- Spend at most 12 model steps inspecting and make the first source edit before step 16. Do not substitute broad installed-package/runtime exploration for implementing the smallest in-repository solution.
- Do not call AutoEvo decision tools, nested delegation, plugin install/remove, gh, git writes, dependency mutation, version, publish, release, deploy, or install commands.
- Run appropriate local tests when available. Do not run package install/add/ci/dlx/exec commands or install new dependencies from the network; the Host rejects dependency mutation.
- Keep verification bounded: attempt the project's normal test command at most once, then one build or typecheck that does not hit the same sandbox denial.
- On Windows, a test runner that reports spawn EPERM because confined processes cannot open piped stdio is a final sandbox limitation. Do not retry it, create alternate runners/configs, or modify test infrastructure to work around it; report the skipped test and continue to the final diff review.
- The Host enforces a ${CHILD_SOFT_STEP_LIMIT}-step soft budget. Finish before it; after that the Host denies further tools and requires the final marker.
- Do not commit; the Host performs the reviewed hookless unsigned commit after you return.
- Do not install or claim success; Host re-review and freeze decide that.
- Finish with a short result whose final line is exactly ${CHILD_RESULT_MARKER}.
`
}

/** Real Host-owned DSH child lifecycle. */
export class DshManagedChildHost implements ManagedChildHost {
  constructor(
    private readonly ctx: Context,
    private readonly runner: CommandRunner,
  ) {}

  async run(_request: ManagedChildRequest): Promise<ManagedChildResult> {
    throw new EvolutionError(
      'invalid_input',
      'AutoEvo Host no longer creates child Agents; construction continues in the parent session',
    )
  }
}

export const _testing = {
  assistantText,
  assertCompletedTurn,
  childInstruction,
  childBudgetMessage,
  ChildTurnBudget,
  CHILD_RESULT_MARKER,
  CHILD_SOFT_STEP_LIMIT,
  CHILD_HARD_STEP_LIMIT,
  CHILD_BUDGET_DENIAL,
  waitForIdleOrAbort,
}

function managedChildCancelled(): EvolutionError {
  return new EvolutionError('command_failed', 'Managed child cancelled by the user', {
    cancelled: true,
  })
}

async function waitForIdleOrAbort(
  handle: AgentHandle,
  signal: AbortSignal | undefined,
  dispose: () => Promise<void>,
): Promise<void> {
  if (!signal) {
    await handle.agent.whenIdle()
    return
  }
  if (signal.aborted) {
    await dispose()
    throw managedChildCancelled()
  }

  let onAbort: (() => void) | undefined
  const aborted = new Promise<'aborted'>((resolve) => {
    onAbort = () => resolve('aborted')
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    const outcome = await Promise.race([
      handle.agent.whenIdle().then(() => 'idle' as const),
      aborted,
    ])
    if (outcome === 'aborted') {
      await dispose()
      throw managedChildCancelled()
    }
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}
