import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { testRuntimeConfig } from '../helpers/runtime-config.js'
import { trackTempDirs } from '../helpers/temp-dirs.js'
import type { RuntimeConfig } from '../../src/config.js'
import type { InstallationRecord } from '../../src/contracts.js'
import { adoptInstallation, scanOrphanedInstallations, type AdoptDeps } from '../../src/service-adopt.js'
import { StateStore } from '../../src/state/store.js'

const temporary = trackTempDirs()

const ORPHAN_SPEC = `github:acme/orphan#${'c'.repeat(40)}`
const TRACKED_SPEC = `github:acme/tracked#${'d'.repeat(40)}`

function trackedInstallation(overrides: Partial<InstallationRecord> = {}): InstallationRecord {
  return {
    schemaVersion: 1,
    id: `installation_${'1'.repeat(24)}`,
    createdAt: '2026-08-01T00:00:00.000Z',
    reviewId: `review_${'a'.repeat(64)}`,
    targetProfile: 'web',
    retention: 'persistent',
    dshHome: 'persistent-dsh-home',
    packageName: 'dsh-tool-tracked',
    installSpec: TRACKED_SPEC,
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

async function setup(dependencies: Record<string, string>): Promise<{ store: StateStore; deps: AdoptDeps }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-adopt-'))
  temporary.push(root)
  const config: RuntimeConfig = testRuntimeConfig(root, { dshHome: path.join(root, 'dsh-home') })
  const profileRoot = path.join(config.dshHome, 'profiles', 'web')
  await mkdir(profileRoot, { recursive: true })
  await writeFile(path.join(profileRoot, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    dependencies,
  }))
  const store = new StateStore(root)
  return {
    store,
    deps: { store, config, currentProfile: async () => 'web' },
  }
}

describe('capability adopt', () => {
  it('scans profile dependencies and subtracts tracked installations', async () => {
    const { store, deps } = await setup({
      'dsh-tool-orphan': ORPHAN_SPEC,
      'dsh-tool-tracked': TRACKED_SPEC,
      'dsh-tool-removed': 'file:/local/removed.tgz',
    })
    await store.put('installations', trackedInstallation())
    await store.put('installations', trackedInstallation({
      id: `installation_${'2'.repeat(24)}`,
      packageName: 'dsh-tool-removed',
      installSpec: 'file:/local/removed.tgz',
      removed: true,
    }))

    const scan = await scanOrphanedInstallations(deps)

    expect(scan.profile).toBe('web')
    expect(scan.orphans).toEqual([
      {
        packageName: 'dsh-tool-orphan',
        dependencySpec: ORPHAN_SPEC,
        configuredBundle: false,
        repository: 'acme/orphan',
        commit: 'c'.repeat(40),
      },
      {
        packageName: 'dsh-tool-removed',
        dependencySpec: 'file:[local-reference]',
        configuredBundle: false,
      },
    ])
  })

  it('registers an adopted receipt without a review', async () => {
    const { store, deps } = await setup({ 'dsh-tool-orphan': ORPHAN_SPEC })

    const record = await adoptInstallation(deps, { packageName: 'dsh-tool-orphan' })

    expect(record).toMatchObject({
      origin: 'adopted',
      packageName: 'dsh-tool-orphan',
      installSpec: ORPHAN_SPEC,
      targetProfile: 'web',
      retention: 'persistent',
      installed: true,
      verified: false,
      removed: false,
    })
    expect(record.reviewId).toBeUndefined()
    expect(record.installOutcome).toBeUndefined()
    expect((await store.getInstallation(record.id)).origin).toBe('adopted')
  })

  it('rejects adopting an already tracked package', async () => {
    const { store, deps } = await setup({ 'dsh-tool-tracked': TRACKED_SPEC })
    await store.put('installations', trackedInstallation())

    await expect(adoptInstallation(deps, { packageName: 'dsh-tool-tracked' }))
      .rejects.toThrow(/already tracked/i)
  })

  it('rejects adopting a package that is not installed in the current profile', async () => {
    const { deps } = await setup({})

    await expect(adoptInstallation(deps, { packageName: 'dsh-tool-missing' }))
      .rejects.toThrow(/not installed in the current profile/i)
  })
})
