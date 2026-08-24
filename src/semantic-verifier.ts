import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type {
  VerificationEvidence,
  VerificationVerdict,
  VerificationVerdictDecision,
  VerifierRequest,
} from './contracts.js'
import { EvolutionError } from './errors.js'
import {
  DIGEST_RE,
  REVIEW_ID_RE,
  assertTimeoutWithinBound,
  boundedNotes,
  mintSemanticRequestId,
  rejectForgedSubmit,
  requirementHashFor,
  requireSubmitObject,
  runSemanticSubagent,
  semanticDenyReason,
  SemanticSubmissionGate,
  waitForChildIdle,
  type SemanticSubmissionGateHooks,
} from './semantic-host.js'
import { hashObject } from './state/hashes.js'

export const VERIFIER_SUBMIT_TOOL = 'autoevo_submit_verification'
export const VERIFIER_VERSION = '1'
export const VERIFIER_SESSION_PREFIX = 'autoevo-verifier-'

const INSTALL_ID_RE = /^installation_[a-f0-9]{16,64}$/u

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
    id: mintSemanticRequestId('verifier_', {
      installationId: input.installationId,
      reviewId: input.reviewId,
      evidenceDigest: input.evidenceDigest,
      createdAt,
    }),
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
  assertTimeoutWithinBound(input.timeoutMs)
  if (!input.requirement.trim()) {
    throw new EvolutionError('invalid_input', 'Verifier input requires the original requirement')
  }
}

export function rejectForgedVerifierSubmit(args: Record<string, unknown>): void {
  rejectForgedSubmit(args, FORGED_VERIFIER_SUBMIT_KEYS, SUBMIT_KEYS, VERIFIER_SUBMIT_TOOL)
}

export interface ParsedVerifierSubmit {
  verdict: VerificationVerdictDecision
  evidence: string[]
  conditions: string[]
}

export function parseVerifierSubmitArgs(value: unknown): ParsedVerifierSubmit {
  const args = requireSubmitObject(value, VERIFIER_SUBMIT_TOOL)
  rejectForgedVerifierSubmit(args)
  const verdict = args.verdict
  if (verdict !== 'verified' && verdict !== 'rejected' && verdict !== 'uncertain') {
    throw new EvolutionError('invalid_input', 'verdict must be verified, rejected, or uncertain')
  }
  return {
    verdict,
    evidence: boundedNotes(args.evidence, 'evidence'),
    conditions: boundedNotes(args.conditions, 'conditions'),
  }
}

export function verifierDenyReason(name: string): string | undefined {
  return semanticDenyReason(name, 'verifier', VERIFIER_SUBMIT_TOOL)
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

function verifierGateHooks(
  binding: VerifierHostBinding,
): SemanticSubmissionGateHooks<ParsedVerifierSubmit, VerificationVerdict> {
  return {
    role: 'verifier',
    submitTool: VERIFIER_SUBMIT_TOOL,
    parseSubmitArgs: parseVerifierSubmitArgs,
    buildVerdict(requestId, parsed, verifierSessionId, createdAt) {
      return {
        requestId,
        installationId: binding.installationId,
        reviewId: binding.reviewId,
        requirementHash: binding.requirementHash,
        evidenceDigest: binding.evidenceDigest,
        verifierSessionId,
        verifierVersion: VERIFIER_VERSION,
        decision: parsed.verdict,
        evidence: parsed.evidence,
        conditions: parsed.conditions,
        createdAt,
      }
    },
    buildFallbackVerdict(requestId, verifierSessionId, createdAt, evidence) {
      return {
        requestId,
        installationId: binding.installationId,
        reviewId: binding.reviewId,
        requirementHash: binding.requirementHash,
        evidenceDigest: binding.evidenceDigest,
        verifierSessionId,
        verifierVersion: VERIFIER_VERSION,
        decision: 'uncertain',
        evidence: [evidence],
        conditions: [],
        createdAt,
      }
    },
  }
}

export class VerifierSubmissionGate extends SemanticSubmissionGate<VerifierRequest, ParsedVerifierSubmit, VerificationVerdict> {
  constructor(binding: VerifierHostBinding, request: VerifierRequest) {
    super(verifierGateHooks(binding), request)
  }
}

/** Real Host-owned DSH semantic verifier lifecycle. */
export class DshSemanticVerifierHost implements SemanticVerifierHost {
  constructor(private readonly ctx: Context) {}

  async run(input: VerifierRunInput): Promise<SemanticVerifierResult> {
    validateVerifierRunInput(input)
    const binding: VerifierHostBinding = {
      installationId: input.installationId,
      reviewId: input.reviewId,
      requirementHash: requirementHashFor(input.requirement),
      evidenceDigest: input.evidenceDigest,
    }
    return runSemanticSubagent({
      role: 'verifier',
      rolePlural: 'verifiers',
      sessionPrefix: VERIFIER_SESSION_PREFIX,
      parent: input.parent,
      signal: input.signal,
      timeoutMs: input.timeoutMs,
      gate: new VerifierSubmissionGate(binding, mintVerifierRequest({
        installationId: input.installationId,
        reviewId: input.reviewId,
        requirement: input.requirement,
        evidenceDigest: input.evidenceDigest,
      })),
      submitTool: {
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
      },
      denyReason: verifierDenyReason,
      boundarySection: {
        name: 'autoevo:semantic-verifier-boundary',
        text: 'This is a Host-owned AutoEvo semantic verifier. The session is read-only. Only autoevo_submit_verification is permitted. Verdicts are not authorization.',
      },
      instruction: () => verifierInstruction({
        requirement: input.requirement,
        receipt: input.receipt,
      }),
    })
  }
}

export const _testing = {
  parseVerifierSubmitArgs,
  rejectForgedVerifierSubmit,
  waitForVerifierIdle: waitForChildIdle,
}
