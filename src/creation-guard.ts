import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PreToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { ResolutionRecord, ResolutionAuthorization, ReviewRecord } from './contracts.js'
import { EvolutionError } from './errors.js'
import { OUTSIDE_EVOLUTION_MODE_DENIAL } from './evolution-contracts.js'
import { newBootId, newTurnId, ownerSessionId } from './host-identity.js'
import { assertUseThisReceipt } from './lifecycle/decide.js'
import type { InterruptPayload } from './workflow/contracts.js'

interface AgentGateState {
  generation: number
  activeResolutionId?: string
  authorization?: ResolutionAuthorization
  lastUserMessage?: string
  currentTurnId?: string
  turnSequence: number
  consumedTurnIds: Set<string>
  waitingKind?: 'await_selection' | 'await_confirmation' | 'await_modify_work'
  sessionId?: string
}

const FIND_PLUGIN_TOOL = 'find_dsh_plugin'
const WEB_SEARCH_TOOL = 'web_search'
const SHELL_TOOLS = new Set(['pwsh', 'bash'])
const DSH_PLUGIN_ADD = /(?:^|[\s;&|])dsh(?:\.cmd)?\s+plugin\b[\s\S]*\badd\b/iu
const SKIP_USER_TEXT = /^(?:Current runtime context\.|<system-reminder>)/u

export interface UserFacingMessage {
  content?: readonly unknown[]
}

export interface ClaimedHostTurn {
  turnId: string
  message: string
  sequence: number
}

export function extractUserFacingText(message: UserFacingMessage): string {
  const parts: string[] = []
  for (const block of message.content ?? []) {
    if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') continue
    const text = block.text.normalize('NFKC').trim()
    if (!text || SKIP_USER_TEXT.test(text)) continue
    parts.push(text)
  }
  return parts.join('\n').trim()
}

export function isDshPluginAddCommand(value: string): boolean {
  return DSH_PLUGIN_ADD.test(value)
}

function shellCommandText(args: unknown): string {
  if (!isRecord(args)) return ''
  for (const key of ['command', 'cmd', 'script']) {
    const value = args[key]
    if (typeof value === 'string') return value
  }
  return ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function isNewCordisDefinition(exec: Pick<ToolExecution, 'name' | 'arguments'>): boolean {
  if (exec.name !== 'cordis_define' || !isRecord(exec.arguments)) return false
  const plugin = exec.arguments.plugin
  return isRecord(plugin) && plugin.kind === 'new'
}

function denialReason(authorization?: ResolutionAuthorization): string {
  if (!authorization) {
    return 'AutoEvo denied new Cordis plugin creation: call capability_workflow for the current capability requirement first.'
  }
  const prefix = `AutoEvo denied new Cordis plugin creation for ${authorization.resolutionId}`
  if (authorization.state === 'reuse_local') return `${prefix}: reuse the existing local capability the user chose. ${authorization.reason}`
  if (authorization.state === 'modify_review') return `${prefix}: improve the reviewed plugin in the managed source child session instead of cordis_define. ${authorization.reason}`
  if (authorization.state === 'use_review') return `${prefix}: the user chose to use a reviewed plugin, not create a new one. ${authorization.reason}`
  if (authorization.state === 'selection_required') return `${prefix}: present the shortlist in chat, wait for the user, then call capability_workflow_resume. ${authorization.reason}`
  if (authorization.state === 'confirmation_required') return `${prefix}: explain the review in chat, wait for the user, then call capability_workflow_resume. ${authorization.reason}`
  if (authorization.state === 'stopped') return `${prefix}: the user stopped. ${authorization.reason}`
  if (authorization.state === 'market_required') {
    return `${prefix}: wait for the DSH plugin marketplace script install and a DSH restart, then call capability_workflow again. Do not create a plugin. ${authorization.reason}`
  }
  if (authorization.state === 'create_authorized') {
    return `${prefix}: create-new continues only inside a managed git source and workspace-write child session; cordis_define(kind:new) is not permitted.`
  }
  return `${prefix}: dynamic Cordis creation is not permitted on the parent AutoEvo session.`
}

function outsideEvolutionModeReason(): string {
  return OUTSIDE_EVOLUTION_MODE_DENIAL
}

export interface CreationGuardOptions {
  /** True only when agentPresets.serviceFor(agent, 'autoevoEvolutionMode') yields exact marker. */
  isEvolutionMode?: (agent: Agent) => boolean
  /** Service boot identity; interrupts bound to a prior boot are invalidated. */
  bootId?: string
}

/** Runtime-only, fail-closed authorization for AutoEvo parent-session decisions. */
export class CreationGuard {
  private readonly states = new WeakMap<Agent, AgentGateState>()
  private nextGeneration = 0
  readonly bootId: string

  constructor(private readonly options: CreationGuardOptions = {}) {
    this.bootId = options.bootId ?? newBootId()
  }

  beginResolution(agent?: Agent): number | undefined {
    if (!agent) return undefined
    const generation = ++this.nextGeneration
    const prior = this.states.get(agent)
    this.states.set(agent, {
      generation,
      turnSequence: prior?.turnSequence ?? 0,
      consumedTurnIds: prior?.consumedTurnIds ?? new Set<string>(),
      ...(prior?.lastUserMessage ? { lastUserMessage: prior.lastUserMessage } : {}),
      ...(prior?.currentTurnId ? { currentTurnId: prior.currentTurnId } : {}),
      ...(prior?.sessionId ? { sessionId: prior.sessionId } : {}),
    })
    return generation
  }

  rememberUserMessage(agent: Agent | undefined, message: UserFacingMessage): void {
    if (!agent) return
    const text = extractUserFacingText(message)
    if (!text) return
    const sessionId = ownerSessionId(agent) ?? 'anonymous'
    const state = this.states.get(agent) ?? {
      generation: 0,
      turnSequence: 0,
      consumedTurnIds: new Set<string>(),
      sessionId,
    }
    state.turnSequence += 1
    state.currentTurnId = newTurnId(sessionId, state.turnSequence)
    state.lastUserMessage = text
    state.sessionId = sessionId
    this.states.set(agent, state)
  }

  lastUserMessage(agent: Agent | undefined): string | undefined {
    if (!agent) return undefined
    return this.states.get(agent)?.lastUserMessage
  }

  currentTurnId(agent: Agent | undefined): string | undefined {
    if (!agent) return undefined
    return this.states.get(agent)?.currentTurnId
  }

  /**
   * Consume the latest host-owned user turn for an interrupt.
   * Rejects missing turns, already-consumed (replay) turns, and turns at/before the interrupt watermark.
   */
  consumeDecisionTurn(agent: Agent | undefined, interrupt: InterruptPayload): ClaimedHostTurn {
    if (!agent) {
      throw new EvolutionError('invalid_input', 'A live Agent session is required to resume a workflow decision')
    }
    const sessionId = ownerSessionId(agent)
    if (!sessionId || sessionId !== interrupt.ownerSessionId) {
      throw new EvolutionError('invalid_input', 'Workflow interrupt belongs to a different owner session', {
        expected: interrupt.ownerSessionId,
        actual: sessionId,
      })
    }
    if (interrupt.bootId !== this.bootId) {
      throw new EvolutionError('invalid_input', 'Workflow interrupt was invalidated by a service restart; present the reissued interrupt and obtain a fresh user confirmation', {
        expectedBootId: this.bootId,
        interruptBootId: interrupt.bootId,
      })
    }
    const state = this.states.get(agent)
    const turnId = state?.currentTurnId
    const message = state?.lastUserMessage
    if (!state || !turnId || !message) {
      throw new EvolutionError('invalid_input', 'No host-claimed user turn is available for this decision')
    }
    if (state.consumedTurnIds.has(turnId)) {
      throw new EvolutionError('invalid_input', 'This host user turn was already consumed by a prior resume (replay rejected)', {
        turnId,
      })
    }
    if (turnId === interrupt.validAfterTurnId) {
      throw new EvolutionError('invalid_input', 'Decision requires a fresh user turn after the interrupt was issued (stale/previous-turn rejected)', {
        turnId,
        validAfterTurnId: interrupt.validAfterTurnId,
      })
    }
    // Sequence watermark: turn ids are opaque; also compare via remembered order by requiring inequality with watermark
    // and that a new claim happened after interrupt issuance (caller reissues interrupt with current turn as watermark).
    state.consumedTurnIds.add(turnId)
    return { turnId, message, sequence: state.turnSequence }
  }

  setWaiting(agent: Agent | undefined, kind?: AgentGateState['waitingKind']): void {
    if (!agent) return
    const state = this.states.get(agent)
    if (!state) {
      if (!kind) return
      this.states.set(agent, {
        generation: 0,
        turnSequence: 0,
        consumedTurnIds: new Set(),
        waitingKind: kind,
        ...(ownerSessionId(agent) ? { sessionId: ownerSessionId(agent) } : {}),
      })
      return
    }
    if (kind) state.waitingKind = kind
    else delete state.waitingKind
  }

  applyResolutionAuthorization(
    agent: Agent | undefined,
    authorization: ResolutionAuthorization,
    generation: number | undefined,
  ): boolean {
    if (!agent || generation === undefined) return false
    const state = this.states.get(agent)
    if (!state || state.generation !== generation) return false
    state.activeResolutionId = authorization.resolutionId
    state.authorization = authorization
    return true
  }

  applyReviewAuthorization(agent: Agent | undefined, authorization: ResolutionAuthorization): boolean {
    if (!agent) return false
    const state = this.states.get(agent)
    if (!state || state.activeResolutionId !== authorization.resolutionId) return false
    state.authorization = authorization
    return true
  }

  assertInstallAuthorized(
    agent: Agent | undefined,
    review: ReviewRecord,
    resolution: Pick<ResolutionRecord, 'id' | 'decisions'>,
  ): void {
    if (!agent) {
      throw new EvolutionError('review_rejected', 'A live Agent is required to install a reviewed plugin')
    }
    assertUseThisReceipt(review, resolution)
  }

  private inEvolutionMode(agent: Agent): boolean {
    return this.options.isEvolutionMode?.(agent) === true
  }

  protocolDenial(exec: Readonly<ToolExecution>): string | undefined {
    if (!exec.agent || !this.inEvolutionMode(exec.agent)) return undefined
    const state = this.states.get(exec.agent)
    const waiting = state?.waitingKind === 'await_selection'
      || state?.waitingKind === 'await_confirmation'
      || (!state?.waitingKind && (
        state?.authorization?.state === 'selection_required'
        || state?.authorization?.state === 'confirmation_required'
      ))
    if (exec.name === FIND_PLUGIN_TOOL && exec.parent === undefined) {
      return 'Use the shortlist from capability_workflow. Call capability_workflow_resume; do not search again.'
    }
    if (exec.name === WEB_SEARCH_TOOL && waiting) {
      return 'Discovery is finished. Call capability_workflow_resume with workflow_id and interrupt_id.'
    }
    if (SHELL_TOOLS.has(exec.name) && state?.authorization && isDshPluginAddCommand(shellCommandText(exec.arguments))) {
      return 'Install only via the capability workflow after review.'
    }
    return undefined
  }

  preExecute(exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> {
    const protocol = this.protocolDenial(exec)
    if (protocol) return Promise.resolve({ kind: 'deny', reason: protocol })
    if (!exec.agent || !isNewCordisDefinition(exec)) return next()
    if (!this.inEvolutionMode(exec.agent)) {
      return Promise.resolve({ kind: 'deny', reason: outsideEvolutionModeReason() })
    }
    const state = this.states.get(exec.agent)
    return Promise.resolve({ kind: 'deny', reason: denialReason(state?.authorization) })
  }

  /** Final monotonic check: no earlier waterfall listener can override this denial. */
  guard(exec: Readonly<ToolExecution>): string | undefined {
    const protocol = this.protocolDenial(exec)
    if (protocol) return protocol
    if (!exec.agent || !isNewCordisDefinition(exec)) return undefined
    if (!this.inEvolutionMode(exec.agent)) return outsideEvolutionModeReason()
    const state = this.states.get(exec.agent)
    return denialReason(state?.authorization)
  }

  result(_exec: Readonly<ToolExecution>, _result: Readonly<ToolExecutionResult>): void {
    // Parent session never grants cordis_define(kind:new); nothing to consume.
  }

  authorization(agent: Agent): ResolutionAuthorization | undefined {
    return this.states.get(agent)?.authorization
  }
}

export const _testing = {
  denialReason,
  extractUserFacingText,
  isDshPluginAddCommand,
  outsideEvolutionModeReason,
}
