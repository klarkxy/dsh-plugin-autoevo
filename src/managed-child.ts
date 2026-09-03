import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { Agent, AgentHandle, AgentRegistry, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import { setSandboxMode, type SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { SessionId, type UserMessage } from '@deepseek-ai/dsh-session'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import {
  CREATOR_PRESET_ID,
  assertChildCreatorCatalog,
  assertWorkOrderScope,
  commandMatchesAcceptanceTarget,
  formatCreatorWorkOrder,
  isCreatorShellTool,
  mintCreatorReceipt,
  preflightCreatorFoundation,
  type CreatorFoundationPreflight,
  type CreatorFoundationReceipt,
  type CreatorWorkOrder,
  type HostObservedCheck,
} from './creator-foundation.js'
import { EvolutionError } from './errors.js'
import { ExecutionGuard } from './execution-guard.js'
import { isPathInside, isRecord } from './internal-utils.js'
import type { CommandRunner } from './process/runner.js'
import { probeWorkspaceWriteSandbox } from './sandbox-probe.js'

const CHILD_RESULT_MARKER = 'AUTOEVO_CHILD_COMPLETED'
const CHILD_SOFT_STEP_LIMIT = 72
const CHILD_HARD_STEP_LIMIT = 80
const CHILD_SOFT_STEP_CAP = 112
const CHILD_HARD_STEP_CAP = 120
const CHILD_BUDGET_DENIAL = 'Managed child execution budget is exhausted; stop calling tools and return the final result marker now.'
const MAX_HOST_OBSERVED_CHECKS = 24
const MAX_OBSERVED_COMMAND = 180
const MAX_OBSERVED_STDOUT_TAIL = 160

export interface ChildStepBudget {
  soft: number
  hard: number
}

export function childStepBudgetFor(workOrder: CreatorWorkOrder): ChildStepBudget {
  const extra = Math.max(0, workOrder.acceptanceTargets.length - 3) * 4
  return {
    soft: Math.min(CHILD_SOFT_STEP_LIMIT + extra, CHILD_SOFT_STEP_CAP),
    hard: Math.min(CHILD_HARD_STEP_LIMIT + extra, CHILD_HARD_STEP_CAP),
  }
}

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

  constructor(private readonly limits: ChildStepBudget = {
    soft: CHILD_SOFT_STEP_LIMIT,
    hard: CHILD_HARD_STEP_LIMIT,
  }) {}

  async preStep(step: number, next: () => Promise<PreStepDecision>): Promise<PreStepDecision> {
    if (step >= this.limits.hard) {
      this.forcingFinal = true
      return { kind: 'reject' }
    }
    const decision = await next()
    if (decision.kind === 'reject' || step < this.limits.soft) return decision
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
  hostObservedChecks?: HostObservedCheck[]
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

function childInstruction(cwd: string, workOrder: CreatorWorkOrder, budget = childStepBudgetFor(workOrder)): string {
  return `You are the AutoEvo managed-source implementation child on the official Creator (cordis) preset.

Your exact workspace is: ${JSON.stringify(cwd)}

Creator work order:
${formatCreatorWorkOrder(workOrder)}

Rules enforced by the Host:
- Official Creator constructs; AutoEvo governs. Load only cordis-plugin-development and editing-cordis-compositions. Do not load autoevo-plugin-creator.
- Use cordis_inspect_list, cordis_inspect_query, and cordis_inspect_self when you need live runtime facts. Never call cordis_define, cordis_run, cordis_stop, cordis_undefine, cordis_mount, or cordis_unmount.
- Work only inside the exact workspace. Do not inspect or change sibling paths.
- Spend at most 12 model steps inspecting and make the first source edit before step 16. Do not substitute broad installed-package/runtime exploration for implementing the smallest in-repository solution.
- Do not call AutoEvo decision tools, nested delegation, plugin install/remove, gh, git writes, CLI dependency mutation (\`pnpm add/update/remove/dlx\`, \`npx\`), version, publish, or release/deploy commands.
- You may declare dependencies in package.json and materialize them with \`pnpm install --ignore-scripts\` (no package arguments), then genuinely run builds and tests.
- Keep verification bounded: attempt the project's normal test command at most once, then one build or typecheck that does not hit the same sandbox denial.
- On Windows, a test runner that reports spawn EPERM because confined processes cannot open piped stdio is a final sandbox limitation. Do not retry it, create alternate runners/configs, or modify test infrastructure to work around it; report the skipped test and continue to the final diff review.
- The Host enforces a ${budget.soft}-step soft budget. Finish before it; after that the Host denies further tools and requires the final marker.
- Do not commit; the Host performs the reviewed hookless unsigned commit after you return.
- Do not publish or claim success; Host re-review and freeze decide that.
- Finish with a short result whose final line is exactly ${CHILD_RESULT_MARKER}.
`
}

function sanitizeObservedCommand(command: string): string {
  const normalized = command.normalize('NFKC').replace(/\s+/gu, ' ').trim()
  if (normalized.length <= MAX_OBSERVED_COMMAND) return normalized
  return `${normalized.slice(0, MAX_OBSERVED_COMMAND - 1)}…`
}

function shellCommandFromArguments(args: unknown): string {
  if (!isRecord(args)) return ''
  for (const key of ['command', 'cmd', 'script']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  const argv = args.argv
  if (Array.isArray(argv) && argv.every((item) => typeof item === 'string')) {
    return argv.join(' ')
  }
  return ''
}

function shellCwdFromArguments(args: unknown, sessionCwd: string): string {
  if (!isRecord(args)) return sessionCwd
  for (const key of ['cwd', 'working_directory', 'workdir', 'workingDirectory']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) {
      return path.resolve(sessionCwd, value)
    }
  }
  return sessionCwd
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.flatMap((block) => {
    if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') return []
    return [block.text]
  }).join('\n')
}

function integerOrNull(value: unknown): number | null | undefined {
  if (value === null) return null
  if (typeof value === 'number' && Number.isInteger(value)) return value
  return undefined
}

function exitCodeFromUnknown(value: unknown): number | null | undefined {
  const direct = integerOrNull(value)
  if (direct !== undefined) return direct
  if (!isRecord(value)) return undefined
  for (const key of ['exitCode', 'exit_code', 'code', 'status']) {
    const found = integerOrNull(value[key])
    if (found !== undefined) return found
  }
  if ('outcome' in value) {
    const nested = exitCodeFromUnknown(value.outcome)
    if (nested !== undefined) return nested
  }
  return undefined
}

function stdoutTailFromUnknown(value: unknown): string {
  if (typeof value === 'string') return value
  if (!isRecord(value)) return ''
  for (const key of ['stdout', 'output', 'stderr']) {
    const text = value[key]
    if (typeof text === 'string' && text.trim()) return text
  }
  return ''
}

function exitCodeFromResult(result: Readonly<ToolExecutionResult>): number | null {
  if (!result.isError) {
    const fromValue = exitCodeFromUnknown(result.value)
    if (fromValue !== undefined) return fromValue
  }
  const fromMeta = exitCodeFromUnknown(result.meta)
  if (fromMeta !== undefined) return fromMeta
  const fromContent = /exit(?:\s+code)?[:\s]+(-?\d+)/iu.exec(contentText(result.content))
  if (fromContent) return Number(fromContent[1])
  return result.isError ? 1 : 0
}

function stdoutTailFromResult(result: Readonly<ToolExecutionResult>): string | undefined {
  const chunks = [
    result.isError ? '' : stdoutTailFromUnknown(result.value),
    stdoutTailFromUnknown(result.meta),
    contentText(result.content),
  ].filter((item) => item.length > 0)
  if (chunks.length === 0) return undefined
  const combined = chunks.join('\n').normalize('NFKC').replace(/\s+/gu, ' ').trim()
  if (!combined) return undefined
  return combined.length <= MAX_OBSERVED_STDOUT_TAIL
    ? combined
    : combined.slice(-MAX_OBSERVED_STDOUT_TAIL)
}

class ChildShellObserver {
  private readonly observed: HostObservedCheck[] = []

  constructor(
    private readonly root: string,
    private readonly workOrder: CreatorWorkOrder,
  ) {}

  noteResult(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): void {
    if (!isCreatorShellTool(exec.name)) return
    const command = sanitizeObservedCommand(shellCommandFromArguments(exec.arguments))
    if (!command) return
    const cwd = shellCwdFromArguments(exec.arguments, this.root)
    if (!isPathInside(this.root, cwd)) return
    if (this.observed.length >= MAX_HOST_OBSERVED_CHECKS) return
    const check: HostObservedCheck = {
      command,
      exitCode: exitCodeFromResult(result),
      matchesAcceptance: commandMatchesAcceptanceTarget(command, this.workOrder.acceptanceTargets),
    }
    const stdoutTail = stdoutTailFromResult(result)
    if (stdoutTail) check.stdoutTail = stdoutTail
    this.observed.push(check)
  }

  snapshot(): HostObservedCheck[] {
    return [...this.observed]
  }
}

/** Real Host-owned DSH child lifecycle. */
export class DshManagedChildHost implements ManagedChildHost {
  constructor(
    private readonly ctx: Context,
    private readonly runner: CommandRunner,
    private readonly probeSandbox: typeof probeWorkspaceWriteSandbox = probeWorkspaceWriteSandbox,
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
    assertWorkOrderScope(request.workOrder, cwd)
    const preflight = request.preflight ?? await preflightCreatorFoundation(this.ctx, {
      ...(request.signal ? { signal: request.signal } : {}),
      parentCtx: request.parent.ctx,
    })
    const childGuard = new ExecutionGuard({ role: 'child' })
    const budgetLimits = childStepBudgetFor(request.workOrder)
    const childBudget = new ChildTurnBudget(budgetLimits)
    const shellObserver = new ChildShellObserver(cwd, request.workOrder)
    const sessionId = SessionId(`autoevo-child-${randomUUID()}`)
    const handle = await parentAgents.create({
      sessionId,
      meta: {
        cwd,
        parentSession: request.parent.id,
        origin: 'subagent',
        delegationDepth: 1,
        agentPreset: CREATOR_PRESET_ID,
      },
      agentOptions: { ...request.parent.options },
      ...(request.signal ? { signal: request.signal } : {}),
      setup: async (agentCtx) => {
        const child = agentCtx.agent
        if (!child || child.id !== sessionId || path.resolve(child.session.header.cwd ?? '') !== cwd) {
          throw new EvolutionError('invalid_input', 'DSH child setup did not bind the expected session identity and managed cwd')
        }
        setSandboxMode(child.session, 'workspace-write')
        const mounted = await services.agentPresets.mount(agentCtx, CREATOR_PRESET_ID)
        const composed = services.agentPresets.composedPreset(agentCtx)
        await assertChildCreatorCatalog(agentCtx, child, preflight, mounted, composed)
        agentCtx.on('agent/pre-step', ({ step }, next) => childBudget.preStep(step, next))
        agentCtx.on('tools/pre-execute', (exec, next) => {
          const budgetDenial = childBudget.denialReason()
          return budgetDenial ? Promise.resolve({ kind: 'deny', reason: budgetDenial }) : childGuard.preExecute(exec, next)
        })
        agentCtx.on('tools/result', (exec, result) => {
          shellObserver.noteResult(exec, result)
        })
        agentCtx.tools.guard((exec) => childGuard.guard(exec))
        agentCtx.systemPrompt.section({
          name: 'autoevo:managed-child-boundary',
          order: 119,
          text: 'This is a Host-owned AutoEvo managed-source child on the official Creator cordis preset. The session cwd and workspace-write sandbox are fixed to one managed Git repository. AutoEvo decisions, Cordis mutation, nested delegation, plugin mutation, and publication are forbidden. Official Creator constructs; AutoEvo governs.',
        })
      },
    })

    let disposePromise: Promise<void> | undefined
    const dispose = (): Promise<void> => {
      disposePromise ??= handle.dispose()
      return disposePromise
    }

    let primaryFailed = false
    try {
      if (!services.agents.isOwnedBy(handle.agent.id, request.parent)) {
        throw new EvolutionError('invalid_input', 'Created child is not owned by the initiating parent Agent')
      }
      // Session identity and cwd were bound inside `setup` on this same registry.create call.
      const sandbox = await this.probeSandbox({
        sandbox: services.sandbox,
        sandboxPolicy: services.sandboxPolicy,
        fs: services.fs,
        runner: this.runner,
      }, handle.agent.session, cwd, request.signal)
      request.signal?.throwIfAborted()

      handle.agent.followup(createUserMessage({
        source: { kind: 'plugin', plugin: 'autoevo', form: 'relay' },
        content: [{ type: 'text', text: childInstruction(cwd, request.workOrder, budgetLimits) }],
      }))
      await waitForIdleOrAbort(handle, request.signal)
      assertCompletedTurn(handle.agent)
      const taskResult = assistantText(handle.agent)
      if (!taskResult.endsWith(CHILD_RESULT_MARKER)) {
        throw new EvolutionError('command_failed', 'Managed child completed without the required task-result marker')
      }
      const childSessionId = String(handle.agent.id)
      return {
        sessionId: childSessionId,
        taskResult,
        sandbox,
        creator: mintCreatorReceipt(preflight, childSessionId),
        hostObservedChecks: shellObserver.snapshot(),
      }
    } catch (error) {
      primaryFailed = true
      throw error
    } finally {
      try {
        await dispose()
      } catch (error) {
        if (!primaryFailed) throw error
      }
    }
  }
}

export const _testing = {
  assistantText,
  assertCompletedTurn,
  childInstruction,
  childBudgetMessage,
  childStepBudgetFor,
  ChildTurnBudget,
  ChildShellObserver,
  CHILD_RESULT_MARKER,
  CHILD_SOFT_STEP_LIMIT,
  CHILD_HARD_STEP_LIMIT,
  CHILD_SOFT_STEP_CAP,
  CHILD_HARD_STEP_CAP,
  CHILD_BUDGET_DENIAL,
  MAX_HOST_OBSERVED_CHECKS,
  MAX_OBSERVED_COMMAND,
  shellCommandFromArguments,
  exitCodeFromResult,
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
): Promise<void> {
  if (!signal) {
    await handle.agent.whenIdle()
    return
  }
  if (signal.aborted) {
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
      throw managedChildCancelled()
    }
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}
