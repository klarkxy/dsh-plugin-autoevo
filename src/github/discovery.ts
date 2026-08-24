import type { RuntimeConfig } from '../config.js'
import type { RemotePluginCandidate } from '../contracts.js'
import { EvolutionError } from '../errors.js'
import type { CommandRunner } from '../process/runner.js'
import { sha256 } from '../state/hashes.js'

export const DSH_PLUGIN_TOPIC = 'dsh-plugin'
export const DSH_PLUGIN_TOPIC_QUALIFIER = `topic:${DSH_PLUGIN_TOPIC}`

interface GithubSearchItem {
  full_name?: unknown
  name?: unknown
  description?: unknown
  stargazers_count?: unknown
  updated_at?: unknown
  topics?: unknown
  archived?: unknown
  fork?: unknown
  default_branch?: unknown
  disabled?: unknown
}

interface GithubSearchResponse {
  items?: unknown
}

const REPOSITORY = /^(?<owner>[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}))\/(?<name>[A-Za-z0-9_.-]+)$/

/** Reject URLs, path traversal, and ambiguous GitHub repository identifiers. */
export function validateGithubRepository(value: string): string {
  const match = REPOSITORY.exec(value.trim())
  if (!match || value.includes('..') || value.includes('\\')) {
    throw new EvolutionError('invalid_input', 'Repository must be a strict owner/repository identifier', { repository: value })
  }
  return `${match.groups?.owner}/${match.groups?.name}`
}

/** Force every GitHub search onto the DSH plugin topic. Never emit an unscoped query. */
export function scopedGithubQuery(query: string): string {
  const cleaned = query.replace(/\btopic:dsh-plugin\b/giu, ' ').replace(/\s+/gu, ' ').trim()
  return cleaned ? `${cleaned} ${DSH_PLUGIN_TOPIC_QUALIFIER}` : DSH_PLUGIN_TOPIC_QUALIFIER
}

/** Strip ANSI SGR sequences that gh may emit when color.ui is forced on. */
function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, '')
}

function asSearchResponse(stdout: string): GithubSearchResponse {
  const cleaned = stripAnsi(stdout).trim()
  try {
    const value: unknown = JSON.parse(cleaned)
    if (!value || typeof value !== 'object') throw new Error('not an object')
    return value as GithubSearchResponse
  } catch (cause) {
    const stdoutBytes = Buffer.byteLength(cleaned)
    const stdoutSha256 = sha256(cleaned)
    throw new EvolutionError(
      'github_unavailable',
      `GitHub returned malformed repository search data (${stdoutBytes} bytes, sha256 ${stdoutSha256})`,
      {
        cause: cause instanceof Error ? cause.message : String(cause),
        parseCategory: 'invalid_json',
        stdoutBytes,
        stdoutSha256,
      },
    )
  }
}

function asCandidate(item: GithubSearchItem): RemotePluginCandidate | null {
  if (item.archived === true || item.fork === true || item.disabled === true || typeof item.full_name !== 'string') return null
  let repository: string
  try {
    repository = validateGithubRepository(item.full_name)
  } catch {
    return null
  }
  if (typeof item.name !== 'string') return null
  const stars = typeof item.stargazers_count === 'number' && Number.isFinite(item.stargazers_count)
    ? Math.max(0, Math.floor(item.stargazers_count))
    : 0
  const topics = Array.isArray(item.topics)
    ? item.topics.filter((topic): topic is string => typeof topic === 'string' && topic.length > 0)
    : []
  if (!topics.some((topic) => topic.toLowerCase() === DSH_PLUGIN_TOPIC)) topics.unshift(DSH_PLUGIN_TOPIC)
  return {
    repository,
    name: item.name,
    description: typeof item.description === 'string' ? item.description : '',
    stars,
    updatedAt: typeof item.updated_at === 'string' ? item.updated_at : null,
    topics,
    ...(typeof item.default_branch === 'string' ? { defaultBranch: item.default_branch } : {}),
  }
}

function compareCandidates(left: RemotePluginCandidate, right: RemotePluginCandidate): number {
  return right.stars - left.stars
    || (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '')
    || left.repository.localeCompare(right.repository)
}

/**
 * Search GitHub with argv-only `gh api` calls. Every query is forced onto
 * `topic:dsh-plugin`. Results are normalized and deduplicated.
 */
export async function searchGithubRepositories(options: {
  runner: CommandRunner
  config: RuntimeConfig
  cwd: string
  query: string
  limit: number
  signal?: AbortSignal
}): Promise<RemotePluginCandidate[]> {
  const query = scopedGithubQuery(options.query)
  const perPage = Math.min(20, Math.max(1, options.limit))
  const result = await options.runner.run({
    argv: [
      options.config.ghCommand,
      'api',
      '--method',
      'GET',
      '/search/repositories',
      '-f',
      `q=${query}`,
      '-f',
      'sort=updated',
      '-f',
      'order=desc',
      '-f',
      `per_page=${perPage}`,
    ],
    cwd: options.cwd,
    ...(options.signal ? { signal: options.signal } : {}),
  })
  const payload = asSearchResponse(result.stdout)
  if (!Array.isArray(payload.items)) return []
  const merged = new Map<string, RemotePluginCandidate>()
  for (const raw of payload.items) {
    if (!raw || typeof raw !== 'object') continue
    const candidate = asCandidate(raw as GithubSearchItem)
    if (!candidate) continue
    const key = candidate.repository.toLowerCase()
    const prior = merged.get(key)
    if (!prior || compareCandidates(candidate, prior) < 0) merged.set(key, candidate)
  }
  return [...merged.values()].sort(compareCandidates)
}

export const _testing = {
  asCandidate,
  asSearchResponse,
  scopedGithubQuery,
}
