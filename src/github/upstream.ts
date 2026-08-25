import type { RuntimeConfig } from '../config.js'
import { EvolutionError } from '../errors.js'
import type { CommandRunner } from '../process/runner.js'
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
  if (releaseResult.exitCode === 0 && releaseResult.stdout.trim()) {
    const releasePayload = asObject(releaseResult.stdout)
    if (typeof releasePayload.tag_name === 'string' && releasePayload.tag_name) {
      latestRelease = {
        tag: releasePayload.tag_name,
        publishedAt: typeof releasePayload.published_at === 'string' ? releasePayload.published_at : null,
      }
    }
  }
  return {
    repository,
    defaultBranch,
    latestCommit: { sha, date: typeof date === 'string' ? date : null },
    latestRelease,
  }
}
