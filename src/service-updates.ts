import type { RuntimeConfig } from './config.js'
import { fetchUpstreamState } from './github/upstream.js'
import type { CommandRunner } from './process/runner.js'
import { parseExactGithubDependency } from './resolver/installed-origin.js'
import type { StateStore } from './state/store.js'

export interface UpdateTrackingDeps {
  store: StateStore
  config: RuntimeConfig
  runner: CommandRunner
  cwd: string
}

export interface CapabilityUpdateEntry {
  packageName: string
  installationId: string
  origin?: 'managed' | 'adopted'
  repository: string
  installedSha: string
  upstreamSha?: string
  upstreamCommittedAt?: string | null
  latestRelease?: { tag: string; publishedAt: string | null } | null
  updateAvailable: boolean
  error?: string
}

export interface SkippedInstallation {
  packageName: string | null
  installationId: string
  reason: string
}

export interface CapabilityUpdateReport {
  updates: CapabilityUpdateEntry[]
  skipped: SkippedInstallation[]
  guidance: string
}

const UPGRADE_GUIDANCE = 'Updates are reported read-only. To upgrade, start capability_workflow with intent evolve_existing (reason upgrade) for the package; the standard review and approval gates apply.'

/** Read-only upstream check for every tracked installation pinned to an exact GitHub commit. */
export async function checkCapabilityUpdates(
  deps: UpdateTrackingDeps,
  options: { signal?: AbortSignal } = {},
): Promise<CapabilityUpdateReport> {
  let installationHistory
  try {
    installationHistory = await deps.store.listInstallationsStrict()
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason
    throw error
  }
  options.signal?.throwIfAborted()
  const records = installationHistory.filter((record) => !record.removed)
  const updates: CapabilityUpdateEntry[] = []
  const skipped: SkippedInstallation[] = []
  for (const record of records) {
    options.signal?.throwIfAborted()
    const parsed = parseExactGithubDependency(record.installSpec)
    if (!parsed) {
      skipped.push({
        packageName: record.packageName,
        installationId: record.id,
        reason: 'Installation spec is not an exact GitHub commit pin; upstream comparison is unavailable.',
      })
      continue
    }
    const entry: CapabilityUpdateEntry = {
      packageName: record.packageName ?? parsed.repository,
      installationId: record.id,
      ...(record.origin ? { origin: record.origin } : {}),
      repository: parsed.repository,
      installedSha: parsed.commit,
      updateAvailable: false,
    }
    try {
      const upstream = await fetchUpstreamState({
        runner: deps.runner,
        config: deps.config,
        cwd: deps.cwd,
        repository: parsed.repository,
        ...(options.signal ? { signal: options.signal } : {}),
      })
      options.signal?.throwIfAborted()
      entry.upstreamSha = upstream.latestCommit.sha
      entry.upstreamCommittedAt = upstream.latestCommit.date
      entry.latestRelease = upstream.latestRelease
      entry.updateAvailable = upstream.latestCommit.sha.toLowerCase() !== parsed.commit.toLowerCase()
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason
      entry.error = error instanceof Error ? error.message : String(error)
    }
    updates.push(entry)
  }
  return { updates, skipped, guidance: UPGRADE_GUIDANCE }
}
