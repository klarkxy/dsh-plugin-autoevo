import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PreToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { ResolutionRecord, ResolutionAuthorization, ReviewRecord } from './contracts.js'
import { EvolutionError } from './errors.js'
import { OUTSIDE_EVOLUTION_MODE_DENIAL } from './evolution-contracts.js'
import { assertUseThisReceipt } from './lifecycle/decide.js'

type Grant =
  | { state: 'available'; resolutionId: string }
  | { state: 'reserved'; resolutionId: string; callId: string }

interface AgentGateState {
  generation: number
  activeResolutionId?: string
  authorization?: ResolutionAuthorization
  grant?: Grant
  lastUserMessage?: string
  waitingKind?: 'await_selection' | 'await_confirmation' | 'await_modify_work'
}

const FIND_PLUGIN_TOOL = 'find_dsh_plugin'
const WEB_SEARCH_TOOL = 'web_search'
const SHELL_TOOLS = new Set(['pwsh', 'bash'])
const DSH_PLUGIN_ADD = /(?:^|[\s;&|])dsh(?:\.cmd)?\s+plugin\b[\s\S]*\badd\b/iu
const SKIP_USER_TEXT = /^(?:Current runtime context\.|<system-reminder>)/u

export interface UserFacingMessage {
  content?: readonly unknown[]
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
  if (authorization.state === 'modify_review') return `${prefix}: improve the reviewed plugin the user chose instead of building from scratch. ${authorization.reason}`
  if (authorization.state === 'use_review') return `${prefix}: the user chose to use a reviewed plugin, not create a new one. ${authorization.reason}`
    if (authorization.state === 'selection_required') return `${prefix}: present the shortlist in chat, wait for the user, then call capability_workflow_resume. ${authorization.reason}`
  if (authorization.state === 'confirmation_required') return `${prefix}: explain the review in chat, wait for the user, then call capability_workflow_resume. ${authorization.reason}`
  if (authorization.state === 'stopped') return `${prefix}: the user stopped. ${authorization.reason}`
  if (authorization.state === 'market_required') {
    return `${prefix}: wait for the DSH plugin marketplace script install and a DSH restart, then call capability_workflow again. Do not create a plugin. ${authorization.reason}`
  }
  return `${prefix}: the scratch-build authorization has already been reserved or consumed.`
}

function outsideEvolutionModeReason(): string {
  return OUTSIDE_EVOLUTION_MODE_DENIAL
}

export interface CreationGuardOptions {
  /** True only when agentPresets.serviceFor(agent, 'autoevoEvolutionMode') yields exact marker. */
  isEvolutionMode?: (agent: Agent) => boolean
}

/** Runtime-only, fail-closed authorization for one new dynamic Cordis Plugin. */
export class CreationGuard {
  private readonly states = new WeakMap<Agent, AgentGateState>()
  private nextGeneration = 0

  constructor(private readonly options: CreationGuardOptions = {}) {}

  beginResolution(agent?: Agent): number | undefined {
    if (!agent) return undefined
    const generation = ++this.nextGeneration
    const prior = this.states.get(agent)
    this.states.set(agent, {
      generation,
      ...(prior?.lastUserMessage ? { lastUserMessage: prior.lastUserMessage } : {}),
    })
    return generation
  }

  rememberUserMessage(agent: Agent | undefined, message: UserFacingMessage): void {
    if (!agent) return
    const text = extractUserFacingText(message)
    if (!text) return
    const state = this.states.get(agent)
    if (state) {
      state.lastUserMessage = text
      return
    }
    this.states.set(agent, { generation: 0, lastUserMessage: text })
  }

  lastUserMessage(agent: Agent | undefined): string | undefined {
    if (!agent) return undefined
    return this.states.get(agent)?.lastUserMessage
  }

  setWaiting(agent: Agent | undefined, kind?: AgentGateState['waitingKind']): void {
    if (!agent) return
    const state = this.states.get(agent)
    if (!state) {
      if (!kind) return
      this.states.set(agent, { generation: 0, waitingKind: kind })
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
    this.setAuthorization(state, authorization)
    return true
  }

  applyReviewAuthorization(agent: Agent | undefined, authorization: ResolutionAuthorization): boolean {
    if (!agent) return false
    const state = this.states.get(agent)
    if (!state || state.activeResolutionId !== authorization.resolutionId) return false
    this.setAuthorization(state, authorization)
    return true
  }

  private setAuthorization(state: AgentGateState, authorization: ResolutionAuthorization): void {
    state.authorization = authorization
    if (authorization.state === 'scratch_ready') {
      state.grant = { state: 'available', resolutionId: authorization.resolutionId }
    } else {
      delete state.grant
    }
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
      return 'Discovery is finished. Call capability_workflow_resume with the user\'s latest message.'
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
    const grant = state?.grant
    if (!grant || grant.state !== 'available') {
      return Promise.resolve({ kind: 'deny', reason: denialReason(state?.authorization) })
    }
    state.grant = { state: 'reserved', resolutionId: grant.resolutionId, callId: String(exec.callId) }
    return next()
  }

  /** Final monotonic check: no earlier waterfall listener can override this denial. */
  guard(exec: Readonly<ToolExecution>): string | undefined {
    const protocol = this.protocolDenial(exec)
    if (protocol) return protocol
    if (!exec.agent || !isNewCordisDefinition(exec)) return undefined
    if (!this.inEvolutionMode(exec.agent)) return outsideEvolutionModeReason()
    const state = this.states.get(exec.agent)
    const grant = state?.grant
    if (grant?.state === 'reserved' && grant.callId === String(exec.callId)) return undefined
    return denialReason(state?.authorization)
  }

  result(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): void {
    if (!exec.agent || !isNewCordisDefinition(exec)) return
    const state = this.states.get(exec.agent)
    const grant = state?.grant
    if (!state || !grant || grant.state !== 'reserved' || grant.callId !== String(exec.callId)) return
    if (result.isError) {
      state.grant = { state: 'available', resolutionId: grant.resolutionId }
    } else {
      delete state.grant
    }
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
