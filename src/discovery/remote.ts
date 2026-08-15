import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { RuntimeConfig } from '../config.js'
import type { RemoteCandidateSource, RemotePluginCandidate } from '../contracts.js'
import { errorMessage } from '../errors.js'
import { discoverGithubCandidates, validateGithubRepository } from '../github/index.js'
import type { CommandRunner } from '../process/runner.js'
import { capabilityQueries } from '../resolver/keywords.js'

export const FIND_PLUGIN_TOOL = 'find_dsh_plugin'

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

export function findPluginQuery(requirement: string): string {
  const terms = capabilityQueries(requirement)
  // GitHub search combines whitespace-separated terms, so feeding every
  // expansion over-constrains discovery. Let the dedicated finder rank the
  // broadest primary capability and leave exact fit to AutoEvo review.
  return (terms[0] ?? requirement).slice(0, 256)
}

export function githubQueries(requirement: string): string[] {
  const capabilities = capabilityQueries(requirement)
  if (capabilities.length === 0) return []
  return [
    `${capabilities[0]} topic:dsh-plugin`,
    ...capabilities.slice(0, 4).map((query) => `${query} dsh`),
  ]
}

async function discoverWithFindPlugin(options: {
  ctx: Context
  config: RuntimeConfig
  requirement: string
  exec: ToolRunContext
}): Promise<RemotePluginCandidate[]> {
  const query = findPluginQuery(options.requirement)
  const result = await options.ctx.tools.execute({
    callId: `${options.exec.callId}:autoevo-find:${randomUUID()}` as typeof options.exec.callId,
    rootCallId: options.exec.rootCallId,
    name: FIND_PLUGIN_TOOL,
    arguments: {
      query,
      limit: options.config.maxCandidates,
      lang: /[\p{Script=Han}]/u.test(options.requirement) ? 'zh' : 'en',
    },
    ...(options.exec.agent ? { agent: options.exec.agent } : {}),
    parent: options.exec.token,
    signal: options.exec.signal,
  })
  if (result.isError) throw new Error(result.error.message)
  return normalizeFindPluginCandidates(result.value, options.config.maxCandidates)
}

/**
 * Prefer the ecosystem's dedicated discovery tool when it is visible in the
 * current Agent registry scope. Empty, malformed, denied, timed-out, or failed
 * results fall back to AutoEvo's authenticated argv-only gh search.
 */
export async function discoverRemoteCandidates(options: {
  ctx: Context
  config: RuntimeConfig
  runner: CommandRunner
  cwd: string
  requirement: string
  exec: ToolRunContext
}): Promise<RemoteDiscoveryResult> {
  const queries: string[] = []
  const reasons: string[] = []
  const finder = options.ctx.tools.get(FIND_PLUGIN_TOOL, options.exec.agent)
  if (finder) {
    queries.push(findPluginQuery(options.requirement))
    try {
      const candidates = await discoverWithFindPlugin(options)
      if (candidates.length > 0) {
        reasons.push(`find_dsh_plugin returned ${candidates.length} bounded candidate summaries; built-in gh search was skipped.`)
        return { candidates, source: 'dsh-find-plugin', queries, reasons }
      }
      reasons.push('find_dsh_plugin returned no valid reusable candidates; falling back to built-in gh search.')
    } catch (error) {
      reasons.push(`find_dsh_plugin was unavailable: ${boundedText(errorMessage(error), 300)}; falling back to built-in gh search.`)
    }
  } else {
    reasons.push('find_dsh_plugin is not available in the current Agent scope; falling back to built-in gh search.')
  }

  const fallbackQueries = githubQueries(options.requirement)
  queries.push(...fallbackQueries)
  try {
    const candidates = await discoverGithubCandidates({
      runner: options.runner,
      config: options.config,
      cwd: options.cwd,
      queries: fallbackQueries,
      signal: options.exec.signal,
    })
    reasons.push(candidates.length > 0
      ? `Built-in gh discovery returned ${candidates.length} bounded candidate summaries.`
      : 'Built-in gh discovery returned no reusable DSH plugin candidates.')
    return {
      candidates,
      ...(candidates.length > 0 ? { source: 'github' as const } : {}),
      queries,
      reasons,
    }
  } catch (error) {
    reasons.push(`Built-in gh discovery was unavailable: ${boundedText(errorMessage(error), 300)}`)
    return { candidates: [], queries, reasons }
  }
}

export const _testing = { boundedText, normalizeFindPluginCandidates, repositoryFromUrl }
