import { randomUUID } from 'node:crypto'
import type {
  DecisionReceipt,
  RemotePluginCandidate,
  ResolutionAuthorization,
  ResolutionRecord,
  ReviewRecord,
} from './contracts.js'
import { POLICY_VERSION } from './contracts.js'
import { EvolutionError } from './errors.js'
import { validateGithubRepository } from './github/index.js'
import { prefersChinese } from './i18n.js'
import {
  authorizationFromDecision,
  nextStepForAuthorization,
  reviewIdentity,
} from './lifecycle/decide.js'
import { isDirectlyUsableReview } from './review/index.js'
import { hashObject } from './state/hashes.js'
import type { WorkflowRecord } from './workflow/contracts.js'

export function addExplicitCandidate(
  resolution: ResolutionRecord,
  repositoryInput: string,
): { resolution: ResolutionRecord, candidate: RemotePluginCandidate } {
  const repository = validateGithubRepository(repositoryInput)
  const existing = resolution.remoteCandidates.find((item) => item.repository.toLowerCase() === repository.toLowerCase())
  if (existing) return { resolution, candidate: existing }

  const candidate: RemotePluginCandidate = {
    repository,
    name: repository.split('/')[1]!,
    description: '',
    stars: 0,
    updatedAt: null,
    topics: ['dsh-plugin'],
    explicit: true,
  }
  return {
    candidate,
    resolution: {
      ...resolution,
      remoteCandidates: [...resolution.remoteCandidates, candidate],
    },
  }
}

/**
 * Keep exact repositories first, then the current search page union, then old
 * summaries. Updating an existing key never changes its priority position.
 */
export function mergeRemoteCandidatePool(
  existing: readonly RemotePluginCandidate[],
  discovered: readonly RemotePluginCandidate[],
  explicitRepositories: readonly string[],
  limit: number,
): RemotePluginCandidate[] {
  const existingByKey = new Map(existing.map((candidate) => [candidate.repository.toLowerCase(), candidate] as const))
  const discoveredByKey = new Map(discovered.map((candidate) => [candidate.repository.toLowerCase(), candidate] as const))
  const explicitOrder = [...new Map([
    ...explicitRepositories.map((repository) => {
      const normalized = validateGithubRepository(repository)
      return [normalized.toLowerCase(), normalized] as const
    }),
    ...existing.filter((candidate) => candidate.explicit)
      .map((candidate) => [candidate.repository.toLowerCase(), candidate.repository] as const),
    ...discovered.filter((candidate) => candidate.explicit)
      .map((candidate) => [candidate.repository.toLowerCase(), candidate.repository] as const),
  ]).values()]
  const explicitKeys = new Set(explicitOrder.map((repository) => repository.toLowerCase()))
  const merged = new Map<string, RemotePluginCandidate>()
  const put = (candidate: RemotePluginCandidate, preferIncoming: boolean): void => {
    const key = candidate.repository.toLowerCase()
    const prior = merged.get(key)
    const combined = prior
      ? preferIncoming ? { ...prior, ...candidate } : { ...candidate, ...prior }
      : { ...candidate }
    merged.set(key, {
      ...combined,
      ...(explicitKeys.has(key) || prior?.explicit || candidate.explicit ? { explicit: true } : {}),
      ...((prior?.matchedQueries?.length || candidate.matchedQueries?.length) ? {
        matchedQueries: [...new Set([...(prior?.matchedQueries ?? []), ...(candidate.matchedQueries ?? [])])],
      } : {}),
      ...((prior?.matchedTerms?.length || candidate.matchedTerms?.length) ? {
        matchedTerms: [...new Set([...(prior?.matchedTerms ?? []), ...(candidate.matchedTerms ?? [])])].slice(0, 6),
      } : {}),
    })
  }

  for (const repository of explicitOrder) {
    const normalized = validateGithubRepository(repository)
    const key = normalized.toLowerCase()
    put(discoveredByKey.get(key) ?? existingByKey.get(key) ?? {
      repository: normalized,
      name: normalized.split('/')[1]!,
      description: '',
      stars: 0,
      updatedAt: null,
      topics: ['dsh-plugin'],
      explicit: true,
    }, true)
  }
  for (const candidate of discovered) put(candidate, true)
  for (const candidate of existing) put(candidate, false)
  return [...merged.values()].slice(0, Math.max(0, limit))
}

export function newResolutionId(requirement: string): string {
  return `resolution_${hashObject({ requirement, at: new Date().toISOString(), nonce: randomUUID() }).slice(0, 24)}`
}

export function assertRequirement(requirement: string): string {
  const value = requirement.normalize('NFKC').trim()
  if (!value) {
    throw new EvolutionError('invalid_input', 'requirement must not be empty')
  }
  return value
}

export function waitingAuthorization(
  resolutionId: string,
  decision: ResolutionRecord['decision'],
  remoteDiscoveryComplete: boolean,
  _remoteCandidateSource?: ResolutionRecord['remoteCandidateSource'],
): ResolutionAuthorization {
  if (!remoteDiscoveryComplete && decision !== 'use_local') {
    return {
      state: 'selection_required',
      resolutionId,
      reason: 'Remote discovery did not finish. Retry capability_workflow; nothing will be created until the user chooses.',
    }
  }
  return {
    state: 'selection_required',
    resolutionId,
    reason: 'Waiting for the user to choose a candidate, create new, or stop.',
  }
}

function latestDecision(resolution: ResolutionRecord): DecisionReceipt | undefined {
  const decisions = resolution.decisions ?? []
  return decisions[decisions.length - 1]
}

export function authorizationForResolution(
  resolution: ResolutionRecord,
  reviews: readonly ReviewRecord[] = [],
): ResolutionAuthorization {
  const legacy = resolution.schemaVersion !== 2 || resolution.policyVersion !== POLICY_VERSION || !resolution.authorization
  if (legacy) {
    return {
      state: 'selection_required',
      resolutionId: resolution.id,
      reason: 'This resolution predates the current user-choice policy; run capability_workflow again.',
    }
  }

  const decision = latestDecision(resolution)
  if (decision?.phase === 'gate2') {
    const review = decision.reviewId
      ? reviews.find((item) => item.id === decision.reviewId)
      : undefined
    return authorizationFromDecision(
      resolution.id,
      decision.action,
      decision.selectedRepositories,
      review,
    )
  }

  if (resolution.remoteCandidateSource === 'marketplace-setup' && resolution.decision === 'inspect_remote') {
    return resolution.authorization?.state === 'market_required'
      ? resolution.authorization
      : waitingAuthorization(resolution.id, resolution.decision, Boolean(resolution.remoteDiscoveryComplete), resolution.remoteCandidateSource)
  }

  const selected = resolution.selectedRepositories ?? []
  if (selected.length > 0) {
    const reviewed = selected.some((repository) => reviews.some((review) => review.sourceSnapshot.kind === 'github'
      && review.sourceSnapshot.repository.toLowerCase() === repository.toLowerCase()))
    return {
      state: reviewed ? 'confirmation_required' : 'selection_required',
      resolutionId: resolution.id,
      reason: reviewed
        ? 'A selected plugin was reviewed. The user must choose use this, create new, or stop.'
        : 'Review only the repositories the user selected.',
      selectedRepositories: selected,
    }
  }

  return resolution.authorization ?? waitingAuthorization(
    resolution.id,
    resolution.decision,
    Boolean(resolution.remoteDiscoveryComplete),
    resolution.remoteCandidateSource,
  )
}

export function withNextStep(record: ResolutionRecord): ResolutionRecord {
  const authorization = record.authorization
  if (!authorization) return record
  return { ...record, nextStep: nextStepForAuthorization(record.requirement, authorization) }
}

export function waitingConfirmation(
  resolution: ResolutionRecord,
  review: ReviewRecord,
  workflow?: WorkflowRecord,
): ResolutionRecord {
  const chinese = prefersChinese(resolution.requirement)
  const usable = isDirectlyUsableReview(review, workflow)
  const authorization: ResolutionAuthorization = {
    state: 'confirmation_required',
    resolutionId: resolution.id,
    reason: chinese
      ? usable
        ? '审查已完成。简要比较候选并等待用户明确选择安装、修改、新建或先停。'
        : '审查已完成，但当前候选不能直接安装。简要说明阻断项，并等待用户选择修改、继续比较、新建或先停。'
      : usable
        ? 'Review finished. Compare the candidates briefly, then wait for an explicit install, modify, create, or stop decision.'
        : 'Review finished, but the current candidate is not directly installable. Explain the blockers briefly, then wait for modify, compare, create, or stop.',
    selectedRepositories: resolution.selectedRepositories ?? [],
    reviewId: review.id,
    reviewIdentity: reviewIdentity(review),
  }
  return {
    ...resolution,
    authorization,
    reasons: [...resolution.reasons, authorization.reason],
  }
}
