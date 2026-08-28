import { randomUUID } from 'node:crypto'
import type { ResolutionRecord, ReviewRecord } from '../contracts.js'
import { EvolutionError } from '../errors.js'
import { hashObject } from '../state/hashes.js'
import type { CandidateSnapshotItem, InterruptPayload, WorkflowRecord, WorkflowView } from './contracts.js'

function localCandidateIdentity(item: ResolutionRecord['localCandidates'][number]): string {
  return [
    item.kind,
    item.name,
    item.profileEvidence?.profile ?? '',
    item.profileEvidence?.packageName ?? '',
  ].join('\0')
}

export const MIXED_SNAPSHOT_MAX = 8
/** Five bounded GitHub pages plus five exact repositories in one user turn. */
export const DISCOVERY_REMOTE_POOL_MAX = 105
/** Preserve the complete remote union without letting the bounded local set consume its slots. */
export const DISCOVERY_POOL_MAX = 113 as const
export const SEALED_SHORTLIST_MAX = 5

export function candidateId(
  kind: CandidateSnapshotItem['kind'],
  identity: string,
  evidenceDigest?: string,
): string {
  return `candidate_${hashObject({
    kind,
    identity: identity.toLowerCase(),
    ...(evidenceDigest ? { evidenceDigest } : {}),
  }).slice(0, 24)}`
}

export function excludedCandidateIds(workflow?: Pick<WorkflowRecord, 'seenCandidateIds' | 'rejectedCandidateIds'>): Set<string> {
  return new Set([...(workflow?.seenCandidateIds ?? []), ...(workflow?.rejectedCandidateIds ?? [])])
}

function localSnapshotItem(item: ResolutionRecord['localCandidates'][number]): Omit<CandidateSnapshotItem, 'index'> {
  return {
    id: candidateId('local', localCandidateIdentity(item)),
    kind: 'local',
    name: item.name,
    identity: item.name,
    localName: item.name,
    localKind: item.kind,
    availability: item.availability,
    ...(item.fit ? { fit: item.fit } : {}),
    ...(item.semanticFit ? { semanticFit: item.semanticFit } : {}),
    ...(item.surfaceMatch !== undefined ? { surfaceMatch: item.surfaceMatch } : {}),
    ...(item.reuseEligible !== undefined ? { reuseEligible: item.reuseEligible } : {}),
    ...(item.evolutionTarget ? {
      repository: item.evolutionTarget.repository,
      evolutionTarget: item.evolutionTarget,
    } : {}),
    ...(item.hostBundled ? { hostBundled: item.hostBundled } : {}),
    ...(item.profileEvidence ? { installation: {
      source: item.profileEvidence.source,
      profile: item.profileEvidence.profile,
      package_name: item.profileEvidence.packageName,
      dependency_spec: item.profileEvidence.dependencySpec,
      configured_bundle: item.profileEvidence.configuredBundle,
    } } : {}),
    digest: hashObject({
      kind: item.kind,
      name: item.name,
      description: item.description,
      availability: item.availability,
      fit: item.fit,
      semanticFit: item.semanticFit,
      surfaceMatch: item.surfaceMatch,
      reuseEligible: item.reuseEligible,
      evolutionTarget: item.evolutionTarget,
      profileEvidence: item.profileEvidence,
      hostBundled: item.hostBundled,
    }),
  }
}

function remoteEvidenceDigest(item: ResolutionRecord['remoteCandidates'][number]): string {
  return hashObject({
    repository: item.repository,
    name: item.name,
    description: item.description,
    stars: item.stars,
    updatedAt: item.updatedAt,
    defaultBranch: item.defaultBranch,
    topics: item.topics,
    matchedTerms: item.matchedTerms,
    matchReason: item.matchReason,
  })
}

export function remoteCandidateId(item: ResolutionRecord['remoteCandidates'][number]): string {
  return candidateId('remote', item.repository, remoteEvidenceDigest(item))
}

function remoteSnapshotItem(item: ResolutionRecord['remoteCandidates'][number]): Omit<CandidateSnapshotItem, 'index'> {
  const digest = remoteEvidenceDigest(item)
  return {
    id: candidateId('remote', item.repository, digest),
    kind: 'remote',
    name: item.name,
    identity: item.repository,
    repository: item.repository,
    digest,
  }
}

export function candidateSnapshotFor(
  resolution: ResolutionRecord,
  excludedIds: ReadonlySet<string> = new Set(),
  limit = MIXED_SNAPSHOT_MAX,
): CandidateSnapshotItem[] {
  const locals = resolution.localCandidates
    .filter((item) => item.fit !== 'none')
    .map(localSnapshotItem)
    .filter((item) => !excludedIds.has(item.id))
  const remotes = resolution.remoteCandidates
    .map(remoteSnapshotItem)
    .filter((item) => !excludedIds.has(item.id))
  const picked: Array<Omit<CandidateSnapshotItem, 'index'>> = []

  if (locals.length > 0 && remotes.length > 0) {
    const fullLocals = locals.filter((item) => item.fit === 'full')
    const otherLocals = locals.filter((item) => item.fit !== 'full')
    for (const item of fullLocals) {
      if (picked.length >= limit - 1) break
      picked.push(item)
    }
    if (picked.length === 0) picked.push(otherLocals[0] ?? locals[0]!)
    for (const item of remotes) {
      if (picked.length >= limit) break
      picked.push(item)
    }
    for (const item of [...fullLocals, ...otherLocals, ...remotes]) {
      if (picked.length >= limit) break
      if (!picked.includes(item)) picked.push(item)
    }
  } else {
    picked.push(...(locals.length > 0 ? locals : remotes).slice(0, limit))
  }

  return picked.map((item, offset) => ({ ...item, index: offset + 1 }))
}

export function registerReviewedCandidate(workflow: WorkflowRecord, review: ReviewRecord): void {
  const snapshot = workflow.candidateSnapshot ?? []
  const source = review.sourceSnapshot
  let candidate = workflow.pendingReviewedCandidateId
    ? snapshot.find((item) => item.id === workflow.pendingReviewedCandidateId)
    : undefined
  if (!candidate && source.kind === 'github') {
    candidate = snapshot.find((item) => item.repository?.toLowerCase() === source.repository.toLowerCase())
      ?? snapshot.find((item) => item.evolutionTarget?.repository.toLowerCase() === source.repository.toLowerCase()
        && item.evolutionTarget.commit === source.commit)
  }
  if (!candidate) {
    candidate = snapshot.find((item) => workflow.reviewIdsByCandidate?.[item.id] === review.id)
  }

  if (!candidate && source.kind === 'local') {
    const frozen = snapshot.find((item) => item.evolutionTarget
      && review.manifest.packageName
      && item.evolutionTarget.packageName === review.manifest.packageName)
    if (frozen) candidate = frozen
    else {
      const identity = `${source.path}:${source.statusHash}`
      candidate = {
        id: candidateId('local', identity),
        index: snapshot.reduce((max, item) => Math.max(max, item.index), 0) + 1,
        kind: 'local',
        name: review.manifest.packageName ?? 'managed-plugin',
        identity,
        localName: review.manifest.packageName ?? source.path,
        fit: review.fit,
        digest: hashObject({
          reviewId: review.id,
          sourceSnapshot: source,
          installSpec: review.installSpec,
          recommendation: review.recommendation,
        }),
      }
      snapshot.push(candidate)
      workflow.candidateSnapshot = snapshot
    }
  }
  if (!candidate) return
  if (candidate.evolutionTarget && review.manifest.packageName
    && candidate.evolutionTarget.packageName !== review.manifest.packageName) {
    throw new EvolutionError('invalid_input', 'Reviewed package name does not match the frozen installed package')
  }

  workflow.reviewIdsByCandidate = {
    ...(workflow.reviewIdsByCandidate ?? {}),
    [candidate.id]: review.id,
  }
  workflow.reviewedCandidateIds = [...new Set([...(workflow.reviewedCandidateIds ?? []), candidate.id])]
}

export function newWorkflowId(requirement: string): string {
  return `workflow_${hashObject({ requirement, at: new Date().toISOString(), nonce: randomUUID() }).slice(0, 24)}`
}

export function snapshotDigestFor(
  kind: InterruptPayload['kind'],
  resolution: WorkflowView['resolution'],
  reviews: ReviewRecord[],
  workflow: WorkflowRecord,
): string {
  if (kind === 'await_confirmation') {
    return hashObject({
      kind,
      reviews: reviews.map((review) => ({
        reviewId: review.id,
        reviewIdentity: review.sourceSnapshot.kind === 'github'
          ? review.sourceSnapshot.commit
          : review.sourceSnapshot.statusHash,
        installSpec: review.installSpec,
        inspectedFiles: review.inspectedFiles,
        manifest: review.manifest,
      })),
      candidateSnapshot: workflow.candidateSnapshot,
      reviewedCandidateIds: workflow.reviewedCandidateIds,
    })
  }
  if (kind === 'await_modify_work') {
    const review = reviews[0]
    if (review) {
      return hashObject({
        kind,
        reviewId: review.id,
        reviewIdentity: review.sourceSnapshot.kind === 'github'
          ? review.sourceSnapshot.commit
          : review.sourceSnapshot.statusHash,
        path: workflow.pendingPath,
      })
    }
    if (!workflow.pendingPath) throw new EvolutionError('invalid_input', 'Create-work interrupt requires a managed source path snapshot')
    return hashObject({ kind, path: workflow.pendingPath, resolutionId: resolution?.id })
  }
  if (!resolution) throw new EvolutionError('invalid_input', 'Selection interrupt requires a resolution snapshot')
  return hashObject({
    kind,
    intent: workflow.intent,
    candidateSnapshot: workflow.candidateSnapshot,
    remoteDiscoveryComplete: resolution.remoteDiscoveryComplete,
    remoteCandidateSource: resolution.remoteCandidateSource,
  })
}

export function isUnfinished(status: WorkflowRecord['status']): boolean {
  return status === 'interrupted' || status === 'running'
}

export const DISCOVERY_QUERIES_PER_TURN = 5

export function discoveryQueriesPerTurn(budget: NonNullable<WorkflowRecord['discoveryBudget']>): number {
  return budget.maxQueriesPerTurn ?? budget.maxRefinementQueries ?? DISCOVERY_QUERIES_PER_TURN
}

export function activeDiscoveryQueriesUsed(
  budget: NonNullable<WorkflowRecord['discoveryBudget']>,
): string[] {
  if (budget.activeTurnQueriesUsed) return budget.activeTurnQueriesUsed
  return budget.refinementQueriesUsed.slice(-discoveryQueriesPerTurn(budget))
}

export function discoveryBudget(
  activeTurnId?: string,
  activeTurnQueriesUsed: readonly string[] = [],
): NonNullable<WorkflowRecord['discoveryBudget']> {
  return {
    refinementRoundsUsed: 0,
    refinementQueriesUsed: [],
    explicitRepositories: [],
    ...(activeTurnId ? { activeTurnId } : {}),
    activeTurnQueriesUsed: [...activeTurnQueriesUsed].slice(0, DISCOVERY_QUERIES_PER_TURN),
    maxQueriesPerTurn: DISCOVERY_QUERIES_PER_TURN,
    maxCandidates: DISCOVERY_POOL_MAX,
  }
}
