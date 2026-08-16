import type { RuntimeConfig } from '../config.js'
import type { RemotePluginCandidate } from '../contracts.js'
import { EvolutionError } from '../errors.js'
import type { CommandRunner } from '../process/runner.js'

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
    const preview = cleaned.replace(/\s+/gu, ' ').slice(0, 240) || '<empty>'
    throw new EvolutionError(
      'github_unavailable',
      `GitHub returned malformed repository search data (${Buffer.byteLength(cleaned)} bytes): ${preview}`,
      {
        cause: cause instanceof Error ? cause.message : String(cause),
        stdoutPreview: preview,
        stdoutBytes: Buffer.byteLength(cleaned),
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
  if (typeof item.name !== 'string' || typeof item.updated_at !== 'string') return null
  const stars = typeof item.stargazers_count === 'number' && Number.isFinite(item.stargazers_count)
    ? Math.max(0, item.stargazers_count)
    : 0
  return {
    repository,
    name: item.name,
    description: typeof item.description === 'string' ? item.description : '',
    stars,
    updatedAt: item.updated_at,
    topics: Array.isArray(item.topics) ? item.topics.filter((topic): topic is string => typeof topic === 'string') : [],
    ...(typeof item.default_branch === 'string' ? { defaultBranch: item.default_branch } : {}),
  }
}

function compareCandidates(left: RemotePluginCandidate, right: RemotePluginCandidate): number {
  return right.stars - left.stars
    || (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '')
    || left.repository.localeCompare(right.repository)
}

function relevance(candidate: RemotePluginCandidate, queries: readonly string[]): number {
  const haystack = `${candidate.name} ${candidate.description} ${candidate.topics.join(' ')}`.toLowerCase()
  return queries.reduce((score, query) => score + query.toLowerCase().split(/\s+/).filter(Boolean)
    .reduce((queryScore, token) => queryScore + (haystack.includes(token) ? 1 : 0), 0), 0)
}

/**
 * Searches GitHub using argv-only `gh api` calls. Every returned repository is
 * normalized, deduplicated across queries, and sorted deterministically.
 */
export async function discoverGithubCandidates(options: {
  runner: CommandRunner
  config: RuntimeConfig
  cwd: string
  queries: readonly string[]
  signal?: AbortSignal
}): Promise<RemotePluginCandidate[]> {
  const queries = [...new Set(options.queries.map((query) => query.trim()).filter(Boolean))]
  const merged = new Map<string, RemotePluginCandidate>()
  for (const query of queries) {
    const result = await options.runner.run({
      argv: [options.config.ghCommand, 'api', '--method', 'GET', '/search/repositories', '-f', `q=${query}`, '-f', 'sort=stars', '-f', 'order=desc', '-f', `per_page=${options.config.maxCandidates}`],
      cwd: options.cwd,
      ...(options.signal ? { signal: options.signal } : {}),
    })
    const payload = asSearchResponse(result.stdout)
    if (!Array.isArray(payload.items)) continue
    for (const raw of payload.items) {
      if (!raw || typeof raw !== 'object') continue
      const candidate = asCandidate(raw as GithubSearchItem)
      if (!candidate) continue
      const prior = merged.get(candidate.repository)
      if (!prior || compareCandidates(candidate, prior) < 0) merged.set(candidate.repository, candidate)
    }
  }
  return [...merged.values()].sort((left, right) => relevance(right, queries) - relevance(left, queries)
    || compareCandidates(left, right)).slice(0, options.config.maxCandidates)
}
