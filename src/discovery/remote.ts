import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { RuntimeConfig } from '../config.js'
import type { RemoteCandidateSource, RemotePluginCandidate } from '../contracts.js'
import { errorMessage } from '../errors.js'
import { validateGithubRepository } from '../github/index.js'
import { capabilityQueries, marketplaceSearchQueries } from '../resolver/keywords.js'
import { matchConfidence } from '../resolver/local.js'

export const FIND_PLUGIN_TOOL = 'find_dsh_plugin'
export const FIND_PLUGIN_REPOSITORY = 'awesome-dsh-plugin/dsh-find-plugin'



interface FindPluginItem {
  name?: unknown
  url?: unknown
  description?: unknown
  stars?: unknown
}

interface FindPluginValue {
  results?: unknown
}

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

function repositoryFromUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.username || url.password || url.search || url.hash) return null
    const segments = url.pathname.split('/').filter(Boolean)
    if (segments.length !== 2) return null
    return validateGithubRepository(`${segments[0]}/${segments[1]}`)
  } catch {
    return null
  }
}

function normalizeFindPluginCandidates(value: unknown, limit: number): RemotePluginCandidate[] {
  if (!value || typeof value !== 'object') return []
  const results = (value as FindPluginValue).results
  if (!Array.isArray(results)) return []
  const candidates = new Map<string, RemotePluginCandidate>()
  for (const raw of results) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as FindPluginItem
    const repository = repositoryFromUrl(item.url)
    if (!repository) continue
    const stars = typeof item.stars === 'number' && Number.isFinite(item.stars)
      ? Math.max(0, Math.floor(item.stars))
      : 0
    const candidate: RemotePluginCandidate = {
      repository,
      name: boundedText(item.name, 120) || repository.split('/')[1]!,
      description: boundedText(item.description, 500),
      stars,
      // find_dsh_plugin 0.3.x does not expose pushed/updated metadata.
      updatedAt: null,
      topics: ['dsh-plugin'],
    }
    const prior = candidates.get(repository.toLowerCase())
    if (!prior || candidate.stars > prior.stars) candidates.set(repository.toLowerCase(), candidate)
  }
  return [...candidates.values()]
    .sort((left, right) => right.stars - left.stars || left.repository.localeCompare(right.repository))
    .slice(0, limit)
}

export function annotateRemoteCandidate(
  requirement: string,
  candidate: RemotePluginCandidate,
): RemotePluginCandidate {
  const haystack = `${candidate.repository} ${candidate.name} ${candidate.packageName ?? ''} ${candidate.description} ${candidate.topics.join(' ')}`
    .toLowerCase()
  const matchedTerms = [...new Set([
    ...marketplaceSearchQueries(requirement),
    ...capabilityQueries(requirement),
  ])]
    .map((term) => term.trim())
    .filter((term) => term.length >= 2 && haystack.includes(term.toLowerCase()))
    .slice(0, 6)
  return {
    ...candidate,
    ...(matchedTerms.length > 0 ? { matchedTerms } : {}),
    matchReason: matchedTerms.length > 0
      ? `matched ${matchedTerms.join(', ')}`
      : 'marketplace summary matched the request',
  }
}

function relevantRemoteCandidates(
  requirement: string,
  candidates: readonly RemotePluginCandidate[],
): RemotePluginCandidate[] {
  return candidates
    .filter((candidate) => matchConfidence(
      requirement,
      `${candidate.repository} ${candidate.name} ${candidate.packageName ?? ''}`,
      `${candidate.description} ${candidate.topics.join(' ')}`,
    ) >= 0.3)
    .map((candidate) => annotateRemoteCandidate(requirement, candidate))
}

export function findPluginQuery(requirement: string): string {
  return (marketplaceSearchQueries(requirement)[0] ?? capabilityQueries(requirement)[0] ?? requirement).slice(0, 256)
}

async function discoverWithFindPlugin(options: {
  ctx: Context
  config: RuntimeConfig
  requirement: string
  query: string
  exec: ToolRunContext
}): Promise<RemotePluginCandidate[]> {
  const poolLimit = options.config.maxCandidates
  const result = await options.ctx.tools.execute({
    callId: `${options.exec.callId}:autoevo-find:${randomUUID()}` as typeof options.exec.callId,
    rootCallId: options.exec.rootCallId,
    name: FIND_PLUGIN_TOOL,
    arguments: {
      query: options.query,
      limit: poolLimit,
      lang: /[\p{Script=Han}]/u.test(options.requirement) ? 'zh' : 'en',
    },
    ...(options.exec.agent ? { agent: options.exec.agent } : {}),
    parent: options.exec.token,
    signal: options.exec.signal,
  })
  if (result.isError) throw new Error(result.error.message)
  return normalizeFindPluginCandidates(result.value, poolLimit)
}

/**
 * Prefer the ecosystem marketplace tool when it is visible in the current
 * Agent registry scope. If that tool is missing, offer to install it instead
 * of searching GitHub directly. An installed finder that returns nothing is
 * treated as "no reusable candidate", not a reason to run raw gh search.
 */
export async function discoverRemoteCandidates(options: {
  ctx: Context
  config: RuntimeConfig
  requirement: string
  exec: ToolRunContext
}): Promise<RemoteDiscoveryResult> {
  const queries: string[] = []
  const reasons: string[] = []
  const finder = options.ctx.tools.get(FIND_PLUGIN_TOOL, options.exec.agent)
  if (finder) {
    const planned = marketplaceSearchQueries(options.requirement)
    queries.push(...(planned.length > 0 ? planned : [findPluginQuery(options.requirement)]))
    const merged = new Map<string, RemotePluginCandidate>()
    let succeeded = 0
    let failed = 0
    for (const query of queries) {
      try {
        const batch = await discoverWithFindPlugin({ ...options, query })
        succeeded += 1
        reasons.push(`find_dsh_plugin query ${JSON.stringify(query)} returned ${batch.length} summaries.`)
        for (const candidate of batch) {
          const key = candidate.repository.toLowerCase()
          const prior = merged.get(key)
          if (!prior || candidate.stars > prior.stars) merged.set(key, candidate)
        }
      } catch (error) {
        failed += 1
        reasons.push(`find_dsh_plugin query ${JSON.stringify(query)} was unavailable: ${boundedText(errorMessage(error), 300)}`)
      }
    }
    if (succeeded === 0) {
      return { candidates: [], complete: false, queries, reasons }
    }
    const candidates = relevantRemoteCandidates(options.requirement, [...merged.values()])
      .sort((left, right) => right.stars - left.stars || left.repository.localeCompare(right.repository))
      .slice(0, options.config.maxCandidates)
    if (candidates.length === 0) {
      reasons.push('find_dsh_plugin returned no valid reusable candidates; GitHub fallback was not used.')
    }
    const source = candidates.length > 0 ? 'dsh-find-plugin' as const : undefined
    return {
      candidates,
      ...(source ? { source } : {}),
      complete: failed === 0,
      queries,
      reasons,
    }
  }

  reasons.push('find_dsh_plugin is not installed in the current Agent scope. AutoEvo will install the DSH plugin marketplace with a one-time approval instead of searching GitHub.')
  return {
    candidates: [],
    source: 'marketplace-setup',
    complete: true,
    queries,
    reasons,
  }
}

export const _testing = {
  annotateRemoteCandidate,
  boundedText,
  normalizeFindPluginCandidates,
  relevantFinderCandidates: relevantRemoteCandidates,
  relevantRemoteCandidates,
  repositoryFromUrl,
}
