import type {
  ReviewerRequest,
  ReviewerVerdict,
  ReviewRecord,
} from './contracts.js'
import { EvolutionError } from './errors.js'
import {
  needsSemanticReviewer,
  reviewCandidateDigest,
  reviewSnapshotDigest,
} from './review/index.js'
import type { ContentFile } from './review/review.js'
import {
  mintReviewerRequest,
  requirementHashFor,
  REVIEWER_VERSION,
  type BoundedReviewFile,
  type SemanticReviewerHost,
} from './semantic-reviewer.js'
import { hashObject } from './state/hashes.js'
import type { WorkflowExec, WorkflowRecord } from './workflow/contracts.js'

export function boundedReviewerFiles(files: readonly ContentFile[], inspected: ReviewRecord['inspectedFiles']): BoundedReviewFile[] {
  return inspected.map((item) => {
    const file = files.find((entry) => entry.path === item.path)
    return {
      path: item.path,
      sha256: item.sha256,
      bytes: item.bytes,
      text: file ? Buffer.from(file.content).toString('utf8') : '',
    }
  })
}

function isReviewerIntegrityError(error: unknown): boolean {
  return error instanceof EvolutionError && (error.code === 'invalid_input' || error.code === 'review_rejected')
}

function hostMintedUncertain(
  review: ReviewRecord,
  workflowId: string,
  snapshotDigest: string,
  candidateDigest: string,
  evidence: string,
): { request: ReviewerRequest; verdict: ReviewerVerdict } {
  const request = mintReviewerRequest({
    workflowId,
    review,
    snapshotDigest,
    candidateDigest,
  })
  const completedAt = new Date().toISOString()
  return {
    request: { ...request, status: 'completed', startedAt: request.createdAt, completedAt },
    verdict: {
      requestId: request.id,
      reviewId: review.id,
      requirementHash: requirementHashFor(review.requirement),
      snapshotDigest,
      candidateDigest,
      reviewerSessionId: 'host',
      reviewerVersion: REVIEWER_VERSION,
      decision: 'uncertain',
      evidence: [evidence.slice(0, 300)],
      conditions: [],
      semanticCoverage: 'none',
      createdAt: completedAt,
    },
  }
}

export function assertSemanticReviewerBinding(
  review: ReviewRecord,
  result: { request: ReviewerRequest; verdict: ReviewerVerdict },
  expected: { snapshotDigest: string; candidateDigest: string },
): void {
  if (result.request.reviewId !== review.id || result.verdict.reviewId !== review.id) {
    throw new EvolutionError('invalid_input', 'Semantic reviewer result is not bound to this review', {
      reviewId: review.id,
    })
  }
  if (result.request.id !== result.verdict.requestId) {
    throw new EvolutionError('invalid_input', 'Semantic reviewer verdict is not bound to its request')
  }
  if (result.request.snapshotDigest !== expected.snapshotDigest
    || result.verdict.snapshotDigest !== expected.snapshotDigest
    || result.request.candidateDigest !== expected.candidateDigest
    || result.verdict.candidateDigest !== expected.candidateDigest) {
    throw new EvolutionError('invalid_input', 'Semantic reviewer result digest mismatch', {
      expectedSnapshot: expected.snapshotDigest,
      expectedCandidate: expected.candidateDigest,
    })
  }
  if (result.verdict.requirementHash !== requirementHashFor(review.requirement)) {
    throw new EvolutionError('invalid_input', 'Semantic reviewer requirement hash mismatch')
  }
}

export async function attachSemanticReview(input: {
  host: SemanticReviewerHost
  review: ReviewRecord
  files: readonly ContentFile[]
  exec: WorkflowExec
  workflow?: WorkflowRecord
  timeoutMs: number
}): Promise<ReviewRecord> {
  if (!needsSemanticReviewer(input.review)) return input.review
  const snapshotDigest = reviewSnapshotDigest(input.review)
  const candidateDigest = reviewCandidateDigest(input.review, input.workflow)
  const workflowId = input.workflow?.id
    ?? `workflow_${hashObject({ resolutionId: input.review.resolutionId, reviewId: input.review.id }).slice(0, 24)}`
  if (!input.exec.agent) {
    const minted = hostMintedUncertain(
      input.review,
      workflowId,
      snapshotDigest,
      candidateDigest,
      'Semantic reviewer unavailable: no live top-level Agent',
    )
    return {
      ...input.review,
      reviewerRequestId: minted.request.id,
      reviewerRequest: minted.request,
      reviewerVerdict: minted.verdict,
    }
  }
  if ((input.exec.agent.session?.header?.delegationDepth ?? 0) !== 0) {
    const minted = hostMintedUncertain(
      input.review,
      workflowId,
      snapshotDigest,
      candidateDigest,
      'Semantic reviewer unavailable: parent Agent is not top-level',
    )
    return {
      ...input.review,
      reviewerRequestId: minted.request.id,
      reviewerRequest: minted.request,
      reviewerVerdict: minted.verdict,
    }
  }
  try {
    const result = await input.host.run({
      parent: input.exec.agent,
      workflowId,
      review: input.review,
      candidateDigest,
      snapshotDigest,
      files: boundedReviewerFiles(input.files, input.review.inspectedFiles),
      timeoutMs: input.timeoutMs,
      ...(input.exec.signal ? { signal: input.exec.signal } : {}),
    })
    assertSemanticReviewerBinding(input.review, result, { snapshotDigest, candidateDigest })
    return {
      ...input.review,
      reviewerRequestId: result.request.id,
      reviewerRequest: result.request,
      reviewerVerdict: result.verdict,
    }
  } catch (error) {
    if (isReviewerIntegrityError(error)) throw error
    const minted = hostMintedUncertain(
      input.review,
      workflowId,
      snapshotDigest,
      candidateDigest,
      error instanceof Error ? error.message : String(error),
    )
    return {
      ...input.review,
      reviewerRequestId: minted.request.id,
      reviewerRequest: minted.request,
      reviewerVerdict: minted.verdict,
    }
  }
}
