import type { RuntimeConfig } from '../config.js'
import type { RemoteCandidateSource, RemotePluginCandidate } from '../contracts.js'
import { errorMessage } from '../errors.js'
import { searchGithubRepositories, validateGithubRepository } from '../github/index.js'
import type { CommandRunner } from '../process/runner.js'
import { capabilityQueries, marketplaceSearchQueries, normalizeDiscoveryQueries } from '../resolver/keywords.js'
import { matchConfidence } from '../resolver/local.js'

const REMOTE_OPERATION_ALIASES = [
  ['search', 'find', 'discover', 'browse', '搜索', '查找', '检索', '发现', '浏览'],
] as const

export interface RemoteDiscoveryResult {
  candidates: RemotePluginCandidate[]
  source?: RemoteCandidateSource
  complete: boolean
  queries: string[]
  reasons: string[]
}

function boundedText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return ''
  return value.normalize('NFKC').replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, maxLength)
}

export function annotateRemoteCandidate(
  requirement: string,
  candidate: RemotePluginCandidate,
  queryHints: readonly string[] = [],
): RemotePluginCandidate {
  const haystack = `${candidate.repository} ${candidate.name} ${candidate.packageName ?? ''} ${candidate.description} ${candidate.topics.join(' ')}`
    .toLowerCase()
  const matchedTerms = [...new Set([
    ...[requirement, ...queryHints].flatMap((text) => [
      ...marketplaceSearchQueries(text),
      ...capabilityQueries(text),
    ]),
  ])]
    .map((term) => term.trim())
    .filter((term) => term.length >= 2 && haystack.includes(term.toLowerCase()))
    .slice(0, 6)
  return {
    ...candidate,
    ...(matchedTerms.length > 0 ? { matchedTerms } : {}),
    matchReason: matchedTerms.length > 0
      ? `matched ${matchedTerms.join(', ')}`
      : 'Eligible GitHub topic result; semantic fit is for the Agent to judge',
  }
}

/**
 * Rank eligible summaries for reading order only. Semantic confidence is not
 * an eligibility boundary: every objectively valid result remains visible to
 * the Agent inside the bounded discovery window.
 */
function relevantRemoteCandidates(
  requirement: string,
  candidates: readonly RemotePluginCandidate[],
  queryHints: readonly string[] = [],
): RemotePluginCandidate[] {
  const relevanceInputs = [requirement, ...queryHints]
  return candidates
    .map((candidate) => ({
      candidate,
      confidence: Math.max(...relevanceInputs.flatMap((text) => [
        matchConfidence(
          text,
          `${candidate.repository} ${candidate.name} ${candidate.packageName ?? ''}`,
          `${candidate.description} ${candidate.topics.join(' ')}`,
        ),
        remoteOperationEvidence(
          text.normalize('NFKC').toLocaleLowerCase('en-US'),
          `${candidate.repository} ${candidate.name} ${candidate.packageName ?? ''} ${candidate.description} ${candidate.topics.join(' ')}`,
        ),
      ])),
    }))
    .sort((left, right) => right.confidence - left.confidence
      || (right.candidate.updatedAt ?? '').localeCompare(left.candidate.updatedAt ?? '')
      || right.candidate.stars - left.candidate.stars
      || left.candidate.repository.localeCompare(right.candidate.repository))
    .map(({ candidate }) => annotateRemoteCandidate(requirement, candidate, queryHints))
}

function remoteOperationEvidence(normalizedRequirement: string, candidateText: string): number {
  const normalizedCandidate = candidateText.normalize('NFKC').toLocaleLowerCase('en-US')
  const requested = REMOTE_OPERATION_ALIASES.filter((aliases) => aliases.some((alias) => normalizedRequirement.includes(alias)))
  if (requested.length === 0) return 0
  const matched = requested.filter((aliases) => aliases.some((alias) => normalizedCandidate.includes(alias))).length
  return matched === requested.length ? 0.42 : 0
}

export function githubSearchPhrases(requirement: string, extra?: readonly string[]): string[] {
  const planned = extra
    ? normalizeDiscoveryQueries(extra).slice(0, 5)
    : marketplaceSearchQueries(requirement)
  if (planned.length > 0) return planned
  const fallback = capabilityQueries(requirement)[0] ?? boundedText(requirement, 120)
  return fallback.length >= 2 ? [fallback] : []
}

/**
 * Host-owned GitHub discovery scoped to `topic:dsh-plugin`. Empty results mean
 * there is no reusable plugin. An unavailable `gh` search is incomplete and
 * must not grant create permission.
 */
export async function discoverRemoteCandidates(options: {
  runner: CommandRunner
  config: RuntimeConfig
  cwd: string
  requirement: string
  queries?: readonly string[]
  signal?: AbortSignal
}): Promise<RemoteDiscoveryResult> {
  const phrases = githubSearchPhrases(options.requirement, options.queries)
  const reasons: string[] = []
  if (phrases.length === 0) {
    reasons.push('No scoped GitHub search phrase could be derived from the requirement.')
    return { candidates: [], complete: true, queries: [], reasons }
  }

  const poolLimit = 20
  const merged = new Map<string, RemotePluginCandidate>()
  let succeeded = 0
  let failed = 0
  const queries: string[] = []
  for (const phrase of phrases) {
    try {
      const batch = await searchGithubRepositories({
        runner: options.runner,
        config: options.config,
        cwd: options.cwd,
        query: phrase,
        limit: poolLimit,
        ...(options.signal ? { signal: options.signal } : {}),
      })
      succeeded += 1
      queries.push(phrase)
      reasons.push(`GitHub topic search ${JSON.stringify(phrase)} returned ${batch.length} summaries.`)
      for (const candidate of batch) {
        const key = candidate.repository.toLowerCase()
        const prior = merged.get(key)
        const preferCandidate = !prior
          || candidate.stars > prior.stars
          || (candidate.updatedAt ?? '') > (prior.updatedAt ?? '')
        const metadata = preferCandidate ? candidate : prior
        merged.set(key, {
          ...metadata,
          matchedQueries: [...new Set([...(prior?.matchedQueries ?? []), phrase])],
        })
      }
    } catch (error) {
      failed += 1
      queries.push(phrase)
      reasons.push(`GitHub topic search ${JSON.stringify(phrase)} was unavailable: ${boundedText(errorMessage(error), 300)}`)
    }
  }

  if (succeeded === 0) {
    return { candidates: [], complete: false, queries, reasons }
  }

  const candidates = relevantRemoteCandidates(options.requirement, [...merged.values()], options.queries)
  if (candidates.length === 0) {
    reasons.push('Scoped GitHub topic search returned no valid reusable candidates.')
  }
  return {
    candidates,
    ...(candidates.length > 0 ? { source: 'github' as const } : {}),
    complete: failed === 0,
    queries,
    reasons,
  }
}

export const _testing = {
  annotateRemoteCandidate,
  boundedText,
  githubSearchPhrases,
  remoteOperationEvidence,
  relevantRemoteCandidates,
  validateGithubRepository,
}
