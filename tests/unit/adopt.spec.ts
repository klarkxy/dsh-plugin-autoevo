import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { testRuntimeConfig } from '../helpers/runtime-config.js'
import { trackTempDirs } from '../helpers/temp-dirs.js'
import type { RuntimeConfig } from '../../src/config.js'
import type { InstallationRecord } from '../../src/contracts.js'
import { adoptInstallation, scanOrphanedInstallations, type AdoptDeps } from '../../src/service-adopt.js'
import { dependencySpecDigest } from '../../src/resolver/installed-origin.js'
import { StateStore } from '../../src/state/store.js'

const temporary = trackTempDirs()

const ORPHAN_SPEC = `github:acme/orphan#${'c'.repeat(40)}`
const TRACKED_SPEC = `github:acme/tracked#${'d'.repeat(40)}`

function trackedInstallation(overrides: Partial<InstallationRecord> = {}): InstallationRecord {
  const removed = overrides.removed === true
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

function committedChild(parent: InstallationRecord, id: string, installSpec = parent.installSpec): InstallationRecord {
  return trackedInstallation({
    id,
    createdAt: '2026-08-02T00:00:00.000Z',
    dshHome: parent.dshHome,
    targetProfile: parent.targetProfile,
    packageName: parent.packageName,
    installSpec,
    installPhase: 'completed',
    predecessorInstallationId: parent.id,
    replacement: {
      state: 'new_present',
      oldSpecDigest: dependencySpecDigest(parent.installSpec),
      newInstallSpec: installSpec,
      preparedAt: '2026-08-02T00:00:00.000Z',
      reconciledAt: '2026-08-02T00:01:00.000Z',
    },
  })
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

async function writeDependencies(deps: AdoptDeps, dependencies: Record<string, string>): Promise<void> {
  const profileRoot = path.join(deps.config.dshHome, 'profiles', 'web')
  await writeFile(path.join(profileRoot, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    dependencies,
  }))
}

describe('capability adopt', () => {
  it('scans profile dependencies and subtracts tracked installations', async () => {
    const { store, deps } = await setup({
      'dsh-tool-orphan': ORPHAN_SPEC,
      'dsh-tool-tracked': TRACKED_SPEC,
      'dsh-tool-removed': 'file:/local/removed.tgz',
    })
    await store.put('installations', trackedInstallation({
      dshHome: path.join(deps.config.dshHome, '..', path.basename(deps.config.dshHome)),
    }))
    await store.put('installations', trackedInstallation({
      id: `installation_${'2'.repeat(24)}`,
      dshHome: deps.config.dshHome,
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
        adoptable: false,
        adoptionReason: expect.stringMatching(/cannot prove an exact adoption identity/i),
      },
    ])
  })

  it('keeps local and remote reference orphans visible but explicitly non-adoptable', async () => {
    const { deps } = await setup({
      'dsh-tool-local': 'file:C:/private/plugin-a.tgz',
      'dsh-tool-remote': 'https://example.test/plugin.tgz',
    })

    const scan = await scanOrphanedInstallations(deps)

    expect(scan.orphans).toEqual([
      expect.objectContaining({
        packageName: 'dsh-tool-local',
        dependencySpec: 'file:[local-reference]',
        adoptable: false,
        adoptionReason: expect.stringMatching(/exact adoption identity/i),
      }),
      expect.objectContaining({
        packageName: 'dsh-tool-remote',
        dependencySpec: '[remote-reference]',
        adoptable: false,
        adoptionReason: expect.stringMatching(/exact adoption identity/i),
      }),
    ])
  })

  it('never treats two redacted local references as the same adoptable identity', async () => {
    const { store, deps } = await setup({ 'dsh-tool-local': 'file:C:/private/plugin-a.tgz' })
    const claim = vi.spyOn(store, 'claimAdoption')
    const finalize = vi.spyOn(store, 'createInstallationExclusive')

    await expect(adoptInstallation(deps, { packageName: 'dsh-tool-local' })).rejects.toMatchObject({
      code: 'invalid_input',
      details: { unsupported: true },
    })
    await writeDependencies(deps, { 'dsh-tool-local': 'file:D:/different/plugin-b.tgz' })
    await expect(adoptInstallation(deps, { packageName: 'dsh-tool-local' })).rejects.toMatchObject({
      code: 'invalid_input',
      details: { unsupported: true },
    })

    expect(claim).not.toHaveBeenCalled()
    expect(finalize).not.toHaveBeenCalled()
    await expect(store.listInstallations()).resolves.toEqual([])
    await expect(readdir(path.join(store.root, 'adoption-claims'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects an explicit remote-reference adoption before claim or final receipt', async () => {
    const { store, deps } = await setup({ 'dsh-tool-remote': 'git+https://example.test/plugin.git' })
    const claim = vi.spyOn(store, 'claimAdoption')
    const finalize = vi.spyOn(store, 'createInstallationExclusive')

    await expect(adoptInstallation(deps, { packageName: 'dsh-tool-remote' })).rejects.toMatchObject({
      code: 'invalid_input',
      details: { dependencySpec: '[remote-reference]', unsupported: true },
    })

    expect(claim).not.toHaveBeenCalled()
    expect(finalize).not.toHaveBeenCalled()
    await expect(store.listInstallations()).resolves.toEqual([])
    await expect(readdir(path.join(store.root, 'adoption-claims'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not suppress a current-profile package from another home or profile and ignores raw forward links', async () => {
    const { store, deps } = await setup({
      'dsh-tool-other-home': TRACKED_SPEC,
      'dsh-tool-other-profile': TRACKED_SPEC,
      'dsh-tool-superseded': TRACKED_SPEC,
    })
    await store.put('installations', trackedInstallation({
      id: `installation_${'3'.repeat(24)}`,
      dshHome: path.join(deps.config.dshHome, '..', 'other-dsh-home'),
      packageName: 'dsh-tool-other-home',
    }))
    await store.put('installations', trackedInstallation({
      id: `installation_${'4'.repeat(24)}`,
      dshHome: deps.config.dshHome,
      targetProfile: 'desktop',
      packageName: 'dsh-tool-other-profile',
    }))
    await store.put('installations', trackedInstallation({
      id: `installation_${'5'.repeat(24)}`,
      dshHome: deps.config.dshHome,
      packageName: 'dsh-tool-superseded',
      supersededByInstallationId: `installation_${'6'.repeat(24)}`,
    }))

    const scan = await scanOrphanedInstallations(deps)

    expect(scan.orphans.map((item) => item.packageName)).toEqual([
      'dsh-tool-other-home',
      'dsh-tool-other-profile',
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
      installPhase: 'completed',
      installState: 'installed',
      installOutcome: 'awaiting_user_test',
      verified: false,
      removed: false,
    })
    expect(record.reviewId).toBeUndefined()
    expect((await store.getInstallation(record.id)).origin).toBe('adopted')
  })

  it('rejects adopting an already tracked package', async () => {
    const { store, deps } = await setup({ 'dsh-tool-tracked': TRACKED_SPEC })
    await store.put('installations', trackedInstallation({ dshHome: deps.config.dshHome }))

    await expect(adoptInstallation(deps, { packageName: 'dsh-tool-tracked' }))
      .rejects.toThrow(/already tracked/i)
  })

  it('uses normalized Windows identity casing and excludes a foreign-home receipt', async () => {
    const { store, deps } = await setup({ 'dsh-tool-tracked': TRACKED_SPEC })
    await store.put('installations', trackedInstallation({
      id: `installation_${'2'.repeat(24)}`,
      dshHome: path.join(deps.config.dshHome, '..', 'foreign-home'),
    }))
    await store.put('installations', trackedInstallation({
      id: `installation_${'3'.repeat(24)}`,
      dshHome: process.platform === 'win32' ? deps.config.dshHome.toUpperCase() : deps.config.dshHome,
      targetProfile: process.platform === 'win32' ? 'WEB' : 'web',
      packageName: 'DSH-TOOL-TRACKED',
    }))

    await expect(adoptInstallation(deps, { packageName: 'dsh-tool-tracked' }))
      .rejects.toMatchObject({
        code: 'invalid_input',
        details: { installationId: `installation_${'3'.repeat(24)}` },
      })
  })

  it('allows adoption when the matching package is tracked only in another profile', async () => {
    const { store, deps } = await setup({ 'dsh-tool-tracked': TRACKED_SPEC })
    await store.put('installations', trackedInstallation({
      dshHome: deps.config.dshHome,
      targetProfile: 'desktop',
    }))

    const record = await adoptInstallation(deps, { packageName: 'dsh-tool-tracked' })

    expect(record).toMatchObject({
      origin: 'adopted',
      dshHome: deps.config.dshHome,
      targetProfile: 'web',
      packageName: 'dsh-tool-tracked',
    })
  })

  it('rejects adopting a package that is not installed in the current profile', async () => {
    const { deps } = await setup({})

    await expect(adoptInstallation(deps, { packageName: 'dsh-tool-missing' }))
      .rejects.toThrow(/not installed in the current profile/i)
  })

  it('creates one deterministic receipt across two stores and lets the loser help the same provisional claim', async () => {
    const { store, deps } = await setup({ 'dsh-tool-orphan': ORPHAN_SPEC })
    const secondStore = new StateStore(store.root)
    let arrivals = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const gateFirstList = (target: StateStore): void => {
      const original = target.listInstallationsStrict.bind(target)
      let first = true
      vi.spyOn(target, 'listInstallationsStrict').mockImplementation(async () => {
        const records = await original()
        if (first) {
          first = false
          arrivals += 1
          if (arrivals === 2) release()
          await gate
        }
        return records
      })
    }
    gateFirstList(store)
    gateFirstList(secondStore)
    let getArrivals = 0
    let releaseGets!: () => void
    const getGate = new Promise<void>((resolve) => { releaseGets = resolve })
    const gateFirstGet = (target: StateStore): void => {
      const original = target.getInstallation.bind(target)
      let first = true
      vi.spyOn(target, 'getInstallation').mockImplementation(async (id) => {
        if (!first) return original(id)
        first = false
        let value: InstallationRecord | undefined
        let failure: unknown
        try {
          value = await original(id)
        } catch (error) {
          failure = error
        }
        getArrivals += 1
        if (getArrivals === 2) releaseGets()
        await getGate
        if (failure) throw failure
        return value!
      })
    }
    gateFirstGet(store)
    gateFirstGet(secondStore)
    const statuses: string[] = []
    for (const target of [store, secondStore]) {
      const original = target.createInstallationExclusive.bind(target)
      vi.spyOn(target, 'createInstallationExclusive').mockImplementation(async (record) => {
        const result = await original(record)
        statuses.push(result.status)
        return result
      })
    }

    const records = await Promise.all([
      adoptInstallation(deps, { packageName: 'dsh-tool-orphan' }),
      adoptInstallation({ ...deps, store: secondStore }, { packageName: 'dsh-tool-orphan' }),
    ])

    expect(records[0].id).toBe(records[1].id)
    expect(statuses.sort()).toEqual(['created', 'existing'])
    const persisted = await new StateStore(store.root).listInstallations()
    expect(persisted).toHaveLength(1)
    expect(persisted[0]).toMatchObject({ installPhase: 'completed', installState: 'installed', installed: true })
    await expect(readdir(path.join(store.root, 'adoption-claims'))).resolves.toHaveLength(1)
  })

  it('gives one deterministic slot to a spec race and never lets the loser overwrite the winner', async () => {
    const { store, deps } = await setup({ 'dsh-tool-orphan': ORPHAN_SPEC })
    const firstStore = store
    const secondStore = new StateStore(store.root)
    const originalCreate = firstStore.createInstallationExclusive.bind(firstStore)
    let entered!: () => void
    const atClaim = new Promise<void>((resolve) => { entered = resolve })
    let release!: () => void
    const resume = new Promise<void>((resolve) => { release = resolve })
    vi.spyOn(firstStore, 'createInstallationExclusive').mockImplementation(async (record) => {
      entered()
      await resume
      return originalCreate(record)
    })
    const first = adoptInstallation(deps, { packageName: 'dsh-tool-orphan' })
    await atClaim
    const replacementSpec = `github:acme/orphan#${'e'.repeat(40)}`
    await writeDependencies(deps, { 'dsh-tool-orphan': replacementSpec })
    const winner = await adoptInstallation(
      { ...deps, store: secondStore },
      { packageName: 'dsh-tool-orphan' },
    )
    release()

    await expect(first).rejects.toMatchObject({ code: 'invalid_input' })
    expect(winner.installSpec).toBe(replacementSpec)
    const persisted = await new StateStore(store.root).listInstallations()
    expect(persisted).toHaveLength(1)
    expect(persisted[0]?.installSpec).toBe(replacementSpec)
    await expect(readdir(path.join(store.root, 'adoption-claims'))).resolves.toHaveLength(2)
  })

  it('writes no claim when the exact source drifts during the pre-claim owner recheck', async () => {
    const { store, deps } = await setup({ 'dsh-tool-orphan': ORPHAN_SPEC })
    const replacementSpec = `github:acme/orphan#${'f'.repeat(40)}`
    let ownerReads = 0
    const currentProfile = async () => {
      ownerReads += 1
      if (ownerReads === 2) await writeDependencies(deps, { 'dsh-tool-orphan': replacementSpec })
      return 'web'
    }

    await expect(adoptInstallation(
      { ...deps, currentProfile },
      { packageName: 'dsh-tool-orphan' },
    )).rejects.toMatchObject({ code: 'review_expired' })
    await expect(store.listInstallations()).resolves.toEqual([])
  })

  it.each([
    ['changed', { 'dsh-tool-orphan': `github:acme/orphan#${'1'.repeat(40)}` }, 'command_failed'],
    ['absent', {}, 'not_found'],
  ] as const)('leaves only the claim when profile evidence is %s after claim', async (_label, dependencies, code) => {
    const { store, deps } = await setup({ 'dsh-tool-orphan': ORPHAN_SPEC })
    const originalClaim = store.claimAdoption.bind(store)
    vi.spyOn(store, 'claimAdoption').mockImplementation(async (claim) => {
      const result = await originalClaim(claim)
      await writeDependencies(deps, dependencies)
      return result
    })

    await expect(adoptInstallation(deps, { packageName: 'dsh-tool-orphan' }))
      .rejects.toMatchObject({ code })
    await expect(store.listInstallations()).resolves.toEqual([])
    await expect(readdir(path.join(store.root, 'adoption-claims'))).resolves.toHaveLength(1)
  })

  it('leaves the claimed provisional receipt on immediate post-claim abort and lets a helper converge it', async () => {
    const { store, deps } = await setup({ 'dsh-tool-orphan': ORPHAN_SPEC })
    const controller = new AbortController()
    const reason = new Error('abort after adoption claim')
    const originalClaim = store.claimAdoption.bind(store)
    vi.spyOn(store, 'claimAdoption').mockImplementation(async (claim) => {
      const result = await originalClaim(claim)
      controller.abort(reason)
      return result
    })

    await expect(adoptInstallation(
      deps,
      { packageName: 'dsh-tool-orphan' },
      { signal: controller.signal },
    )).rejects.toBe(reason)
    await expect(store.listInstallations()).resolves.toEqual([])
    await expect(readdir(path.join(store.root, 'adoption-claims'))).resolves.toHaveLength(1)

    const completed = await adoptInstallation(
      { ...deps, store: new StateStore(store.root) },
      { packageName: 'dsh-tool-orphan' },
    )
    expect(completed).toMatchObject({ installPhase: 'completed', installState: 'installed', installed: true })
  })

  it('does no profile or state work when adoption is already cancelled', async () => {
    const { store, deps } = await setup({ 'dsh-tool-orphan': ORPHAN_SPEC })
    const controller = new AbortController()
    const reason = new Error('pre-cancel adoption')
    controller.abort(reason)
    const currentProfile = vi.fn(deps.currentProfile)

    await expect(adoptInstallation(
      { ...deps, currentProfile },
      { packageName: 'dsh-tool-orphan' },
      { signal: controller.signal },
    )).rejects.toBe(reason)
    expect(currentProfile).not.toHaveBeenCalled()
    await expect(store.listInstallations()).resolves.toEqual([])
  })

  it('preserves exact cancellation when the post-claim profile-owner read aborts', async () => {
    const { store, deps } = await setup({ 'dsh-tool-orphan': ORPHAN_SPEC })
    const controller = new AbortController()
    const reason = new Error('post-claim owner cancelled')
    let ownerReads = 0
    const currentProfile = async () => {
      ownerReads += 1
      if (ownerReads === 3) {
        controller.abort(reason)
        throw new Error('owner read interrupted')
      }
      return 'web'
    }

    await expect(adoptInstallation(
      { ...deps, currentProfile },
      { packageName: 'dsh-tool-orphan' },
      { signal: controller.signal },
    )).rejects.toBe(reason)
    await expect(store.listInstallations()).resolves.toEqual([])
    await expect(readdir(path.join(store.root, 'adoption-claims'))).resolves.toHaveLength(1)
  })

  it('preserves exact cancellation at the post-claim evidence checkpoint', async () => {
    const { store, deps } = await setup({ 'dsh-tool-orphan': ORPHAN_SPEC })
    const reason = new Error('post-claim evidence cancelled')
    let afterClaim = false
    let postClaimChecks = 0
    let aborted = false
    const signal = {
      get aborted() { return aborted },
      get reason() { return reason },
      throwIfAborted() {
        if (!afterClaim) return
        postClaimChecks += 1
        if (postClaimChecks === 3) {
          aborted = true
          throw reason
        }
      },
    } as AbortSignal
    const originalClaim = store.claimAdoption.bind(store)
    vi.spyOn(store, 'claimAdoption').mockImplementation(async (claim) => {
      const result = await originalClaim(claim)
      afterClaim = true
      return result
    })

    await expect(adoptInstallation(
      deps,
      { packageName: 'dsh-tool-orphan' },
      { signal },
    )).rejects.toBe(reason)
    await expect(store.listInstallations()).resolves.toEqual([])
    await expect(readdir(path.join(store.root, 'adoption-claims'))).resolves.toHaveLength(1)
  })

  it('keeps the append-only final receipt and reports recovery when the source drifts before final recheck', async () => {
    const { store, deps } = await setup({ 'dsh-tool-orphan': ORPHAN_SPEC })
    const replacementSpec = `github:acme/orphan#${'2'.repeat(40)}`
    const originalCreate = store.createInstallationExclusive.bind(store)
    vi.spyOn(store, 'createInstallationExclusive').mockImplementation(async (record) => {
      const result = await originalCreate(record)
      await writeDependencies(deps, { 'dsh-tool-orphan': replacementSpec })
      return result
    })

    await expect(adoptInstallation(deps, { packageName: 'dsh-tool-orphan' })).rejects.toMatchObject({
      code: 'command_failed',
      details: { recoveryRequired: true },
    })
    const [record] = await store.listInstallations()
    expect(record).toMatchObject({
      installPhase: 'completed',
      installState: 'installed',
      installOutcome: 'awaiting_user_test',
      installed: true,
    })
    const scan = await scanOrphanedInstallations(deps)
    expect(scan.orphans).toEqual([expect.objectContaining({
      packageName: 'dsh-tool-orphan',
      dependencySpec: replacementSpec,
    })])
  })

  it('returns the same completed receipt idempotently when its exact live source is unchanged', async () => {
    const { store, deps } = await setup({ 'dsh-tool-orphan': ORPHAN_SPEC })
    const first = await adoptInstallation(deps, { packageName: 'dsh-tool-orphan' })
    const second = await adoptInstallation(deps, { packageName: 'dsh-tool-orphan' })

    expect(second).toEqual(first)
    await expect(store.listInstallations()).resolves.toHaveLength(1)
  })

  it('returns a normalized casing and NFKC-equivalent deterministic final without a new claim or create', async () => {
    const { store, deps } = await setup({ 'dsh-tool-orphan': ORPHAN_SPEC })
    const installed = await adoptInstallation(deps, { packageName: 'dsh-tool-orphan' })
    const equivalent: InstallationRecord = {
      ...installed,
      dshHome: process.platform === 'win32' ? installed.dshHome.toUpperCase() : installed.dshHome,
      targetProfile: process.platform === 'win32' ? 'ＷＥＢ' : installed.targetProfile,
      packageName: 'ＤＳＨ-ＴＯＯＬ-ＯＲＰＨＡＮ',
    }
    await store.put('installations', equivalent)
    const claim = vi.spyOn(store, 'claimAdoption')
    const finalize = vi.spyOn(store, 'createInstallationExclusive')

    await expect(adoptInstallation(deps, { packageName: 'dsh-tool-orphan' })).resolves.toEqual(equivalent)
    expect(claim).not.toHaveBeenCalled()
    expect(finalize).not.toHaveBeenCalled()
  })

  it.each(['foreign-home', 'different-profile'] as const)(
    'rejects a deterministic final with a genuinely different %s identity',
    async (variant) => {
      const { store, deps } = await setup({ 'dsh-tool-orphan': ORPHAN_SPEC })
      const installed = await adoptInstallation(deps, { packageName: 'dsh-tool-orphan' })
      await store.put('installations', {
        ...installed,
        ...(variant === 'foreign-home'
          ? { dshHome: path.join(deps.config.dshHome, '..', 'foreign-home') }
          : { targetProfile: 'desktop' }),
      })
      const claim = vi.spyOn(store, 'claimAdoption')
      const finalize = vi.spyOn(store, 'createInstallationExclusive')

      await expect(adoptInstallation(deps, { packageName: 'dsh-tool-orphan' }))
        .rejects.toMatchObject({ code: 'invalid_input' })
      expect(claim).not.toHaveBeenCalled()
      expect(finalize).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['missing', undefined],
    ['wrong', `installation_${'8'.repeat(24)}`],
    ['self', `installation_${'4'.repeat(24)}`],
  ])('ignores a %s raw forward link when classifying one tracked live leaf', async (_label, forward) => {
    const { store, deps } = await setup({ 'dsh-tool-orphan': ORPHAN_SPEC })
    const receipt = trackedInstallation({
      id: `installation_${'4'.repeat(24)}`,
      dshHome: deps.config.dshHome,
      packageName: 'dsh-tool-orphan',
      installSpec: ORPHAN_SPEC,
      ...(forward ? { supersededByInstallationId: forward } : {}),
    })
    await store.put('installations', receipt)
    const claim = vi.spyOn(store, 'claimAdoption')

    await expect(scanOrphanedInstallations(deps)).resolves.toMatchObject({ orphans: [] })
    await expect(adoptInstallation(deps, { packageName: 'dsh-tool-orphan' }))
      .rejects.toThrow(/already tracked/i)
    expect(claim).not.toHaveBeenCalled()
  })

  it('suppresses an ambiguous scan and rejects explicit adoption before claim', async () => {
    const { store, deps } = await setup({ 'dsh-tool-orphan': ORPHAN_SPEC })
    const parent = trackedInstallation({
      id: `installation_${'4'.repeat(24)}`,
      dshHome: deps.config.dshHome,
      packageName: 'dsh-tool-orphan',
      installSpec: ORPHAN_SPEC,
      installPhase: 'completed',
    })
    const first = committedChild(parent, `installation_${'5'.repeat(24)}`)
    const second = committedChild(parent, `installation_${'6'.repeat(24)}`)
    for (const item of [parent, first, second]) await store.put('installations', item)
    const claim = vi.spyOn(store, 'claimAdoption')
    const finalize = vi.spyOn(store, 'createInstallationExclusive')

    await expect(scanOrphanedInstallations(deps)).resolves.toMatchObject({ orphans: [] })
    await expect(adoptInstallation(deps, { packageName: 'dsh-tool-orphan' })).rejects.toMatchObject({
      code: 'invalid_input',
      details: { recoveryRequired: true, ambiguousCount: 2 },
    })
    expect(claim).not.toHaveBeenCalled()
    expect(finalize).not.toHaveBeenCalled()
  })

  it('does not finalize when a canonical live child appears after the adoption claim', async () => {
    const { store, deps } = await setup({ 'dsh-tool-orphan': ORPHAN_SPEC })
    const originalStrict = store.listInstallationsStrict.bind(store)
    let strictReads = 0
    vi.spyOn(store, 'listInstallationsStrict').mockImplementation(async () => {
      strictReads += 1
      if (strictReads === 2) {
        const parent = trackedInstallation({
          id: `installation_${'4'.repeat(24)}`,
          dshHome: deps.config.dshHome,
          packageName: 'dsh-tool-orphan',
          installSpec: ORPHAN_SPEC,
          installPhase: 'completed',
        })
        await store.put('installations', parent)
        await store.put('installations', committedChild(parent, `installation_${'5'.repeat(24)}`))
      }
      return originalStrict()
    })
    const finalize = vi.spyOn(store, 'createInstallationExclusive')

    await expect(adoptInstallation(deps, { packageName: 'dsh-tool-orphan' }))
      .rejects.toMatchObject({
        code: 'invalid_input',
        details: {
          installationId: `installation_${'5'.repeat(24)}`,
          recoveryRequired: true,
        },
      })
    expect(finalize).not.toHaveBeenCalled()
    await expect(readdir(path.join(store.root, 'adoption-claims'))).resolves.toHaveLength(1)
  })

  it('rejects corrupt installation history before adoption claim or final receipt', async () => {
    const { store, deps } = await setup({ 'dsh-tool-orphan': ORPHAN_SPEC })
    const corruptId = `installation_${'7'.repeat(24)}`
    await mkdir(path.join(store.root, 'installations'), { recursive: true })
    await writeFile(path.join(store.root, 'installations', `${corruptId}.json`), '{not-json', 'utf8')
    const claim = vi.spyOn(store, 'claimAdoption')
    const finalize = vi.spyOn(store, 'createInstallationExclusive')

    await expect(scanOrphanedInstallations(deps)).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(adoptInstallation(deps, { packageName: 'dsh-tool-orphan' }))
      .rejects.toMatchObject({ code: 'invalid_input' })
    expect(claim).not.toHaveBeenCalled()
    expect(finalize).not.toHaveBeenCalled()
  })

  it('keeps an exact deterministic final idempotent despite a stale raw forward link', async () => {
    const { store, deps } = await setup({ 'dsh-tool-orphan': ORPHAN_SPEC })
    const installed = await adoptInstallation(deps, { packageName: 'dsh-tool-orphan' })
    await store.put('installations', {
      ...installed,
      supersededByInstallationId: `installation_${'8'.repeat(24)}`,
    })

    await expect(adoptInstallation(deps, { packageName: 'dsh-tool-orphan' }))
      .resolves.toMatchObject({ id: installed.id })
  })

  it('rejects a deterministic final that has a canonical live child even when raw forward is missing', async () => {
    const { store, deps } = await setup({ 'dsh-tool-orphan': ORPHAN_SPEC })
    const installed = await adoptInstallation(deps, { packageName: 'dsh-tool-orphan' })
    const child = committedChild(installed, `installation_${'9'.repeat(24)}`)
    await store.put('installations', child)
    const claim = vi.spyOn(store, 'claimAdoption')

    await expect(adoptInstallation(deps, { packageName: 'dsh-tool-orphan' }))
      .rejects.toThrow(/already tracked/i)
    expect(claim).not.toHaveBeenCalled()
  })

  it('shows a legacy noninstalled receipt as an orphan but keeps its deterministic final collision fail-closed', async () => {
    const { store, deps } = await setup({ 'dsh-tool-orphan': ORPHAN_SPEC })
    const installed = await adoptInstallation(deps, { packageName: 'dsh-tool-orphan' })
    const legacy = {
      ...installed,
      installState: 'unknown' as const,
      installOutcome: 'recovery_required' as const,
      installed: false,
    }
    await store.put('installations', legacy)

    const scan = await scanOrphanedInstallations(deps)
    expect(scan.orphans.map((item) => item.packageName)).toContain('dsh-tool-orphan')
    await expect(adoptInstallation(deps, { packageName: 'dsh-tool-orphan' }))
      .rejects.toMatchObject({ code: 'invalid_input' })
    await expect(store.getInstallation(installed.id)).resolves.toEqual(legacy)
  })

})
