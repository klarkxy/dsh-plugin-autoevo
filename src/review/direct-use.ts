import path from 'node:path'
import { POLICY_VERSION, type ActionCommitment, type ReviewRecord, type ReviewerVerdict, type SelectionReceipt } from '../contracts.js'
import { EvolutionError } from '../errors.js'
import { isSafePackageName } from '../package-name.js'
import { hashObject } from '../state/hashes.js'
import { HARD_SKIP_FINDING_CODES } from './review.js'

const DIGEST_RE = /^[a-f0-9]{64}$/u

/** Minimal snapshot context for candidate-digest binding. WorkflowRecord is assignable. */
export interface ReviewCandidateContext {
  id?: string
  lastInstallationId?: string
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
    artifact: review.artifact,
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

function reviewedArtifactIsOwned(review: ReviewRecord): boolean {
  if (!review.artifact || !DIGEST_RE.test(review.artifact.sha256)
    || !Number.isSafeInteger(review.artifact.bytes) || review.artifact.bytes <= 0
    || !Number.isSafeInteger(review.artifact.entryCount) || review.artifact.entryCount <= 0
    || review.artifact.entryCount !== review.inspectedFiles.length
    || !review.installSpec?.startsWith('file:')) return false
  const artifactPath = path.resolve(review.installSpec.slice('file:'.length))
  const ownedRoot = path.resolve(review.artifact.ownedRoot)
  const relative = path.relative(ownedRoot, artifactPath)
  return Boolean(relative) && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
}

/** Host hard boundaries only. Mechanical recommendation/fit/risk/regex are not boundaries. */
export function hostDirectUseBoundary(review: ReviewRecord): DirectUseHostBoundary | undefined {
  if (!reviewedArtifactIsOwned(review)) return 'not_materializable'
  if (review.mechanicalFacts?.directUseHostBoundary === 'not_materializable') return 'not_materializable'
  if (review.mechanicalFacts?.manifest.materializable === false) return 'not_materializable'
  if (review.sourceSnapshot.kind === 'local' && review.mechanicalFacts?.truncated) return 'not_materializable'

  const findings = review.findings ?? []
  if (findings.some((item) => HARD_SKIP_FINDING_CODES.has(item.code))
    || (review.sourceSnapshot.kind === 'local' && findings.some((item) => item.code === 'review_truncated'))) {
    return 'not_materializable'
  }
  if (review.manifest?.kind !== 'bundle') return 'not_materializable'
  if (!isSafePackageName(review.manifest.packageName)) return 'not_materializable'

  if (!review.installSpec?.startsWith('file:')) {
    return 'not_materializable'
  }
  return undefined
}

/**
 * Direct use is an installability check. Fit, recommendations, and semantic
 * review results remain advisory information for the user's explicit decision.
 */
export function isDirectlyUsableReview(review: ReviewRecord, _workflow?: ReviewCandidateContext): boolean {
  if (review.policyVersion !== POLICY_VERSION) return false
  return hostDirectUseBoundary(review) === undefined
}

/** Managed repair still requires a complete, current-policy review to bind its baseline. */
export function isManagedModificationEligibleReview(review: ReviewRecord): boolean {
  if (review.policyVersion !== POLICY_VERSION || review.fit === 'none' || review.license === null) return false
  if (review.mechanicalFacts?.truncated) return false
  return !review.findings.some((finding) => finding.code === 'review_truncated')
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
  recoveryPlan?: ActionCommitment['allowedParameterConstraints']['recoveryPlan']
}

export function assertDirectUseAllowed(review: ReviewRecord, _workflow?: ReviewCandidateContext): void {
  if (review.policyVersion !== POLICY_VERSION) {
    throw new EvolutionError('review_rejected', 'This review predates the current policy and cannot authorize installation', {
      reviewId: review.id,
      policyVersion: review.policyVersion,
      expected: POLICY_VERSION,
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
}
