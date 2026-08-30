import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { Agent, AgentHandle, AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  effectiveSandboxMode,
  setSandboxMode,
} from '@deepseek-ai/dsh-sandbox-policy'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  effectiveApprovalPolicy,
  setApprovalPolicy,
} from '@deepseek-ai/dsh-user-approval'
import type { CreationGuard, DecisionTurnBoundary } from './creation-guard.js'
import { EvolutionError, errorMessage } from './errors.js'
import { ownerSessionId, sessionCwd } from './host-identity.js'
import { hashObject } from './state/hashes.js'

const REPAIR_PRESET_ID = 'standard'
const FULL_ACCESS_PRESET_ID = 'danger-full-access'
const REPAIR_RESULT_MARKER = 'AUTOEVO_REPAIR_COMPLETED'
const MAX_REPAIR_OBJECTIVE = 12_000
const MAX_FAILURE_CONTEXT = 24_000

export interface FaultRepairPrepareInput {
  objective: string
  failureContext?: string
}

export interface FaultRepairResumeInput {
  repairId: string
}

export interface FaultRepairTicketView {
  repairId: string
  objective: string
  status: 'awaiting_confirmation'
  permissionPreset: typeof FULL_ACCESS_PRESET_ID
  approvalPolicy: 'never'
  scope: 'local_machine'
  confirmationRequired: true
  message: string
}

export interface RepairChildRequest {
  parent: Agent
  cwd: string
  objective: string
  failureContext?: string
  signal?: AbortSignal
}

export interface RepairChildResult {
  sessionId: string
  taskResult: string
  permissionPreset: typeof FULL_ACCESS_PRESET_ID
  permissionSource: 'permission_preset' | 'compatibility_knobs'
  agentPreset: typeof REPAIR_PRESET_ID
}

export interface RepairChildHost {
  run(request: RepairChildRequest): Promise<RepairChildResult>
}

interface PermissionPresetsLike {
  readonly names?: readonly string[]
  set(session: Agent['session'], name: string): void
  current(events: readonly unknown[]): string
}

interface AgentPresetsLike {
  mount(agentCtx: Context, id?: string): Promise<{ id: string; trust?: string }>
  composedPreset(agentCtx: Context): string | undefined
}

interface RepairRuntimeServices {
  agents: AgentRegistry
  permissionPresets?: PermissionPresetsLike
  agentPresets: AgentPresetsLike
}

interface RepairTicket extends DecisionTurnBoundary {
  id: string
  objective: string
  failureContext?: string
  cwd: string
  status: 'awaiting_confirmation' | 'running' | 'completed' | 'failed'
  createdAt: string
  consumedTurnId?: string
  result?: RepairChildResult
  failure?: string
}

function boundedText(value: string, max: number, name: string): string {
  const normalized = value.normalize('NFKC').trim()
  if (!normalized) throw new EvolutionError('invalid_input', `${name} is required`)
  if (normalized.length > max) {
    throw new EvolutionError('invalid_input', `${name} exceeds the ${max}-character limit`)
  }
  return normalized
}

function runtimeServices(ctx: Context, parent: Agent): RepairRuntimeServices {
  const agents = parent.ctx.get('agents') as AgentRegistry | undefined
  const permissionPresets = ctx.get('permissionPresets') as PermissionPresetsLike | undefined
  const agentPresets = ctx.get('agentPresets') as AgentPresetsLike | undefined
  if (!agents || !agentPresets) {
    throw new EvolutionError('invalid_input', 'DSH Agent and standard preset services are required for full-access repair', {
      reason: 'missing_repair_runtime_service',
    })
  }
  return {
    agents,
    ...(permissionPresets ? { permissionPresets } : {}),
    agentPresets,
  }
}

function applyFullAccess(
  services: RepairRuntimeServices,
  session: Agent['session'],
): RepairChildResult['permissionSource'] {
  const presets = services.permissionPresets
  if (presets && (!presets.names || presets.names.includes(FULL_ACCESS_PRESET_ID))) {
    presets.set(session, FULL_ACCESS_PRESET_ID)
    if (presets.current(session.events) !== FULL_ACCESS_PRESET_ID) {
      throw new EvolutionError('invalid_input', 'DSH repair Agent did not enter the full-access permission preset')
    }
    return 'permission_preset'
  }

  // DSH 0.1.1 has the same durable sandbox/approval knobs but predates the
  // bundled PermissionPresetService. Write the exact equivalent pair.
  setSandboxMode(session, FULL_ACCESS_PRESET_ID)
  setApprovalPolicy(session, 'never')
  if (effectiveSandboxMode(session.events) !== FULL_ACCESS_PRESET_ID
    || effectiveApprovalPolicy(session.events) !== 'never') {
    throw new EvolutionError('invalid_input', 'DSH repair Agent did not enter the full-access compatibility policy')
  }
  return 'compatibility_knobs'
}

function repairInstruction(request: RepairChildRequest): string {
  return `You are a Host-owned DSH fault-repair Agent. The user explicitly confirmed a completion-first repair session with the official danger-full-access permission preset. You have unrestricted local file effects and no per-command approval prompts.

Repair objective:
${request.objective}

${request.failureContext ? `Observed failure context:\n${request.failureContext}\n` : ''}
Starting directory: ${JSON.stringify(request.cwd)}

Work autonomously until the objective is actually repaired and verified. Diagnose root causes, inspect and modify any necessary project, plugin, DSH Profile, dependency, configuration, runtime, or local host files; run arbitrary shell commands; install or update required dependencies; use network access; stop/restart subordinate processes when needed; and retry with new evidence. You are not limited to predefined repair actions or the AutoEvo plugin's own source tree. Do not stop merely because ordinary workspace permissions would have blocked an operation: this session is already full access. Do not ask the user for routine implementation choices; make reasonable completion-oriented decisions.

The grant covers local repair work needed for this objective. Do not publish, purchase, send external messages, rotate credentials, or make unrelated destructive changes unless the objective explicitly requires that effect. If the running DSH Host itself must restart, finish every preparatory and independently verifiable step first, then report the exact remaining restart boundary instead of terminating your own controller mid-write.

Your final response must state what changed, what was verified, and any remaining blocker. End with the exact final line ${REPAIR_RESULT_MARKER}.`
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

function assertCompletedRepair(agent: Agent): void {
  const lastEnd = [...agent.session.events].reverse().find((event) => event.type === 'turn/end')
  if (!lastEnd || lastEnd.type !== 'turn/end' || lastEnd.data.reason.kind !== 'completed') {
    throw new EvolutionError('command_failed', 'Full-access repair Agent did not complete its repair turn', {
      reason: lastEnd?.type === 'turn/end' ? lastEnd.data.reason.kind : 'missing_turn_end',
    })
  }
}

function repairCancelled(): EvolutionError {
  return new EvolutionError('command_failed', 'Full-access repair Agent was cancelled by the user', {
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
    throw repairCancelled()
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
      throw repairCancelled()
    }
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

/** Host-owned full-access repair Agent lifecycle. */
export class DshRepairChildHost implements RepairChildHost {
  constructor(private readonly ctx: Context) {}

  async run(request: RepairChildRequest): Promise<RepairChildResult> {
    const services = runtimeServices(this.ctx, request.parent)
    const cwd = path.resolve(request.cwd)
    const parentDepth = request.parent.session.header.delegationDepth ?? 0
    if (parentDepth !== 0) {
      throw new EvolutionError('invalid_input', 'Full-access repair may only be launched from a top-level Agent session', {
        parentDepth,
      })
    }
    const sessionId = SessionId(`autoevo-repair-${randomUUID()}`)
    let permissionSource: RepairChildResult['permissionSource'] = 'compatibility_knobs'
    const handle = await services.agents.create({
      sessionId,
      meta: {
        cwd,
        parentSession: request.parent.id,
        origin: 'subagent',
        delegationDepth: 1,
        agentPreset: REPAIR_PRESET_ID,
      },
      agentOptions: { ...request.parent.options },
      ...(request.signal ? { signal: request.signal } : {}),
      setup: async (agentCtx) => {
        const child = agentCtx.agent
        if (!child || child.id !== sessionId || path.resolve(child.session.header.cwd ?? '') !== cwd) {
          throw new EvolutionError('invalid_input', 'DSH repair Agent setup did not bind the expected session and working directory')
        }
        permissionSource = applyFullAccess(services, child.session)
        const mounted = await services.agentPresets.mount(agentCtx, REPAIR_PRESET_ID)
        const composed = services.agentPresets.composedPreset(agentCtx)
        if (mounted.id !== REPAIR_PRESET_ID || composed !== REPAIR_PRESET_ID) {
          throw new EvolutionError('invalid_input', 'DSH repair Agent did not compose the standard coding preset', {
            mounted: mounted.id,
            composed,
          })
        }
        agentCtx.systemPrompt.section({
          name: 'autoevo:full-access-repair',
          order: 119,
          text: 'This is a user-confirmed, completion-first fault-repair session. Use the full standard coding toolset and danger-full-access authority to finish the repair; AutoEvo managed-source restrictions do not apply here.',
        })
      },
    })

    let disposePromise: Promise<void> | undefined
    const dispose = (): Promise<void> => {
      disposePromise ??= handle.dispose()
      return disposePromise
    }
    try {
      if (!services.agents.isOwnedBy(handle.agent.id, request.parent)) {
        throw new EvolutionError('invalid_input', 'Created repair Agent is not owned by the initiating parent Agent')
      }
      if (path.resolve(handle.agent.session.header.cwd ?? '') !== cwd) {
        throw new EvolutionError('invalid_input', 'Created repair Agent working directory changed after setup')
      }
      handle.agent.followup(createUserMessage({
        source: { kind: 'plugin', plugin: 'autoevo', form: 'relay' },
        content: [{ type: 'text', text: repairInstruction(request) }],
      }))
      await waitForIdleOrAbort(handle, request.signal, dispose)
      assertCompletedRepair(handle.agent)
      const taskResult = assistantText(handle.agent)
      if (!taskResult.endsWith(REPAIR_RESULT_MARKER)) {
        throw new EvolutionError('command_failed', 'Full-access repair Agent completed without the required result marker')
      }
      return {
        sessionId: String(handle.agent.id),
        taskResult,
        permissionPreset: FULL_ACCESS_PRESET_ID,
        permissionSource,
        agentPreset: REPAIR_PRESET_ID,
      }
    } finally {
      await dispose()
    }
  }
}

export class FaultRepairMode {
  private readonly tickets = new Map<string, RepairTicket>()

  constructor(
    private readonly creationGuard: CreationGuard,
    private readonly child: RepairChildHost,
  ) {}

  prepare(input: FaultRepairPrepareInput, exec: ToolRunContext): FaultRepairTicketView {
    const parent = exec.agent
    const sessionId = ownerSessionId(parent)
    const validAfterTurnId = this.creationGuard.currentTurnId(parent)
    if (!parent || !sessionId || !validAfterTurnId) {
      throw new EvolutionError('invalid_input', 'A live top-level Agent and Host-claimed user turn are required to request full-access repair')
    }
    if ((parent.session.header.delegationDepth ?? 0) !== 0) {
      throw new EvolutionError('invalid_input', 'Only a top-level Agent may request full-access repair')
    }
    const objective = boundedText(input.objective, MAX_REPAIR_OBJECTIVE, 'repair objective')
    const failureContext = input.failureContext
      ? boundedText(input.failureContext, MAX_FAILURE_CONTEXT, 'failure context')
      : undefined
    const id = `repair_${hashObject({
      sessionId,
      validAfterTurnId,
      objective,
      nonce: randomUUID(),
    }).slice(0, 24)}`
    const ticket: RepairTicket = {
      id,
      objective,
      ...(failureContext ? { failureContext } : {}),
      cwd: sessionCwd(parent),
      ownerSessionId: sessionId,
      bootId: this.creationGuard.bootId,
      validAfterTurnId,
      status: 'awaiting_confirmation',
      createdAt: new Date().toISOString(),
    }
    for (const [existingId, existing] of this.tickets) {
      if (existing.ownerSessionId === sessionId && existing.status === 'awaiting_confirmation') {
        this.tickets.delete(existingId)
      }
    }
    this.tickets.set(id, ticket)
    return {
      repairId: id,
      objective,
      status: 'awaiting_confirmation',
      permissionPreset: FULL_ACCESS_PRESET_ID,
      approvalPolicy: 'never',
      scope: 'local_machine',
      confirmationRequired: true,
      message: 'Present the full-access repair choice and stop. After the user explicitly confirms in a fresh top-level turn, call capability_repair_resume with only this repair_id.',
    }
  }

  async resume(input: FaultRepairResumeInput, exec: ToolRunContext): Promise<RepairChildResult & { status: 'completed' }> {
    const ticket = this.tickets.get(input.repairId)
    if (!ticket) throw new EvolutionError('not_found', 'Full-access repair request was not found or expired')
    if (ticket.status !== 'awaiting_confirmation') {
      throw new EvolutionError('invalid_input', 'Full-access repair request was already consumed', {
        status: ticket.status,
      })
    }
    const sessionId = ownerSessionId(exec.agent)
    if (!exec.agent || !sessionId || sessionId !== ticket.ownerSessionId) {
      throw new EvolutionError('invalid_input', 'Full-access repair request belongs to a different Agent session')
    }
    const turn = this.creationGuard.consumeDecisionTurn(exec.agent, ticket)
    ticket.status = 'running'
    ticket.consumedTurnId = turn.turnId
    try {
      const result = await this.child.run({
        parent: exec.agent,
        cwd: ticket.cwd,
        objective: ticket.objective,
        ...(ticket.failureContext ? { failureContext: ticket.failureContext } : {}),
        signal: exec.signal,
      })
      ticket.status = 'completed'
      ticket.result = result
      return { status: 'completed', ...result }
    } catch (error) {
      ticket.status = 'failed'
      ticket.failure = errorMessage(error).slice(0, 500)
      throw error
    }
  }
}

export const _testing = {
  FULL_ACCESS_PRESET_ID,
  REPAIR_PRESET_ID,
  REPAIR_RESULT_MARKER,
  applyFullAccess,
  repairInstruction,
}
