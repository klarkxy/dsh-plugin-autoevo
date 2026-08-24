import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { Agent, AgentHandle, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { SessionId, type JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import { TOOL_NAMES } from './contracts.js'
import { EvolutionError } from './errors.js'
import { sessionCwd } from './host-identity.js'
import { isRecord } from './internal-utils.js'
import { hashObject } from './state/hashes.js'

export { isRecord } from './internal-utils.js'

export const DIGEST_RE = /^[a-f0-9]{64}$/u
export const REVIEW_ID_RE = /^review_[a-f0-9]{16,64}$/u
export const MAX_TIMEOUT_MS = 300_000
export const MAX_NOTE_ITEMS = 16
export const MAX_NOTE_CHARS = 2_000

const AUTOEVO_PARENT_TOOLS = new Set<string>(TOOL_NAMES)

export type SemanticSubagentRole = 'reviewer' | 'verifier'

function roleTitle(role: SemanticSubagentRole): string {
  return role === 'reviewer' ? 'Reviewer' : 'Verifier'
}

export function requirementHashFor(requirement: string): string {
  return hashObject({ requirement })
}

export function mintSemanticRequestId(prefix: string, payload: Record<string, unknown>): string {
  return `${prefix}${hashObject({ ...payload, nonce: randomUUID() }).slice(0, 24)}`
}

export function boundedNotes(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new EvolutionError('invalid_input', `${label} must be an array of strings`)
  }
  if (value.length > MAX_NOTE_ITEMS) {
    throw new EvolutionError('invalid_input', `${label} exceeds the Host bound`, { max: MAX_NOTE_ITEMS })
  }
  return value.map((item, index) => {
    if (typeof item !== 'string') {
      throw new EvolutionError('invalid_input', `${label}[${index}] must be a string`)
    }
    const text = item.normalize('NFKC').trim()
    if (text.length > MAX_NOTE_CHARS) {
      throw new EvolutionError('invalid_input', `${label}[${index}] exceeds the Host bound`, { max: MAX_NOTE_CHARS })
    }
    return text
  })
}

export function assertTimeoutWithinBound(timeoutMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new EvolutionError('invalid_input', 'timeoutMs must be a positive duration within the Host bound')
  }
}

export function requireSubmitObject(value: unknown, submitTool: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new EvolutionError('invalid_input', `${submitTool} requires a JSON object`)
  }
  return value
}

export function rejectForgedSubmit(
  args: Record<string, unknown>,
  forgedKeys: readonly string[],
  submitKeys: ReadonlySet<string>,
  submitTool: string,
): void {
  for (const key of forgedKeys) {
    if (args[key] !== undefined) {
      throw new EvolutionError('invalid_input', `${submitTool} does not accept Host-owned or authorization fields`, {
        key,
      })
    }
  }
  for (const key of Object.keys(args)) {
    if (!submitKeys.has(key)) {
      throw new EvolutionError('invalid_input', `${submitTool} does not accept Host-owned or authorization fields`, {
        key,
      })
    }
  }
}

export function semanticDenyReason(name: string, role: SemanticSubagentRole, submitTool: string): string | undefined {
  if (name === submitTool) return undefined
  if (AUTOEVO_PARENT_TOOLS.has(name)) {
    return `AutoEvo semantic ${role} denies AutoEvo decision tools; submit ${submitTool} only.`
  }
  return `AutoEvo semantic ${role} denies ${JSON.stringify(name)}; only ${submitTool} is allowed in this read-only session.`
}

export interface SemanticHostRequest {
  id: string
  status: 'pending' | 'running' | 'completed' | 'cancelled' | 'timed_out'
  startedAt?: string
  completedAt?: string
}

export interface SemanticSubmissionGateHooks<TParsed, TVerdict> {
  readonly role: SemanticSubagentRole
  readonly submitTool: string
  parseSubmitArgs(value: unknown): TParsed
  buildVerdict(requestId: string, parsed: TParsed, sessionId: string, createdAt: string): TVerdict
  buildFallbackVerdict(requestId: string, sessionId: string, createdAt: string, evidence: string): TVerdict
}

/** One-shot Host-owned subagent submission gate shared by reviewer and verifier. */
export class SemanticSubmissionGate<TRequest extends SemanticHostRequest, TParsed, TVerdict> {
  private closed: 'open' | 'submitted' | 'cancelled' | 'timed_out' = 'open'
  private handleDisposed = false
  private verdict: TVerdict | undefined
  request: TRequest

  constructor(
    private readonly hooks: SemanticSubmissionGateHooks<TParsed, TVerdict>,
    request: TRequest,
  ) {
    this.request = { ...request }
  }

  markRunning(startedAt = new Date().toISOString()): TRequest {
    if (this.closed !== 'open' || this.request.status !== 'pending') {
      throw new EvolutionError('invalid_input', `${roleTitle(this.hooks.role)} request cannot transition to running`)
    }
    this.request = { ...this.request, status: 'running', startedAt }
    return this.request
  }

  submit(rawArgs: unknown, sessionId: string): TVerdict {
    this.assertAcceptingSubmit()
    const parsed = this.hooks.parseSubmitArgs(rawArgs)
    const createdAt = new Date().toISOString()
    const verdict = this.hooks.buildVerdict(this.request.id, parsed, sessionId, createdAt)
    this.verdict = verdict
    this.closed = 'submitted'
    this.request = { ...this.request, status: 'completed', completedAt: createdAt }
    return verdict
  }

  closeCancelled(sessionId: string, createdAt = new Date().toISOString()): TVerdict {
    return this.closeWithoutSubmit('cancelled', sessionId, createdAt, `Host cancelled the semantic ${this.hooks.role}.`)
  }

  closeTimedOut(sessionId: string, createdAt = new Date().toISOString()): TVerdict {
    return this.closeWithoutSubmit('timed_out', sessionId, createdAt, `Host timed out the semantic ${this.hooks.role}.`)
  }

  closeMissingSubmit(sessionId: string, createdAt = new Date().toISOString()): TVerdict {
    return this.closeWithoutSubmit('completed', sessionId, createdAt, `${roleTitle(this.hooks.role)} session ended without a locked submission.`)
  }

  dispose(): void {
    this.handleDisposed = true
  }

  currentVerdict(): TVerdict | undefined {
    return this.verdict
  }

  isOpen(): boolean {
    return this.closed === 'open'
  }

  private assertAcceptingSubmit(): void {
    if (this.handleDisposed) {
      throw new EvolutionError('invalid_input', `${this.hooks.submitTool} was rejected because the ${this.hooks.role} handle was disposed`)
    }
    if (this.closed === 'submitted') {
      throw new EvolutionError('invalid_input', `${this.hooks.submitTool} already locked this ${this.hooks.role} request`)
    }
    if (this.closed === 'cancelled' || this.closed === 'timed_out') {
      throw new EvolutionError('invalid_input', `${this.hooks.submitTool} was rejected because the ${this.hooks.role} request is no longer accepting submissions`, {
        status: this.request.status,
      })
    }
    if (this.request.status !== 'running') {
      throw new EvolutionError('invalid_input', `${this.hooks.submitTool} requires a running Host ${this.hooks.role} request`)
    }
  }

  private closeWithoutSubmit(
    status: Extract<SemanticHostRequest['status'], 'cancelled' | 'timed_out' | 'completed'>,
    sessionId: string,
    createdAt: string,
    evidence: string,
  ): TVerdict {
    if (this.closed === 'submitted' && this.verdict) return this.verdict
    const verdict = this.hooks.buildFallbackVerdict(this.request.id, sessionId, createdAt, evidence)
    this.verdict = verdict
    this.closed = status === 'completed' ? 'submitted' : status
    this.request = { ...this.request, status, completedAt: createdAt }
    return verdict
  }
}

export interface SemanticSubagentSpec<TRequest extends SemanticHostRequest, TParsed, TVerdict> {
  readonly role: SemanticSubagentRole
  readonly rolePlural: 'reviewers' | 'verifiers'
  readonly sessionPrefix: string
  readonly parent: Agent
  readonly signal: AbortSignal | undefined
  readonly timeoutMs: number
  readonly gate: SemanticSubmissionGate<TRequest, TParsed, TVerdict>
  readonly submitTool: {
    readonly name: string
    readonly description: string
    readonly parameters: ParameterSchemaSpec
  }
  readonly denyReason: (name: string) => string | undefined
  readonly boundarySection: {
    readonly name: string
    readonly text: string
  }
  instruction(): string
}

function requireParentAgents(parent: Agent): AgentRegistry {
  const agents = parent.ctx.get('agents') as AgentRegistry | undefined
  if (!agents) {
    throw new EvolutionError('invalid_input', 'Initiating parent Agent context cannot access the Agent registry')
  }
  return agents
}

function jsonToolOutput(value: unknown): JsonValue {
  return value as JsonValue
}

/** Shared Host-owned DSH semantic subagent lifecycle for reviewer and verifier. */
export async function runSemanticSubagent<TRequest extends SemanticHostRequest, TParsed, TVerdict>(
  spec: SemanticSubagentSpec<TRequest, TParsed, TVerdict>,
): Promise<{ request: TRequest; verdict: TVerdict }> {
  const parentAgents = requireParentAgents(spec.parent)
  const parentDepth = spec.parent.session.header.delegationDepth ?? 0
  if (parentDepth !== 0) {
    throw new EvolutionError('invalid_input', `Semantic ${spec.rolePlural} may only be launched from a top-level parent session`, {
      parentDepth,
    })
  }
  const cwd = path.resolve(sessionCwd(spec.parent))
  const sessionId = SessionId(`${spec.sessionPrefix}${randomUUID()}`)
  const handle = await parentAgents.create({
    sessionId,
    meta: {
      cwd,
      parentSession: spec.parent.id,
      origin: 'subagent',
      delegationDepth: 1,
    },
    agentOptions: { ...spec.parent.options },
    ...(spec.signal ? { signal: spec.signal } : {}),
    setup: async (agentCtx) => {
      const child = agentCtx.agent
      if (!child || child.id !== sessionId) {
        throw new EvolutionError('invalid_input', `DSH ${spec.role} setup did not bind the expected session identity`)
      }
      const childCwd = path.resolve(child.session.header.cwd ?? '')
      if (childCwd !== cwd) {
        throw new EvolutionError('invalid_input', `DSH ${spec.role} cwd does not match the parent session cwd`)
      }
      setSandboxMode(child.session, 'read-only')
      agentCtx.tools.register(defineTool({
        name: spec.submitTool.name,
        description: spec.submitTool.description,
        parameters: spec.submitTool.parameters,
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
        },
        async execute(args) {
          return jsonToolOutput(spec.gate.submit(args, String(sessionId)))
        },
      }))
      agentCtx.on('tools/pre-execute', (exec, next) => {
        const reason = spec.denyReason(exec.name)
        if (reason) return Promise.resolve({ kind: 'deny', reason })
        return next()
      })
      agentCtx.tools.guard((exec) => spec.denyReason(exec.name))
      agentCtx.systemPrompt.section({
        name: spec.boundarySection.name,
        order: 119,
        text: spec.boundarySection.text,
      })
    },
  })

  let disposePromise: Promise<void> | undefined
  const dispose = (): Promise<void> => {
    spec.gate.dispose()
    disposePromise ??= handle.dispose()
    return disposePromise
  }

  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timed_out'>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true
      resolve('timed_out')
    }, spec.timeoutMs)
  })

  try {
    if (!parentAgents.isOwnedBy(handle.agent.id, spec.parent)) {
      throw new EvolutionError('invalid_input', `Created ${spec.role} is not owned by the initiating parent Agent`)
    }
    if ((handle.agent.session.header.delegationDepth ?? 0) !== 1) {
      throw new EvolutionError('invalid_input', `Created ${spec.role} must have delegationDepth 1`)
    }
    if (path.resolve(handle.agent.session.header.cwd ?? '') !== cwd) {
      throw new EvolutionError('invalid_input', `Created ${spec.role} cwd does not match the parent session cwd`)
    }
    spec.gate.markRunning()
    handle.agent.followup(createUserMessage({
      source: { kind: 'plugin', plugin: 'autoevo', form: 'relay' },
      content: [{
        type: 'text',
        text: spec.instruction(),
      }],
    }))
    const outcome = await waitForChildIdle(handle, spec.signal, timeout, dispose)
    if (timer) clearTimeout(timer)
    const session = String(handle.agent.id)
    if (outcome === 'aborted') {
      const verdict = spec.gate.isOpen() ? spec.gate.closeCancelled(session) : spec.gate.currentVerdict()!
      return { request: spec.gate.request, verdict }
    }
    if (outcome === 'timed_out' || timedOut) {
      const verdict = spec.gate.isOpen() ? spec.gate.closeTimedOut(session) : spec.gate.currentVerdict()!
      return { request: spec.gate.request, verdict }
    }
    const verdict = spec.gate.isOpen() ? spec.gate.closeMissingSubmit(session) : spec.gate.currentVerdict()!
    return { request: spec.gate.request, verdict }
  } finally {
    if (timer) clearTimeout(timer)
    await dispose()
  }
}

export async function waitForChildIdle(
  handle: AgentHandle,
  signal: AbortSignal | undefined,
  timeout: Promise<'timed_out'>,
  dispose: () => Promise<void>,
): Promise<'idle' | 'aborted' | 'timed_out'> {
  if (signal?.aborted) {
    await dispose()
    return 'aborted'
  }
  let onAbort: (() => void) | undefined
  const aborted = signal
    ? new Promise<'aborted'>((resolve) => {
      onAbort = () => resolve('aborted')
      signal.addEventListener('abort', onAbort, { once: true })
    })
    : undefined
  try {
    const racers: Array<Promise<'idle' | 'aborted' | 'timed_out'>> = [
      handle.agent.whenIdle().then(() => 'idle' as const),
      timeout,
    ]
    if (aborted) racers.push(aborted)
    const outcome = await Promise.race(racers)
    if (outcome === 'aborted') await dispose()
    return outcome
  } finally {
    if (onAbort && signal) signal.removeEventListener('abort', onAbort)
  }
}
