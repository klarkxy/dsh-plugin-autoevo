import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
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
  const removed = overrides.removed === true
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
    installPhase: 'completed',
    installState: removed ? 'not_installed' : 'installed',
    installOutcome: 'verified',
    installed: !removed,
    loaded: !removed,
    verified: !removed,
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

function ghRunner(options: {
  headSha: string
  release?: string | null
  releasePayload?: string
  releaseFailure?: { exitCode: number; stdout: string; stderr: string }
  repoPayload?: string
}): CommandRunner {
  return {
    async run(request) {
      const joined = request.argv.join(' ')
      const ok = (stdout: string) => ({ exitCode: 0, signal: null, stdout, stderr: '' })
      if (joined.includes('/releases/latest')) {
        if (options.releaseFailure) return { ...options.releaseFailure, signal: null }
        if (options.releasePayload !== undefined) return ok(options.releasePayload)
        if (options.release == null) return { exitCode: 1, signal: null, stdout: '', stderr: 'gh: Not Found (HTTP 404)' }
        return ok(JSON.stringify({ tag_name: options.release, published_at: '2026-08-01T00:00:00Z' }))
      }
      if (joined.includes('/commits')) {
        return ok(JSON.stringify([{ sha: options.headSha, commit: { committer: { date: '2026-08-10T00:00:00Z' } } }]))
      }
      if (/repos\/[^/]+\/[^/]+$/u.test(joined)) return ok(options.repoPayload ?? JSON.stringify({ default_branch: 'main' }))
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
  it('rejects corrupt installation history before any upstream request without leaking record contents', async () => {
    const requests: string[] = []
    const runner: CommandRunner = {
      async run(request) {
        requests.push(request.argv.join(' '))
        throw new Error('upstream must not run')
      },
    }
    const { store, deps: d } = await deps(runner)
    const badId = `installation_${'9'.repeat(24)}`
    const secret = 'github:private/secret-repository#deadbeef'
    const directory = path.join(store.root, 'installations')
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, `${badId}.json`), JSON.stringify({
      schemaVersion: 1,
      id: badId,
      createdAt: '2026-08-31T00:00:00.000Z',
      privateInstallSpec: secret,
    }), 'utf8')

    const failure = await checkCapabilityUpdates(d).then(() => undefined, (error: unknown) => error)

    expect(failure).toMatchObject({
      code: 'invalid_input',
      details: {
        diagnosticCount: 1,
        diagnosticHashes: [expect.stringMatching(/^[a-f0-9]{64}$/u)],
      },
    })
    expect(requests).toEqual([])
    expect(JSON.stringify(failure)).not.toContain(secret)
    expect(JSON.stringify(failure)).not.toContain(store.root)
  })

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

  it('rethrows the exact abort reason from the first repository and does not start the second', async () => {
    const controller = new AbortController()
    const reason = new Error('cancel upstream check')
    const requests: string[] = []
    const base = ghRunner({ headSha: UPSTREAM_SHA, release: 'v1.2.0' })
    const runner: CommandRunner = {
      async run(request) {
        const joined = request.argv.join(' ')
        requests.push(joined)
        if (joined.includes('/repos/acme/alpha')) {
          controller.abort(reason)
          throw reason
        }
        return await base.run(request)
      },
    }
    const { store, deps: d } = await deps(runner)
    await store.put('installations', installation({
      id: `installation_${'1'.repeat(24)}`,
      packageName: 'dsh-tool-alpha',
      installSpec: `github:acme/alpha#${INSTALLED_SHA}`,
    }))
    await store.put('installations', installation({
      id: `installation_${'2'.repeat(24)}`,
      packageName: 'dsh-tool-beta',
      installSpec: `github:acme/beta#${INSTALLED_SHA}`,
    }))

    let failure: unknown
    try {
      await checkCapabilityUpdates(d, { signal: controller.signal })
    } catch (error) {
      failure = error
    }

    expect(failure).toBe(reason)
    expect(requests.some((request) => request.includes('/repos/acme/alpha'))).toBe(true)
    expect(requests.some((request) => request.includes('/repos/acme/beta'))).toBe(false)
  })

  it.each([
    ['401', { exitCode: 1, stdout: '', stderr: 'gh: Requires authentication (HTTP 401)' }],
    ['403', { exitCode: 1, stdout: '', stderr: 'gh: Forbidden (HTTP 403)' }],
    ['rate limit', { exitCode: 1, stdout: '', stderr: 'gh: API rate limit exceeded (HTTP 403)' }],
    ['ordinary exit 1', { exitCode: 1, stdout: '', stderr: 'network transport failed' }],
  ])('reports latest-release %s failures as entry errors instead of null', async (_label, releaseFailure) => {
    const { store, deps: d } = await deps(ghRunner({ headSha: UPSTREAM_SHA, releaseFailure }))
    await store.put('installations', installation())

    const report = await checkCapabilityUpdates(d)

    expect(report.updates[0]?.latestRelease).toBeUndefined()
    expect(report.updates[0]?.error).toMatch(/gh exited with code 1/u)
  })

  it.each([
    ['empty body', ''],
    ['empty object', '{}'],
    ['empty tag', JSON.stringify({ tag_name: '   ', published_at: null })],
    ['wrong tag type', JSON.stringify({ tag_name: 42 })],
  ])('reports HTTP 200 latest-release %s as malformed instead of null', async (_label, releasePayload) => {
    const { store, deps: d } = await deps(ghRunner({ headSha: UPSTREAM_SHA, releasePayload }))
    await store.put('installations', installation())

    const report = await checkCapabilityUpdates(d)

    expect(report.updates[0]?.latestRelease).toBeUndefined()
    expect(report.updates[0]?.error).toMatch(/latest release data/u)
  })

  it.each([
    ['truncated JSON', '{'],
    ['array', '[]'],
  ])('reports malformed repository payload %s as github_unavailable like the release boundary', async (_label, repoPayload) => {
    const { store, deps: d } = await deps(ghRunner({ headSha: UPSTREAM_SHA, release: null, repoPayload }))
    await store.put('installations', installation())

    const report = await checkCapabilityUpdates(d)

    expect(report.updates[0]?.error).toMatch(/GitHub returned malformed repository data/u)
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
