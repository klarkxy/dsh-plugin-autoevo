import type { RuntimeConfig } from '../config.js'
import { EvolutionError } from '../errors.js'
import { commandResultFailure, type CommandResult, type CommandRunner } from '../process/runner.js'
import { validateGithubRepository } from './discovery.js'

export interface UpstreamState {
  repository: string
  defaultBranch: string
  latestCommit: { sha: string; date: string | null }
  latestRelease: { tag: string; publishedAt: string | null } | null
}

function asObject(stdout: string): Record<string, unknown> {
  const value: unknown = JSON.parse(stdout.trim())
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new EvolutionError('github_unavailable', 'GitHub returned malformed repository data')
  }
  return value as Record<string, unknown>
}

function isExplicitHttp404(result: CommandResult): boolean {
  if (/\bHTTP(?:\/[\d.]+)?\s+404\b/iu.test(`${result.stdout}\n${result.stderr}`)) return true
  for (const body of [result.stdout, result.stderr]) {
    try {
      const payload: unknown = JSON.parse(body.trim())
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue
      const status = (payload as Record<string, unknown>).status
      if (status === 404 || status === '404') return true
    } catch {
      // Only an explicit structured status or HTTP status line is accepted.
    }
  }
  return false
}

function latestReleaseObject(stdout: string): Record<string, unknown> {
  if (!stdout.trim()) {
    throw new EvolutionError('github_unavailable', 'GitHub returned empty latest release data')
  }
  try {
    return asObject(stdout)
  } catch {
    throw new EvolutionError('github_unavailable', 'GitHub returned malformed latest release data')
  }
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
  const repoPayload = asObject((await run(`/repos/${repository}`)).stdout)
  const defaultBranch = typeof repoPayload.default_branch === 'string' && repoPayload.default_branch
    ? repoPayload.default_branch
    : 'HEAD'
  const commitsPayload: unknown = JSON.parse((await run(`/repos/${repository}/commits`, {
    sha: defaultBranch,
    per_page: '1',
  })).stdout.trim())
  const latest = Array.isArray(commitsPayload) ? commitsPayload[0] as Record<string, unknown> | undefined : undefined
  const sha = typeof latest?.sha === 'string' ? latest.sha : undefined
  if (!sha) {
    throw new EvolutionError('github_unavailable', 'GitHub returned no head commit for the default branch', { repository })
  }
  const committer = latest?.commit && typeof latest.commit === 'object'
    ? (latest.commit as Record<string, unknown>).committer
    : undefined
  const date = committer && typeof committer === 'object'
    ? (committer as Record<string, unknown>).date
    : undefined
  const releaseResult = await run(`/repos/${repository}/releases/latest`, {}, true)
  let latestRelease: UpstreamState['latestRelease'] = null
  if (releaseResult.exitCode !== 0) {
    if (!isExplicitHttp404(releaseResult)) throw commandResultFailure(options.config.ghCommand, releaseResult)
  } else {
    const releasePayload = latestReleaseObject(releaseResult.stdout)
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
