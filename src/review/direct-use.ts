import { POLICY_VERSION, type ActionCommitment, type ReviewRecord, type ReviewerVerdict, type SelectionReceipt } from '../contracts.js'
import { EvolutionError } from '../errors.js'
import { isSafePackageName } from '../package-name.js'
import { requirementHashFor, REVIEWER_VERSION } from '../semantic-reviewer.js'
import { hashObject } from '../state/hashes.js'
import { HARD_SKIP_FINDING_CODES, needsSemanticReviewer } from './review.js'

const DIGEST_RE = /^[a-f0-9]{64}$/u

/** Minimal snapshot context for candidate-digest binding. WorkflowRecord is assignable. */
export interface ReviewCandidateContext {
  id?: string
  candidateSnapshot?: ReadonlyArray<{
    id: string
    kind: 'local' | 'remote'
    repository?: string
    identity: string
    digest?: string
  }>
  reviewIdsByCandidate?: Record<string, string>
}

export type DirectUseHostBoundary = 'incompatible' | 'not_materializable'

export function reviewSnapshotDigest(review: ReviewRecord): string {
  return hashObject({
    requirement: review.requirement,
    sourceSnapshot: review.sourceSnapshot,
    inspectedFiles: review.inspectedFiles,
    manifest: review.manifest,
    mechanicalFacts: review.mechanicalFacts,
  })
}

export function reviewCandidateDigest(review: ReviewRecord, workflow?: ReviewCandidateContext): string {
  const snapshot = workflow?.candidateSnapshot ?? []
  const sourceSnapshot = review.sourceSnapshot
  if (sourceSnapshot.kind === 'github') {
    const repository = sourceSnapshot.repository
    const hit = snapshot.find((item) => item.kind === 'remote'
      && item.repository?.toLowerCase() === repository.toLowerCase())
    if (hit?.digest && DIGEST_RE.test(hit.digest)) return hit.digest
  } else {
    const localPath = sourceSnapshot.path
    const mappedId = Object.entries(workflow?.reviewIdsByCandidate ?? {})
      .find(([, reviewId]) => reviewId === review.id)?.[0]
    const hit = mappedId
      ? snapshot.find((item) => item.id === mappedId)
      : snapshot.find((item) => item.kind === 'local' && item.identity.includes(localPath))
    if (hit?.digest && DIGEST_RE.test(hit.digest)) return hit.digest
  }
  return hashObject({
    sourceSnapshot: review.sourceSnapshot,
    inspectedFiles: review.inspectedFiles,
  })
}

function expectedGithubInstallSpec(review: ReviewRecord): string | null {
  if (review.sourceSnapshot?.kind !== 'github' || !review.manifest?.packageName) return null
  return `github:${review.sourceSnapshot.repository}#${review.sourceSnapshot.commit}`
}

/** Host hard boundaries only. Mechanical recommendation/fit/risk/regex are not boundaries. */
export function hostDirectUseBoundary(review: ReviewRecord): DirectUseHostBoundary | undefined {
  if (review.compatibility?.status === 'incompatible'
    || review.mechanicalFacts?.directUseHostBoundary === 'incompatible') {
    return 'incompatible'
  }
  if (review.mechanicalFacts?.directUseHostBoundary === 'not_materializable') return 'not_materializable'
  if (review.mechanicalFacts?.manifest.materializable === false) return 'not_materializable'
  if (review.mechanicalFacts?.truncated) return 'not_materializable'

  const findings = review.findings ?? []
  if (findings.some((item) => item.code === 'review_truncated' || HARD_SKIP_FINDING_CODES.has(item.code))) {
    return 'not_materializable'
  }
  if (review.manifest?.kind !== 'bundle') return 'not_materializable'
  if (!isSafePackageName(review.manifest.packageName)) return 'not_materializable'

  const source = review.sourceSnapshot
  if (!source) return 'not_materializable'
  if (source.kind === 'github') {
    const expected = expectedGithubInstallSpec(review)
    if (!expected || review.installSpec !== expected) return 'not_materializable'
  } else if (review.installSpec && !review.installSpec.startsWith('file:')) {
    return 'not_materializable'
  }
  return undefined
}

function requestMatchesReview(
  review: ReviewRecord,
  request: NonNullable<ReviewRecord['reviewerRequest']>,
  verdict: ReviewerVerdict,
  workflow?: ReviewCandidateContext,
): boolean {
  if (request.reviewId !== review.id || verdict.reviewId !== review.id) return false
  if (verdict.requestId !== request.id) return false
  if (review.reviewerRequestId && review.reviewerRequestId !== request.id) return false
  if (workflow?.id && request.workflowId !== workflow.id) return false
  if (verdict.requirementHash !== requirementHashFor(review.requirement)) return false
  const snapshotDigest = reviewSnapshotDigest(review)
  if (request.snapshotDigest !== snapshotDigest || verdict.snapshotDigest !== snapshotDigest) return false
  if (request.candidateDigest !== verdict.candidateDigest) return false
  if (workflow) {
    const current = reviewCandidateDigest(review, workflow)
    if (verdict.candidateDigest !== current || request.candidateDigest !== current) return false
  }
  if (verdict.reviewerVersion !== REVIEWER_VERSION) return false
  if (!verdict.reviewerSessionId.trim()) return false
  return true
}

/** True when no reviewer is required, or the current bound verdict is approved. */
export function reviewerVerdictAllowsDirectUse(
  review: ReviewRecord,
  workflow?: ReviewCandidateContext,
): boolean {
  if (!needsSemanticReviewer(review)) return true
  const request = review.reviewerRequest
  const verdict = review.reviewerVerdict
  if (!request || !verdict) return false
  if (request.status !== 'completed' || verdict.decision !== 'approved') return false
  return requestMatchesReview(review, request, verdict, workflow)
}

export function isDirectlyUsableReview(review: ReviewRecord, workflow?: ReviewCandidateContext): boolean {
  if (review.policyVersion !== POLICY_VERSION) return false
  if (review.fit === 'none') return false
  return hostDirectUseBoundary(review) === undefined && reviewerVerdictAllowsDirectUse(review, workflow)
}

export function reviewerBindingDigest(verdict: ReviewerVerdict): string {
  return hashObject({
    requestId: verdict.requestId,
    reviewId: verdict.reviewId,
    requirementHash: verdict.requirementHash,
    snapshotDigest: verdict.snapshotDigest,
    candidateDigest: verdict.candidateDigest,
    reviewerSessionId: verdict.reviewerSessionId,
    reviewerVersion: verdict.reviewerVersion,
    decision: verdict.decision,
  })
}

export function frozenManifestDigest(review: ReviewRecord): string {
  return hashObject(review.manifest)
}

export interface InstallCommitmentBinding {
  workflow?: ReviewCandidateContext
  commitment?: ActionCommitment
  receipt?: SelectionReceipt
  retention?: ActionCommitment['retention']
}

export function assertDirectUseAllowed(review: ReviewRecord, workflow?: ReviewCandidateContext): void {
  if (review.policyVersion !== POLICY_VERSION) {
    throw new EvolutionError('review_rejected', 'This review predates the current policy and cannot authorize installation', {
      reviewId: review.id,
      policyVersion: review.policyVersion,
      expected: POLICY_VERSION,
    })
  }
  if (review.fit === 'none') {
    throw new EvolutionError('review_rejected', 'This review does not authorize installation', {
      fit: review.fit,
    })
  }
  const boundary = hostDirectUseBoundary(review)
  if (boundary) {
    throw new EvolutionError('review_rejected', 'This review does not authorize installation', {
      hostBoundary: boundary,
      compatibility: review.compatibility?.status,
      manifestKind: review.manifest?.kind,
    })
  }
  if (!reviewerVerdictAllowsDirectUse(review, workflow)) {
    throw new EvolutionError('review_rejected', 'Semantic reviewer verdict does not authorize direct use', {
      reviewId: review.id,
      decision: review.reviewerVerdict?.decision,
      required: needsSemanticReviewer(review),
    })
  }
}
