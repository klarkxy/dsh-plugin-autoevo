import { describe, expect, it } from 'vitest'
import {
  FORGED_VERIFIER_SUBMIT_KEYS,
  VERIFIER_SUBMIT_TOOL,
  VERIFIER_VERSION,
  VerifierSubmissionGate,
  mintVerifierRequest,
  parseVerifierSubmitArgs,
  redactVerificationReceipt,
  verificationEvidenceDigest,
  verificationVerdictAllowsCompletion,
  verifierDenyReason,
  verifierInstruction,
} from '../../src/semantic-verifier.js'
import { requirementHashFor } from '../../src/semantic-reviewer.js'
import type { VerificationEvidence, VerificationVerdict } from '../../src/contracts.js'

const EVIDENCE: VerificationEvidence = {
  attempted: true,
  exitCode: 0,
  expectedTools: ['calculator'],
  calledTools: ['calculator'],
  resultTools: ['calculator'],
  failedTools: [],
  sessionFiles: ['C:/secret/session.jsonl'],
  receiptPath: 'C:/secret/receipt.jsonl',
  taskResultObserved: true,
  taskResultSha256: 'a'.repeat(64),
  taskResultMatchedExpectation: false,
  reason: 'ok',
}

function openGate(): VerifierSubmissionGate {
  const digest = verificationEvidenceDigest(EVIDENCE)
  const request = mintVerifierRequest({
    installationId: `installation_${'c'.repeat(24)}`,
    reviewId: `review_${'a'.repeat(64)}`,
    requirement: 'calculator',
    evidenceDigest: digest,
    createdAt: '2026-08-19T00:00:00.000Z',
  })
  const gate = new VerifierSubmissionGate({
    installationId: request.installationId,
    reviewId: request.reviewId,
    requirementHash: requirementHashFor('calculator'),
    evidenceDigest: digest,
  }, request)
  gate.markRunning('2026-08-19T00:00:01.000Z')
  return gate
}

function boundVerdict(overrides: Partial<VerificationVerdict> = {}): VerificationVerdict {
  const digest = verificationEvidenceDigest(EVIDENCE)
  return {
    requestId: 'verifier_x',
    installationId: `installation_${'c'.repeat(24)}`,
    reviewId: `review_${'a'.repeat(64)}`,
    requirementHash: requirementHashFor('calculator'),
    evidenceDigest: digest,
    verifierSessionId: 'verifier-session',
    verifierVersion: VERIFIER_VERSION,
    decision: 'verified',
    evidence: [],
    conditions: [],
    createdAt: '2026-08-19T00:00:02.000Z',
    ...overrides,
  }
}

function expectedBinding() {
  return {
    installationId: `installation_${'c'.repeat(24)}`,
    reviewId: `review_${'a'.repeat(64)}`,
    requirement: 'calculator',
    evidenceDigest: verificationEvidenceDigest(EVIDENCE),
  }
}

describe('semantic verifier gate', () => {
  it('locks the first submit and fills Host identity without authorization fields', () => {
    const gate = openGate()
    const verdict = gate.submit({
      verdict: 'verified',
      evidence: ['tool result completed the requirement'],
      conditions: [],
    }, 'verifier-session')
    expect(verdict).toMatchObject({
      requestId: gate.request.id,
      reviewId: `review_${'a'.repeat(64)}`,
      requirementHash: requirementHashFor('calculator'),
      verifierVersion: VERIFIER_VERSION,
      decision: 'verified',
    })
    expect(verdict).not.toHaveProperty('authorization')
    expect(verdict).not.toHaveProperty('installSpec')
    expect(verdict).not.toHaveProperty('endpoint')
    expect(verdict).not.toHaveProperty('executionLease')
  })

  it('rejects forged Host fields and late submit after timeout', () => {
    expect(() => parseVerifierSubmitArgs({
      verdict: 'verified',
      evidence: [],
      conditions: [],
      authorization: { state: 'use_review' },
    })).toThrow(/does not accept Host-owned or authorization fields/i)
    expect(() => parseVerifierSubmitArgs({
      verdict: 'verified',
      evidence: [],
      conditions: [],
      installSpec: 'github:acme/calculator',
    })).toThrow(/does not accept Host-owned or authorization fields/i)
    for (const key of ['endpoint', 'lease', 'evidenceDigest'] as const) {
      expect(FORGED_VERIFIER_SUBMIT_KEYS).toContain(key)
    }
    const gate = openGate()
    gate.closeTimedOut('verifier-session')
    expect(() => gate.submit({
      verdict: 'verified',
      evidence: ['late'],
      conditions: [],
    }, 'verifier-session')).toThrow(/no longer accepting submissions/i)
  })

  it('mints uncertain when the session ends without a submit', () => {
    const gate = openGate()
    const verdict = gate.closeMissingSubmit('verifier-session')
    expect(verdict.decision).toBe('uncertain')
  })

  it('returns uncertain after timeout or cancel and rejects a late submit', () => {
    const timed = openGate()
    const timeoutVerdict = timed.closeTimedOut('verifier-session')
    expect(timeoutVerdict.decision).toBe('uncertain')
    expect(timed.request.status).toBe('timed_out')
    expect(() => timed.submit({
      verdict: 'verified',
      evidence: ['late after timeout'],
      conditions: [],
    }, 'verifier-session')).toThrow(/no longer accepting submissions/i)

    const cancelled = openGate()
    expect(cancelled.closeCancelled('verifier-session').decision).toBe('uncertain')
    expect(cancelled.request.status).toBe('cancelled')
    expect(() => cancelled.submit({
      verdict: 'verified',
      evidence: ['late after cancel'],
      conditions: [],
    }, 'verifier-session')).toThrow(/no longer accepting submissions/i)

    const disposed = openGate()
    disposed.dispose()
    expect(() => disposed.submit({
      verdict: 'verified',
      evidence: ['after dispose'],
      conditions: [],
    }, 'verifier-session')).toThrow(/handle was disposed/i)
  })

  it('redacts source paths from the verifier receipt and binds the mechanical digest', () => {
    const redacted = redactVerificationReceipt(EVIDENCE)
    expect(JSON.stringify(redacted)).not.toMatch(/C:\\secret|session\.jsonl|receipt\.jsonl/i)
    expect(redacted).not.toHaveProperty('taskResultMatchedExpectation')
    const digest = verificationEvidenceDigest(EVIDENCE)
    expect(verificationVerdictAllowsCompletion({
      requestId: 'verifier_x',
      installationId: `installation_${'c'.repeat(24)}`,
      reviewId: `review_${'a'.repeat(64)}`,
      requirementHash: requirementHashFor('calculator'),
      evidenceDigest: digest,
      verifierSessionId: 'verifier-session',
      verifierVersion: VERIFIER_VERSION,
      decision: 'verified',
      evidence: [],
      conditions: [],
      createdAt: '2026-08-19T00:00:02.000Z',
    }, {
      installationId: `installation_${'c'.repeat(24)}`,
      reviewId: `review_${'a'.repeat(64)}`,
      requirement: 'calculator',
      evidenceDigest: digest,
    })).toBe(true)
    expect(verificationVerdictAllowsCompletion({
      requestId: 'verifier_x',
      installationId: `installation_${'c'.repeat(24)}`,
      reviewId: `review_${'a'.repeat(64)}`,
      requirementHash: requirementHashFor('calculator'),
      evidenceDigest: '9'.repeat(64),
      verifierSessionId: 'verifier-session',
      verifierVersion: VERIFIER_VERSION,
      decision: 'verified',
      evidence: [],
      conditions: [],
      createdAt: '2026-08-19T00:00:02.000Z',
    }, {
      installationId: `installation_${'c'.repeat(24)}`,
      reviewId: `review_${'a'.repeat(64)}`,
      requirement: 'calculator',
      evidenceDigest: digest,
    })).toBe(false)
  })

  it('fail-closes stale evidence digest, empty session, or wrong verifier version', () => {
    const expected = expectedBinding()
    expect(verificationVerdictAllowsCompletion(boundVerdict(), expected)).toBe(true)
    expect(verificationVerdictAllowsCompletion(boundVerdict({ evidenceDigest: '9'.repeat(64) }), expected)).toBe(false)
    expect(verificationVerdictAllowsCompletion(boundVerdict({ verifierSessionId: '' }), expected)).toBe(false)
    expect(verificationVerdictAllowsCompletion(boundVerdict({ verifierSessionId: '   ' }), expected)).toBe(false)
    expect(verificationVerdictAllowsCompletion(boundVerdict({ verifierVersion: '0' }), expected)).toBe(false)
    expect(verificationVerdictAllowsCompletion(boundVerdict({ requirementHash: '8'.repeat(64) }), expected)).toBe(false)
    expect(verificationVerdictAllowsCompletion(boundVerdict({ installationId: `installation_${'d'.repeat(24)}` }), expected)).toBe(false)
    expect(verificationVerdictAllowsCompletion(boundVerdict({ reviewId: `review_${'e'.repeat(64)}` }), expected)).toBe(false)
    expect(verificationVerdictAllowsCompletion(boundVerdict({ decision: 'uncertain' }), expected)).toBe(false)
  })

  it('denies every tool except the one-shot submit tool', () => {
    expect(verifierDenyReason(VERIFIER_SUBMIT_TOOL)).toBeUndefined()
    expect(verifierDenyReason('capability_workflow_resume')).toMatch(/denies AutoEvo decision tools/i)
    expect(verifierDenyReason('pwsh')).toMatch(/only autoevo_submit_verification/i)
    expect(verifierInstruction({
      requirement: 'calculator',
      receipt: redactVerificationReceipt(EVIDENCE),
    })).toMatch(/not authorization/i)
  })
})
