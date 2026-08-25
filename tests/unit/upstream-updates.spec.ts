import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { testRuntimeConfig } from '../helpers/runtime-config.js'
import { trackTempDirs } from '../helpers/temp-dirs.js'
import type { RuntimeConfig } from '../../src/config.js'
import type { InstallationRecord } from '../../src/contracts.js'
import type { CommandRunner } from '../../src/process/runner.js'
import { checkCapabilityUpdates, type UpdateTrackingDeps } from '../../src/service-updates.js'
import { StateStore } from '../../src/state/store.js'

const temporary = trackTempDirs()

const INSTALLED_SHA = 'c'.repeat(40)
const UPSTREAM_SHA = 'd'.repeat(40)

function installation(overrides: Partial<InstallationRecord> = {}): InstallationRecord {
  return {
    schemaVersion: 1,
    id: `installation_${'1'.repeat(24)}`,
    createdAt: '2026-08-01T00:00:00.000Z',
    reviewId: `review_${'a'.repeat(64)}`,
    targetProfile: 'web',
    retention: 'persistent',
    dshHome: 'persistent-dsh-home',
    packageName: 'dsh-tool-calculator',
    installSpec: `github:acme/calculator#${INSTALLED_SHA}`,
    installed: true,
    loaded: true,
    verified: true,
    restartRequired: false,
    removed: false,
    verification: {
      attempted: false,
      expectedTools: [],
      calledTools: [],
      resultTools: [],
      failedTools: [],
      sessionFiles: [],
      taskResultObserved: false,
      reason: 'tracked',
    },
    ...overrides,
  }
}

function ghRunner(options: { headSha: string; release?: string | null }): CommandRunner {
  return {
    async run(request) {
      const joined = request.argv.join(' ')
      const ok = (stdout: string) => ({ exitCode: 0, signal: null, stdout, stderr: '' })
      if (joined.includes('/releases/latest')) {
        if (options.release == null) return { exitCode: 1, signal: null, stdout: '', stderr: 'Not Found' }
        return ok(JSON.stringify({ tag_name: options.release, published_at: '2026-08-01T00:00:00Z' }))
      }
      if (joined.includes('/commits')) {
        return ok(JSON.stringify([{ sha: options.headSha, commit: { committer: { date: '2026-08-10T00:00:00Z' } } }]))
      }
      if (/repos\/[^/]+\/[^/]+$/u.test(joined)) return ok(JSON.stringify({ default_branch: 'main' }))
      return ok('')
    },
  }
}

async function deps(runner: CommandRunner): Promise<{ store: StateStore; deps: UpdateTrackingDeps }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-updates-'))
  temporary.push(root)
  const config: RuntimeConfig = testRuntimeConfig(root)
  const store = new StateStore(root)
  return { store, deps: { store, config, runner, cwd: root } }
}

describe('capability upstream updates', () => {
  it('reports an available update when upstream moved ahead', async () => {
    const { store, deps: d } = await deps(ghRunner({ headSha: UPSTREAM_SHA, release: 'v1.2.0' }))
    await store.put('installations', installation())

    const report = await checkCapabilityUpdates(d)

    expect(report.updates).toEqual([expect.objectContaining({
      packageName: 'dsh-tool-calculator',
      repository: 'acme/calculator',
      installedSha: INSTALLED_SHA,
      upstreamSha: UPSTREAM_SHA,
      updateAvailable: true,
      latestRelease: { tag: 'v1.2.0', publishedAt: '2026-08-01T00:00:00Z' },
    })])
    expect(report.skipped).toEqual([])
    expect(report.guidance).toMatch(/evolve_existing/i)
  })

  it('reports no update when the pinned commit matches upstream head', async () => {
    const { store, deps: d } = await deps(ghRunner({ headSha: INSTALLED_SHA, release: null }))
    const adopted = installation({ id: `installation_${'1'.repeat(24)}`, origin: 'adopted' })
    delete adopted.reviewId
    await store.put('installations', adopted)

    const report = await checkCapabilityUpdates(d)

    expect(report.updates).toEqual([expect.objectContaining({
      origin: 'adopted',
      updateAvailable: false,
      upstreamSha: INSTALLED_SHA,
      latestRelease: null,
    })])
  })

  it('tolerates a missing latest release as null', async () => {
    const { store, deps: d } = await deps(ghRunner({ headSha: UPSTREAM_SHA, release: null }))
    await store.put('installations', installation())

    const report = await checkCapabilityUpdates(d)

    expect(report.updates[0]).toMatchObject({ latestRelease: null, updateAvailable: true })
    expect(report.updates[0]?.error).toBeUndefined()
  })

  it('skips installations without an exact GitHub pin and removed receipts', async () => {
    const { store, deps: d } = await deps(ghRunner({ headSha: UPSTREAM_SHA, release: null }))
    await store.put('installations', installation({
      id: `installation_${'2'.repeat(24)}`,
      packageName: 'dsh-tool-local',
      installSpec: 'file:/local/artifact.tgz',
    }))
    await store.put('installations', installation({
      id: `installation_${'3'.repeat(24)}`,
      removed: true,
    }))

    const report = await checkCapabilityUpdates(d)

    expect(report.updates).toEqual([])
    expect(report.skipped).toEqual([expect.objectContaining({
      packageName: 'dsh-tool-local',
      installationId: `installation_${'2'.repeat(24)}`,
    })])
  })
})
