import type { RuntimeConfig } from '../config.js'
import { EvolutionError } from '../errors.js'
import { isRecord } from '../internal-utils.js'
import { commandResultFailure, type CommandResult, type CommandRunner } from '../process/runner.js'
import { validateGithubRepository } from './discovery.js'

export interface UpstreamState {
  repository: string
  defaultBranch: string
  latestCommit: { sha: string; date: string | null }
  latestRelease: { tag: string; publishedAt: string | null } | null
}

/** Every gh payload parse failure is one boundary failure: `github_unavailable`. */
function githubJson(stdout: string, description: string): unknown {
  const body = stdout.trim()
  if (!body) throw new EvolutionError('github_unavailable', `GitHub returned empty ${description}`)
  try {
    return JSON.parse(body)
  } catch {
    throw new EvolutionError('github_unavailable', `GitHub returned malformed ${description}`)
  }
}

function githubObject(stdout: string, description: string): Record<string, unknown> {
  const value = githubJson(stdout, description)
  if (!isRecord(value)) throw new EvolutionError('github_unavailable', `GitHub returned malformed ${description}`)
  return value
}

function isExplicitHttp404(result: CommandResult): boolean {
  if (/\bHTTP(?:\/[\d.]+)?\s+404\b/iu.test(`${result.stdout}\n${result.stderr}`)) return true
  for (const body of [result.stdout, result.stderr]) {
    try {
      const payload: unknown = JSON.parse(body.trim())
      if (!isRecord(payload)) continue
      if (payload.status === 404 || payload.status === '404') return true
    } catch {
      // Only an explicit structured status or HTTP status line is accepted.
    }
  }
  return false
}

/**
 * Read the upstream head and latest release for one repository through
 * argv-only `gh api` calls. A missing release (404) is tolerated as null.
 */
export async function fetchUpstreamState(options: {
  runner: CommandRunner
  config: RuntimeConfig
  cwd: string
  repository: string
  signal?: AbortSignal
}): Promise<UpstreamState> {
  const repository = validateGithubRepository(options.repository)
  const run = (endpoint: string, fields: Record<string, string> = {}, allowFailure = false) => options.runner.run({
    argv: [
      options.config.ghCommand,
      'api',
      '--method',
      'GET',
      endpoint,
      ...Object.entries(fields).flatMap(([key, value]) => ['-f', `${key}=${value}`]),
    ],
    cwd: options.cwd,
    allowFailure,
    ...(options.signal ? { signal: options.signal } : {}),
  })
  const repoPayload = githubObject((await run(`/repos/${repository}`)).stdout, 'repository data')
  const defaultBranch = typeof repoPayload.default_branch === 'string' && repoPayload.default_branch
    ? repoPayload.default_branch
    : 'HEAD'
  const commitsPayload = githubJson((await run(`/repos/${repository}/commits`, {
    sha: defaultBranch,
    per_page: '1',
  })).stdout, 'commit data')
  const latest = Array.isArray(commitsPayload) && isRecord(commitsPayload[0]) ? commitsPayload[0] : undefined
  const sha = typeof latest?.sha === 'string' ? latest.sha : undefined
  if (!latest || !sha) {
    throw new EvolutionError('github_unavailable', 'GitHub returned no head commit for the default branch', { repository })
  }
  const committer = isRecord(latest.commit) ? latest.commit.committer : undefined
  const date = isRecord(committer) ? committer.date : undefined
  const releaseResult = await run(`/repos/${repository}/releases/latest`, {}, true)
  let latestRelease: UpstreamState['latestRelease'] = null
  if (releaseResult.exitCode !== 0) {
    if (!isExplicitHttp404(releaseResult)) throw commandResultFailure(options.config.ghCommand, releaseResult)
  } else {
    const releasePayload = githubObject(releaseResult.stdout, 'latest release data')
    if (typeof releasePayload.tag_name !== 'string' || !releasePayload.tag_name.trim()) {
      throw new EvolutionError('github_unavailable', 'GitHub latest release data is missing a valid tag_name')
    }
    latestRelease = {
      tag: releasePayload.tag_name.trim(),
      publishedAt: typeof releasePayload.published_at === 'string' ? releasePayload.published_at : null,
    }
  }
  return {
    repository,
    defaultBranch,
    latestCommit: { sha, date: typeof date === 'string' ? date : null },
    latestRelease,
  }
}
