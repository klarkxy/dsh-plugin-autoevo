import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PreToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { ResolutionAuthorization } from './contracts.js'
import { OUTSIDE_EVOLUTION_MODE_DENIAL } from './evolution-contracts.js'

type Grant =
  | { state: 'available'; resolutionId: string }
  | { state: 'reserved'; resolutionId: string; callId: string }

interface AgentGateState {
  generation: number
  activeResolutionId?: string
  authorization?: ResolutionAuthorization
  grant?: Grant
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
    return 'AutoEvo denied new Cordis plugin creation: call capability_resolve for the current capability requirement first.'
  }
  const prefix = `AutoEvo denied new Cordis plugin creation for ${authorization.resolutionId}`
  if (authorization.state === 'reuse_required') return `${prefix}: reuse the available local or reviewed capability. ${authorization.reason}`
  if (authorization.state === 'modify_required') return `${prefix}: improve the reviewed partial candidate instead of building from scratch. ${authorization.reason}`
  if (authorization.state === 'review_required') return `${prefix}: finish or retry candidate discovery and review first. ${authorization.reason}`
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
    this.states.set(agent, { generation })
    return generation
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

  private inEvolutionMode(agent: Agent): boolean {
    return this.options.isEvolutionMode?.(agent) === true
  }

  preExecute(exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> {
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

export const _testing = { denialReason, outsideEvolutionModeReason }
