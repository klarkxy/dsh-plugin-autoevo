import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { hashObject, sha256 } from './state/hashes.js'

const WINDOW_MS = 5 * 60 * 1000
const THRESHOLD = 3
const MAX_FAILURE_EVENTS = 24
const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u

const HINT_INTRO = 'Host observed repeated runtime friction. This is read-only evidence, not permission or a diagnosis. Use capability_workflow only when it is relevant to the user\'s current capability need.'

export interface RuntimeObservationOptions {
  isEvolutionMode: (agent: Agent) => boolean
  now?: () => number
}

export interface RuntimeObservations {
  recordToolCall(exec: Readonly<ToolExecution>): void
  recordToolResult(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): void
  recordRequestError(agent: Agent): void
  hintFor(agent: Agent | undefined): string
}

interface FailureEvent {
  toolKey: string
  toolName: string
  at: number
}

interface RepeatSignal {
  toolKey: string
  toolName: string
  argsHash: string
  at: number[]
}

interface AgentObservationState {
  failures: FailureEvent[]
  requestErrors: number[]
  repeat?: RepeatSignal
}

function publicToolName(name: string): string {
  return TOOL_NAME_RE.test(name) ? name : 'tool'
}

function recent(stamps: number[], now: number): number[] {
  const oldest = now - WINDOW_MS
  return stamps.filter((stamp) => stamp >= oldest).slice(-THRESHOLD)
}

function stateFor(states: WeakMap<Agent, AgentObservationState>, agent: Agent): AgentObservationState {
  const existing = states.get(agent)
  if (existing) return existing
  const created: AgentObservationState = { failures: [], requestErrors: [] }
  states.set(agent, created)
  return created
}

function toolIdentity(name: string): { toolKey: string, toolName: string } {
  return { toolKey: sha256(name), toolName: publicToolName(name) }
}

export function createRuntimeObservations(options: RuntimeObservationOptions): RuntimeObservations {
  const states = new WeakMap<Agent, AgentObservationState>()
  const now = (): number => options.now?.() ?? Date.now()

  const recordToolCall = (exec: Readonly<ToolExecution>): void => {
    const agent = exec.agent
    if (!agent || !options.isEvolutionMode(agent)) return
    const state = stateFor(states, agent)
    const identity = toolIdentity(exec.name)
    const argsHash = hashObject(exec.arguments)
    const at = now()
    state.repeat = state.repeat?.toolKey === identity.toolKey
      && state.repeat.argsHash === argsHash
      ? { ...state.repeat, at: [...recent(state.repeat.at, at), at].slice(-THRESHOLD) }
      : { ...identity, argsHash, at: [at] }
  }

  const recordToolResult = (
    exec: Readonly<ToolExecution>,
    result: Readonly<ToolExecutionResult>,
  ): void => {
    const agent = exec.agent
    if (!result.isError || !agent || !options.isEvolutionMode(agent)) return
    const at = now()
    const oldest = at - WINDOW_MS
    const state = stateFor(states, agent)
    state.failures = [
      ...state.failures.filter((event) => event.at >= oldest),
      { ...toolIdentity(exec.name), at },
    ].slice(-MAX_FAILURE_EVENTS)
  }

  const recordRequestError = (agent: Agent): void => {
    if (!options.isEvolutionMode(agent)) return
    const state = stateFor(states, agent)
    const at = now()
    state.requestErrors = [...recent(state.requestErrors, at), at].slice(-THRESHOLD)
  }

  const hintFor = (agent: Agent | undefined): string => {
    if (!agent || !options.isEvolutionMode(agent)) return ''
    const state = states.get(agent)
    if (!state) return ''
    const at = now()
    const oldest = at - WINDOW_MS
    state.failures = state.failures.filter((event) => event.at >= oldest)
    state.requestErrors = recent(state.requestErrors, at)
    if (state.repeat) {
      state.repeat.at = recent(state.repeat.at, at)
      if (state.repeat.at.length === 0) delete state.repeat
    }

    const lines: string[] = []
    for (let index = state.failures.length - 1; index >= 0; index -= 1) {
      const failure = state.failures[index]!
      const count = state.failures.filter((event) => event.toolKey === failure.toolKey).length
      if (count < THRESHOLD) continue
      lines.push(`- tool-failure: ${failure.toolName} × ${THRESHOLD}`)
      break
    }
    if (state.repeat && state.repeat.at.length >= THRESHOLD) {
      lines.push(`- tool-repeat: ${state.repeat.toolName} × ${THRESHOLD}`)
    }
    if (state.requestErrors.length >= THRESHOLD) lines.push(`- request-error × ${THRESHOLD}`)
    return lines.length > 0 ? `${HINT_INTRO}\n\n${lines.join('\n')}` : ''
  }

  return { recordToolCall, recordToolResult, recordRequestError, hintFor }
}

export function installRuntimeObservations(
  ctx: Context,
  options: RuntimeObservationOptions,
): RuntimeObservations {
  const observations = createRuntimeObservations(options)
  ctx.systemPrompt.section({
    name: 'autoevo:runtime-observations',
    order: 119,
    text: (context: AssembleContext) => observations.hintFor(context.agent),
  })
  ctx.on('tools/pre-execute', (exec, next) => {
    observations.recordToolCall(exec)
    return next()
  })
  ctx.on('tools/result', (exec, result) => {
    observations.recordToolResult(exec, result)
  })
  ctx.on('agent/request-error', (payload, next) => {
    observations.recordRequestError(payload.agent)
    return next()
  })
  return observations
}
