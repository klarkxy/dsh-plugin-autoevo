import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { Agent, AgentHandle, AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { SessionId, type JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {
  VerificationEvidence,
  VerificationVerdict,
  VerificationVerdictDecision,
  VerifierRequest,
  VerifierRequestStatus,
} from './contracts.js'
import { TOOL_NAMES } from './contracts.js'
import { EvolutionError } from './errors.js'
import { sessionCwd } from './host-identity.js'
import { requirementHashFor } from './semantic-reviewer.js'
import { hashObject } from './state/hashes.js'

export const VERIFIER_SUBMIT_TOOL = 'autoevo_submit_verification'
export const VERIFIER_VERSION = '1'
export const VERIFIER_SESSION_PREFIX = 'autoevo-verifier-'

const DIGEST_RE = /^[a-f0-9]{64}$/u
const INSTALL_ID_RE = /^installation_[a-f0-9]{16,64}$/u
const REVIEW_ID_RE = /^review_[a-f0-9]{16,64}$/u
const MAX_TIMEOUT_MS = 300_000
const MAX_NOTE_ITEMS = 16
const MAX_NOTE_CHARS = 2_000
const AUTOEVO_PARENT_TOOLS = new Set<string>(TOOL_NAMES)

export const FORGED_VERIFIER_SUBMIT_KEYS = [
  'authorization',
  'installSpec',
  'install_spec',
  'endpoint',
  'lease',
  'executionLease',
  'execution_lease',
  'commitment',
  'actionCommitment',
  'selectionReceipt',
  'selection_receipt',
  'requestId',
  'request_id',
  'installationId',
  'installation_id',
  'reviewId',
  'review_id',
  'requirementHash',
  'requirement_hash',
  'evidenceDigest',
  'evidence_digest',
  'verifierSessionId',
  'verifier_session_id',
  'verifierVersion',
  'verifier_version',
  'createdAt',
  'created_at',
] as const

const SUBMIT_KEYS = new Set(['verdict', 'evidence', 'conditions'])

/** Bounded Host receipt for the verifier. Never includes secrets or source paths. */
export interface RedactedVerificationReceipt {
  expectedTools: string[]
  calledTools: string[]
  resultTools: string[]
  failedTools: string[]
  taskResultObserved: boolean
  taskResultSha256?: string
  observedProvider?: string
  observedModel?: string
  routeMatchedExpectation?: boolean
  exitCode?: number | null
  launchEvidence?: VerificationEvidence['launchEvidence']
}

export interface VerifierRunInput {
  parent: Agent
  installationId: string
  reviewId: string
  requirement: string
  evidenceDigest: string
  receipt: RedactedVerificationReceipt
  signal?: AbortSignal
  timeoutMs: number
}

export interface SemanticVerifierResult {
  request: VerifierRequest
  verdict: VerificationVerdict
}

export interface SemanticVerifierHost {
  run(input: VerifierRunInput): Promise<SemanticVerifierResult>
}

export interface VerifierHostBinding {
  installationId: string
  reviewId: string
  requirementHash: string
  evidenceDigest: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && Array.isArray(value) === false
}

function boundedNotes(value: unknown, label: string): string[] {
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

export function verificationEvidenceDigest(evidence: Pick<
  VerificationEvidence,
  | 'expectedTools'
  | 'calledTools'
  | 'resultTools'
  | 'failedTools'
  | 'taskResultObserved'
  | 'taskResultSha256'
  | 'observedProvider'
  | 'observedModel'
  | 'routeMatchedExpectation'
  | 'exitCode'
  | 'launchEvidence'
>): string {
  return hashObject({
    expectedTools: evidence.expectedTools,
    calledTools: evidence.calledTools,
    resultTools: evidence.resultTools,
    failedTools: evidence.failedTools,
    taskResultObserved: evidence.taskResultObserved,
    taskResultSha256: evidence.taskResultSha256,
    observedProvider: evidence.observedProvider,
    observedModel: evidence.observedModel,
    routeMatchedExpectation: evidence.routeMatchedExpectation,
    exitCode: evidence.exitCode,
    launchEvidence: evidence.launchEvidence,
  })
}

export function redactVerificationReceipt(evidence: VerificationEvidence): RedactedVerificationReceipt {
  return {
    expectedTools: [...evidence.expectedTools],
    calledTools: [...evidence.calledTools],
    resultTools: [...evidence.resultTools],
    failedTools: [...evidence.failedTools],
    taskResultObserved: evidence.taskResultObserved,
    ...(evidence.taskResultSha256 ? { taskResultSha256: evidence.taskResultSha256 } : {}),
    ...(evidence.observedProvider ? { observedProvider: evidence.observedProvider } : {}),
    ...(evidence.observedModel ? { observedModel: evidence.observedModel } : {}),
    ...(evidence.routeMatchedExpectation !== undefined
      ? { routeMatchedExpectation: evidence.routeMatchedExpectation }
      : {}),
    ...(evidence.exitCode !== undefined ? { exitCode: evidence.exitCode } : {}),
    ...(evidence.launchEvidence ? { launchEvidence: { ...evidence.launchEvidence } } : {}),
  }
}

export function mintVerifierRequest(input: {
  installationId: string
  reviewId: string
  requirement: string
  evidenceDigest: string
  createdAt?: string
}): VerifierRequest {
  const createdAt = input.createdAt ?? new Date().toISOString()
  return {
    id: `verifier_${hashObject({
      installationId: input.installationId,
      reviewId: input.reviewId,
      evidenceDigest: input.evidenceDigest,
      createdAt,
      nonce: randomUUID(),
    }).slice(0, 24)}`,
    installationId: input.installationId,
    reviewId: input.reviewId,
    requirement: input.requirement,
    evidenceDigest: input.evidenceDigest,
    status: 'pending',
    createdAt,
  }
}

export function validateVerifierRunInput(input: VerifierRunInput): void {
  if (!INSTALL_ID_RE.test(input.installationId)) {
    throw new EvolutionError('invalid_input', 'installationId is not a valid installation record id')
  }
  if (!REVIEW_ID_RE.test(input.reviewId)) {
    throw new EvolutionError('invalid_input', 'reviewId is not a valid review record id')
  }
  if (!DIGEST_RE.test(input.evidenceDigest)) {
    throw new EvolutionError('invalid_input', 'evidenceDigest must be a 64-character hex digest')
  }
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0 || input.timeoutMs > MAX_TIMEOUT_MS) {
    throw new EvolutionError('invalid_input', 'timeoutMs must be a positive duration within the Host bound')
  }
  if (!input.requirement.trim()) {
    throw new EvolutionError('invalid_input', 'Verifier input requires the original requirement')
  }
}

export function rejectForgedVerifierSubmit(args: Record<string, unknown>): void {
  for (const key of FORGED_VERIFIER_SUBMIT_KEYS) {
    if (args[key] !== undefined) {
      throw new EvolutionError('invalid_input', 'autoevo_submit_verification does not accept Host-owned or authorization fields', {
        key,
      })
    }
  }
  for (const key of Object.keys(args)) {
    if (!SUBMIT_KEYS.has(key)) {
      throw new EvolutionError('invalid_input', 'autoevo_submit_verification does not accept Host-owned or authorization fields', {
        key,
      })
    }
  }
}

export function parseVerifierSubmitArgs(value: unknown): {
  verdict: VerificationVerdictDecision
  evidence: string[]
  conditions: string[]
} {
  if (!isRecord(value)) {
    throw new EvolutionError('invalid_input', 'autoevo_submit_verification requires a JSON object')
  }
  rejectForgedVerifierSubmit(value)
  const verdict = value.verdict
  if (verdict !== 'verified' && verdict !== 'rejected' && verdict !== 'uncertain') {
    throw new EvolutionError('invalid_input', 'verdict must be verified, rejected, or uncertain')
  }
  return {
    verdict,
    evidence: boundedNotes(value.evidence, 'evidence'),
    conditions: boundedNotes(value.conditions, 'conditions'),
  }
}

export function verifierDenyReason(name: string): string | undefined {
  if (name === VERIFIER_SUBMIT_TOOL) return undefined
  if (AUTOEVO_PARENT_TOOLS.has(name)) {
    return 'AutoEvo semantic verifier denies AutoEvo decision tools; submit autoevo_submit_verification only.'
  }
  return `AutoEvo semantic verifier denies ${JSON.stringify(name)}; only ${VERIFIER_SUBMIT_TOOL} is allowed in this read-only session.`
}

export function verifierInstruction(input: {
  requirement: string
  receipt: RedactedVerificationReceipt
}): string {
  return `You are a Host-owned AutoEvo semantic verifier in a new read-only session.
You do not inherit parent messages. Nested agents are forbidden.
You may call only ${VERIFIER_SUBMIT_TOOL} exactly once.
Do not authorize installation, mint leases or endpoints, or change Host mechanical facts.

===== BEGIN HOST REQUIREMENT =====
${input.requirement}
===== END HOST REQUIREMENT =====

===== BEGIN REDACTED HOST VERIFICATION RECEIPT =====
${JSON.stringify(input.receipt, null, 2)}
===== END REDACTED HOST VERIFICATION RECEIPT =====

The receipt is Host mechanical evidence. It is not authorization. Call ${VERIFIER_SUBMIT_TOOL} with verdict, evidence, and conditions. The Host fills identity, digest, session, and timestamps.
`
}

export function verificationVerdictAllowsCompletion(
  verdict: VerificationVerdict | undefined,
  expected: {
    installationId: string
    reviewId: string
    requirement: string
    evidenceDigest: string
  },
): boolean {
  if (!verdict) return false
  if (verdict.decision !== 'verified') return false
  if (verdict.installationId !== expected.installationId || verdict.reviewId !== expected.reviewId) return false
  if (verdict.requirementHash !== requirementHashFor(expected.requirement)) return false
  if (verdict.evidenceDigest !== expected.evidenceDigest) return false
  if (verdict.verifierVersion !== VERIFIER_VERSION) return false
  if (!verdict.verifierSessionId.trim()) return false
  return true
}

export class VerifierSubmissionGate {
  private closed: 'open' | 'submitted' | 'cancelled' | 'timed_out' = 'open'
  private handleDisposed = false
  private verdict: VerificationVerdict | undefined
  request: VerifierRequest

  constructor(
    private readonly binding: VerifierHostBinding,
    request: VerifierRequest,
  ) {
    this.request = { ...request }
  }

  markRunning(startedAt = new Date().toISOString()): VerifierRequest {
    if (this.closed !== 'open' || this.request.status !== 'pending') {
      throw new EvolutionError('invalid_input', 'Verifier request cannot transition to running')
    }
    this.request = { ...this.request, status: 'running', startedAt }
    return this.request
  }

  submit(rawArgs: unknown, verifierSessionId: string): VerificationVerdict {
    this.assertAcceptingSubmit()
    const parsed = parseVerifierSubmitArgs(rawArgs)
    const createdAt = new Date().toISOString()
    const verdict: VerificationVerdict = {
      requestId: this.request.id,
      installationId: this.binding.installationId,
      reviewId: this.binding.reviewId,
      requirementHash: this.binding.requirementHash,
      evidenceDigest: this.binding.evidenceDigest,
      verifierSessionId,
      verifierVersion: VERIFIER_VERSION,
      decision: parsed.verdict,
      evidence: parsed.evidence,
      conditions: parsed.conditions,
      createdAt,
    }
    this.verdict = verdict
    this.closed = 'submitted'
    this.request = { ...this.request, status: 'completed', completedAt: createdAt }
    return verdict
  }

  closeCancelled(verifierSessionId: string, createdAt = new Date().toISOString()): VerificationVerdict {
    return this.closeWithoutSubmit('cancelled', verifierSessionId, createdAt, 'Host cancelled the semantic verifier.')
  }

  closeTimedOut(verifierSessionId: string, createdAt = new Date().toISOString()): VerificationVerdict {
    return this.closeWithoutSubmit('timed_out', verifierSessionId, createdAt, 'Host timed out the semantic verifier.')
  }

  closeMissingSubmit(verifierSessionId: string, createdAt = new Date().toISOString()): VerificationVerdict {
    return this.closeWithoutSubmit('completed', verifierSessionId, createdAt, 'Verifier session ended without a locked submission.')
  }

  dispose(): void {
    this.handleDisposed = true
  }

  currentVerdict(): VerificationVerdict | undefined {
    return this.verdict
  }

  isOpen(): boolean {
    return this.closed === 'open'
  }

  private assertAcceptingSubmit(): void {
    if (this.handleDisposed) {
      throw new EvolutionError('invalid_input', 'autoevo_submit_verification was rejected because the verifier handle was disposed')
    }
    if (this.closed === 'submitted') {
      throw new EvolutionError('invalid_input', 'autoevo_submit_verification already locked this verifier request')
    }
    if (this.closed === 'cancelled' || this.closed === 'timed_out') {
      throw new EvolutionError('invalid_input', 'autoevo_submit_verification was rejected because the verifier request is no longer accepting submissions', {
        status: this.request.status,
      })
    }
    if (this.request.status !== 'running') {
      throw new EvolutionError('invalid_input', 'autoevo_submit_verification requires a running Host verifier request')
    }
  }

  private closeWithoutSubmit(
    status: Extract<VerifierRequestStatus, 'cancelled' | 'timed_out' | 'completed'>,
    verifierSessionId: string,
    createdAt: string,
    evidence: string,
  ): VerificationVerdict {
    if (this.closed === 'submitted' && this.verdict) return this.verdict
    const verdict: VerificationVerdict = {
      requestId: this.request.id,
      installationId: this.binding.installationId,
      reviewId: this.binding.reviewId,
      requirementHash: this.binding.requirementHash,
      evidenceDigest: this.binding.evidenceDigest,
      verifierSessionId,
      verifierVersion: VERIFIER_VERSION,
      decision: 'uncertain',
      evidence: [evidence],
      conditions: [],
      createdAt,
    }
    this.verdict = verdict
    this.closed = status === 'completed' ? 'submitted' : status
    this.request = { ...this.request, status, completedAt: createdAt }
    return verdict
  }
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

export class DshSemanticVerifierHost implements SemanticVerifierHost {
  constructor(private readonly ctx: Context) {}

  async run(input: VerifierRunInput): Promise<SemanticVerifierResult> {
    validateVerifierRunInput(input)
    const parentAgents = requireParentAgents(input.parent)
    const parentDepth = input.parent.session.header.delegationDepth ?? 0
    if (parentDepth !== 0) {
      throw new EvolutionError('invalid_input', 'Semantic verifiers may only be launched from a top-level parent session', {
        parentDepth,
      })
    }
    const cwd = path.resolve(sessionCwd(input.parent))
    const binding: VerifierHostBinding = {
      installationId: input.installationId,
      reviewId: input.reviewId,
      requirementHash: requirementHashFor(input.requirement),
      evidenceDigest: input.evidenceDigest,
    }
    const gate = new VerifierSubmissionGate(binding, mintVerifierRequest({
      installationId: input.installationId,
      reviewId: input.reviewId,
      requirement: input.requirement,
      evidenceDigest: input.evidenceDigest,
    }))
    const sessionId = SessionId(`${VERIFIER_SESSION_PREFIX}${randomUUID()}`)
    const handle = await parentAgents.create({
      sessionId,
      meta: {
        cwd,
        parentSession: input.parent.id,
        origin: 'subagent',
        delegationDepth: 1,
      },
      agentOptions: { ...input.parent.options },
      ...(input.signal ? { signal: input.signal } : {}),
      setup: async (agentCtx) => {
        const child = agentCtx.agent
        if (!child || child.id !== sessionId) {
          throw new EvolutionError('invalid_input', 'DSH verifier setup did not bind the expected session identity')
        }
        const childCwd = path.resolve(child.session.header.cwd ?? '')
        if (childCwd !== cwd) {
          throw new EvolutionError('invalid_input', 'DSH verifier cwd does not match the parent session cwd')
        }
        setSandboxMode(child.session, 'read-only')
        agentCtx.tools.register(defineTool({
          name: VERIFIER_SUBMIT_TOOL,
          description: 'Submit the one-shot semantic verification verdict. Host fills identity and digest fields.',
          parameters: {
            verdict: {
              type: 'string',
              enum: ['verified', 'rejected', 'uncertain'],
              required: true,
            },
            evidence: { type: 'array', items: { type: 'string' }, required: true },
            conditions: { type: 'array', items: { type: 'string' }, required: true },
          },
          output: {
            schema: { type: 'json' },
            render: (_args, value) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
          },
          async execute(args) {
            return jsonToolOutput(gate.submit(args, String(sessionId)))
          },
        }))
        agentCtx.on('tools/pre-execute', (exec, next) => {
          const reason = verifierDenyReason(exec.name)
          if (reason) return Promise.resolve({ kind: 'deny', reason })
          return next()
        })
        agentCtx.tools.guard((exec) => verifierDenyReason(exec.name))
        agentCtx.systemPrompt.section({
          name: 'autoevo:semantic-verifier-boundary',
          order: 119,
          text: 'This is a Host-owned AutoEvo semantic verifier. The session is read-only. Only autoevo_submit_verification is permitted. Verdicts are not authorization.',
        })
      },
    })

    let disposePromise: Promise<void> | undefined
    const dispose = (): Promise<void> => {
      gate.dispose()
      disposePromise ??= handle.dispose()
      return disposePromise
    }

    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timed_out'>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true
        resolve('timed_out')
      }, input.timeoutMs)
    })

    try {
      if (!parentAgents.isOwnedBy(handle.agent.id, input.parent)) {
        throw new EvolutionError('invalid_input', 'Created verifier is not owned by the initiating parent Agent')
      }
      if ((handle.agent.session.header.delegationDepth ?? 0) !== 1) {
        throw new EvolutionError('invalid_input', 'Created verifier must have delegationDepth 1')
      }
      if (path.resolve(handle.agent.session.header.cwd ?? '') !== cwd) {
        throw new EvolutionError('invalid_input', 'Created verifier cwd does not match the parent session cwd')
      }
      gate.markRunning()
      handle.agent.followup(createUserMessage({
        source: { kind: 'plugin', plugin: 'autoevo', form: 'relay' },
        content: [{
          type: 'text',
          text: verifierInstruction({
            requirement: input.requirement,
            receipt: input.receipt,
          }),
        }],
      }))
      const outcome = await waitForVerifierIdle(handle, input.signal, timeout, dispose)
      if (timer) clearTimeout(timer)
      const session = String(handle.agent.id)
      if (outcome === 'aborted') {
        const verdict = gate.isOpen() ? gate.closeCancelled(session) : gate.currentVerdict()!
        return { request: gate.request, verdict }
      }
      if (outcome === 'timed_out' || timedOut) {
        const verdict = gate.isOpen() ? gate.closeTimedOut(session) : gate.currentVerdict()!
        return { request: gate.request, verdict }
      }
      const verdict = gate.isOpen() ? gate.closeMissingSubmit(session) : gate.currentVerdict()!
      return { request: gate.request, verdict }
    } finally {
      if (timer) clearTimeout(timer)
      await dispose()
    }
  }
}

async function waitForVerifierIdle(
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

export const _testing = {
  parseVerifierSubmitArgs,
  rejectForgedVerifierSubmit,
  waitForVerifierIdle,
}
