import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { testReview } from '../helpers/records.js'
import { testRuntimeConfig } from '../helpers/runtime-config.js'
import { trackTempDirs } from '../helpers/temp-dirs.js'
import type { RuntimeConfig } from '../../src/config.js'
import type { InstallationRecord, ReviewRecord, VerificationEvidence } from '../../src/contracts.js'
import { EvolutionError } from '../../src/errors.js'
import { PluginInstaller } from '../../src/lifecycle/install.js'
import type { DshLauncher } from '../../src/lifecycle/launcher.js'
import { dependencySpecDigest } from '../../src/resolver/installed-origin.js'
import {
  listCapabilityVersions,
  rollbackInstallation,
  versionChain,
  type VersionTrackingDeps,
} from '../../src/service-versions.js'
import { StateStore } from '../../src/state/store.js'
import { sha256 } from '../../src/state/hashes.js'
import { createTools } from '../../src/tools.js'
import type { CapabilityEvolutionService } from '../../src/service.js'

const temporary = trackTempDirs()

const OLD_SPEC = `github:acme/calculator#${'c'.repeat(40)}`
const NEW_SPEC = `github:acme/calculator#${'d'.repeat(40)}`

function config(root: string): RuntimeConfig {
  return testRuntimeConfig(root, { dshHome: path.join(root, 'persistent-dsh-home') })
}

function execution(signal?: AbortSignal): ToolRunContext {
  return {
    callId: 'call-1',
    agent: { session: { header: { cwd: process.cwd() } } },
    ...(signal ? { signal } : {}),
  } as unknown as ToolRunContext
}

function attestedReview(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  const current = testReview(overrides)
  return {
    ...current,
    runtimeSurface: {
      llmDependency: false,
      llmRegistered: false,
      credentialsDependency: false,
      credentialsRegistered: false,
      networkSignal: false,
      environmentSignal: false,
      processSignal: false,
      skillOnly: false,
      unsafeTools: false,
      expectedTools: ['calculator'],
      toolFixtures: [{ tool: 'calculator', available: true, safe: true, hostValidated: true }],
      kind: 'bundle',
      verificationLayer: 'tool_roundtrip',
    },
  }
}

function installation(overrides: Partial<InstallationRecord> & { id: string }): InstallationRecord {
  const removed = overrides.removed === true
  return {
    schemaVersion: 1,
    createdAt: '2026-08-01T00:00:00.000Z',
    reviewId: `review_${'a'.repeat(64)}`,
    targetProfile: 'web',
    retention: 'persistent',
    dshHome: 'persistent-dsh-home',
    packageName: 'dsh-tool-calculator',
    installSpec: OLD_SPEC,
    installPhase: 'completed',
    installState: removed ? 'not_installed' : 'installed',
    installOutcome: 'verified',
    installed: !removed,
    loaded: !removed,
    verified: !removed,
    restartRequired: false,
    removed: false,
    verification: {
      attempted: true,
      expectedTools: ['calculator'],
      calledTools: ['calculator'],
      resultTools: ['calculator'],
      failedTools: [],
      sessionFiles: [],
      taskResultObserved: true,
      reason: 'ok',
    },
    ...overrides,
  }
}

function committedChild(
  parent: InstallationRecord,
  overrides: Partial<InstallationRecord> & { id: string; installSpec: string },
): InstallationRecord {
  return installation({
    dshHome: parent.dshHome,
    targetProfile: parent.targetProfile,
    packageName: parent.packageName,
    installPhase: 'completed',
    predecessorInstallationId: parent.id,
    replacement: {
      state: 'new_present',
      oldSpecDigest: dependencySpecDigest(parent.installSpec),
      newInstallSpec: overrides.installSpec,
      preparedAt: overrides.createdAt ?? '2026-08-02T00:00:00.000Z',
      reconciledAt: overrides.createdAt ?? '2026-08-02T00:01:00.000Z',
    },
    ...overrides,
  })
}

async function setup(): Promise<{ root: string; store: StateStore; ctx: Context }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-versions-'))
  temporary.push(root)
  const store = new StateStore(root)
  const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
  return { root, store, ctx }
}

const hostPassedEvidence: VerificationEvidence = {
  attempted: true,
  exitCode: 0,
  expectedTools: ['calculator'],
  calledTools: ['calculator'],
  resultTools: ['calculator'],
  failedTools: [],
  sessionFiles: [],
  taskResultObserved: false,
  layer: 'tool_roundtrip',
  status: 'passed',
  sourceMatched: true,
  reason: 'Host executed 1 expected tool(s) once through ToolRuntime.execute.',
}

describe('capability version chain', () => {
  it('orders same-package records along predecessor/superseded links', () => {
    const first = installation({ id: `installation_${'1'.repeat(24)}`, createdAt: '2026-08-01T00:00:00.000Z', supersededByInstallationId: `installation_${'2'.repeat(24)}` })
    const second = installation({
      id: `installation_${'2'.repeat(24)}`,
      createdAt: '2026-08-02T00:00:00.000Z',
      installSpec: NEW_SPEC,
      predecessorInstallationId: first.id,
      supersededByInstallationId: `installation_${'3'.repeat(24)}`,
    })
    const third = installation({
      id: `installation_${'3'.repeat(24)}`,
      createdAt: '2026-08-03T00:00:00.000Z',
      predecessorInstallationId: second.id,
    })
    const ordered = versionChain([third, first, second])
    expect(ordered.map((item) => item.id)).toEqual([first.id, second.id, third.id])
  })

  it('lists versions with the live active version and artifact availability', async () => {
    const { root, store } = await setup()
    const oldRecord = installation({ id: `installation_${'1'.repeat(24)}`, supersededByInstallationId: `installation_${'2'.repeat(24)}` })
    const current = committedChild(oldRecord, {
      id: `installation_${'2'.repeat(24)}`,
      createdAt: '2026-08-02T00:00:00.000Z',
      installSpec: NEW_SPEC,
    })
    const orphan = installation({
      id: `installation_${'4'.repeat(24)}`,
      createdAt: '2026-08-04T00:00:00.000Z',
      installSpec: 'file:/missing/artifact.tgz',
      removed: false,
    })
    await store.put('installations', oldRecord)
    await store.put('installations', current)
    await store.put('installations', orphan)
    const launcher = {
      profileDependencySpec: async () => NEW_SPEC,
    } as unknown as DshLauncher
    const list = await listCapabilityVersions({ store, config: config(root), launcher }, { packageName: 'dsh-tool-calculator' })
    expect(list.versions.map((item) => item.installationId)).toEqual([oldRecord.id, current.id, orphan.id])
    expect(list.versions[1]).toMatchObject({ installSpec: NEW_SPEC, active: true, artifactAvailable: true })
    expect(list.versions[0]).toMatchObject({ installSpec: OLD_SPEC, active: false })
    expect(list.versions[2]).toMatchObject({ artifactAvailable: false })
    const anchored = await listCapabilityVersions({ store, config: config(root), launcher }, { installationId: current.id })
    expect(anchored.packageName).toBe('dsh-tool-calculator')
    expect(anchored.versions).toHaveLength(3)
  })

  it.each([
    ['missing', undefined],
    ['wrong', `installation_${'9'.repeat(24)}`],
  ])('derives order and output links when the parent forward link is %s', async (_label, forward) => {
    const { root, store } = await setup()
    const parent = installation({
      id: `installation_${'1'.repeat(24)}`,
      installPhase: 'completed',
      ...(forward ? { supersededByInstallationId: forward } : {}),
    })
    const current = committedChild(parent, {
      id: `installation_${'2'.repeat(24)}`,
      createdAt: '2026-08-02T00:00:00.000Z',
      installSpec: NEW_SPEC,
    })
    await store.put('installations', current)
    await store.put('installations', parent)

    const result = await listCapabilityVersions({
      store,
      config: config(root),
      launcher: { profileDependencySpec: async () => NEW_SPEC } as unknown as DshLauncher,
    }, { packageName: 'dsh-tool-calculator' })

    expect(result.versions.map((item) => item.installationId)).toEqual([parent.id, current.id])
    expect(result.versions[0]).toMatchObject({ supersededByInstallationId: current.id, active: false })
    expect(result.versions[1]).toMatchObject({ predecessorInstallationId: parent.id, active: true })
  })

  it('retains removed child history and never reclassifies its parent as a live leaf', async () => {
    const { root, store } = await setup()
    const parent = installation({ id: `installation_${'1'.repeat(24)}`, installPhase: 'completed' })
    const removed = committedChild(parent, {
      id: `installation_${'2'.repeat(24)}`,
      createdAt: '2026-08-02T00:00:00.000Z',
      installSpec: NEW_SPEC,
      removed: true,
    })
    await store.put('installations', parent)
    await store.put('installations', removed)

    const result = await listCapabilityVersions({
      store,
      config: config(root),
      launcher: { profileDependencySpec: async () => undefined } as unknown as DshLauncher,
    }, { packageName: 'dsh-tool-calculator' })

    expect(result.versions.map((item) => item.installationId)).toEqual([parent.id, removed.id])
    expect(result.versions[0]).toMatchObject({ supersededByInstallationId: removed.id, active: false })
    expect(result.versions[1]).toMatchObject({ removed: true, active: false })
  })

  it('retains branches in stable order and marks only the unique exact live leaf active', async () => {
    const { root, store } = await setup()
    const parent = installation({ id: `installation_${'1'.repeat(24)}`, installPhase: 'completed' })
    const first = committedChild(parent, {
      id: `installation_${'2'.repeat(24)}`,
      createdAt: '2026-08-02T00:00:00.000Z',
      installSpec: NEW_SPEC,
    })
    const liveSpec = `github:acme/calculator#${'e'.repeat(40)}`
    const second = committedChild(parent, {
      id: `installation_${'3'.repeat(24)}`,
      createdAt: '2026-08-03T00:00:00.000Z',
      installSpec: liveSpec,
    })
    for (const item of [second, parent, first]) await store.put('installations', item)

    const result = await listCapabilityVersions({
      store,
      config: config(root),
      launcher: { profileDependencySpec: async () => liveSpec } as unknown as DshLauncher,
    }, { packageName: 'dsh-tool-calculator' })

    expect(result.versions.map((item) => item.installationId)).toEqual([parent.id, first.id, second.id])
    expect(result.versions.filter((item) => item.active).map((item) => item.installationId)).toEqual([second.id])
    expect(result.versions[0]?.supersededByInstallationId).toBeUndefined()
  })

  it('fails closed instead of reporting multiple active same-spec branches', async () => {
    const { root, store } = await setup()
    const parent = installation({ id: `installation_${'1'.repeat(24)}`, installPhase: 'completed' })
    const first = committedChild(parent, {
      id: `installation_${'2'.repeat(24)}`,
      createdAt: '2026-08-02T00:00:00.000Z',
      installSpec: NEW_SPEC,
    })
    const second = committedChild(parent, {
      id: `installation_${'3'.repeat(24)}`,
      createdAt: '2026-08-03T00:00:00.000Z',
      installSpec: NEW_SPEC,
    })
    for (const item of [parent, first, second]) await store.put('installations', item)

    await expect(listCapabilityVersions({
      store,
      config: config(root),
      launcher: { profileDependencySpec: async () => NEW_SPEC } as unknown as DshLauncher,
    }, { packageName: 'dsh-tool-calculator' })).rejects.toMatchObject({
      code: 'command_failed',
      details: { stage: 'versions', ambiguousCount: 2 },
    })
  })

  it('rejects the whole version listing when a corrupt canonical same-spec child is unreadable', async () => {
    const { root, store } = await setup()
    const parent = installation({
      id: `installation_${'4'.repeat(24)}`,
      dshHome: config(root).dshHome,
      installPhase: 'completed',
    })
    await store.put('installations', parent)
    const corruptChildId = `installation_${'5'.repeat(24)}`
    await writeFile(path.join(store.root, 'installations', `${corruptChildId}.json`), JSON.stringify({
      schemaVersion: 1,
      id: corruptChildId,
      createdAt: '2026-08-31T00:00:00.000Z',
      targetProfile: parent.targetProfile,
      retention: parent.retention,
      dshHome: parent.dshHome,
      packageName: parent.packageName,
      predecessorInstallationId: parent.id,
      installSpec: parent.installSpec,
    }), 'utf8')
    const live = vi.fn(async () => parent.installSpec)

    await expect(listCapabilityVersions({
      store,
      config: config(root),
      launcher: { profileDependencySpec: live } as unknown as DshLauncher,
    }, { packageName: parent.packageName! })).rejects.toMatchObject({
      code: 'invalid_input',
      details: { diagnosticCount: 1 },
    })
    expect(live).not.toHaveBeenCalled()
  })

  it('requires a package identity', async () => {
    const { root, store } = await setup()
    const launcher = {} as unknown as DshLauncher
    await expect(listCapabilityVersions({ store, config: config(root), launcher }, {}))
      .rejects.toThrow(/package_name or an installation_id/i)
  })

  it('starts no store or live-profile reads when already cancelled', async () => {
    const { root, store } = await setup()
    const controller = new AbortController()
    const reason = new Error('versions pre-aborted')
    controller.abort(reason)
    const list = vi.spyOn(store, 'listInstallationsStrict')
    const live = vi.fn()

    await expect(listCapabilityVersions({
      store,
      config: config(root),
      launcher: { profileDependencySpec: live } as unknown as DshLauncher,
    }, { packageName: 'dsh-tool-calculator' }, controller.signal)).rejects.toBe(reason)
    expect(list).not.toHaveBeenCalled()
    expect(live).not.toHaveBeenCalled()
  })

  it.each(['throw', 'return'] as const)('preserves the exact abort when a live profile reader ignores cancellation and %s', async (mode) => {
    const { root, store } = await setup()
    await store.put('installations', installation({ id: `installation_${'a'.repeat(24)}` }))
    const controller = new AbortController()
    const reason = new Error(`versions reader abort ${mode}`)
    const live = vi.fn(async () => {
      controller.abort(reason)
      if (mode === 'throw') throw new Error('ordinary live read error')
      return OLD_SPEC
    })

    await expect(listCapabilityVersions({
      store,
      config: config(root),
      launcher: { profileDependencySpec: live } as unknown as DshLauncher,
    }, { packageName: 'dsh-tool-calculator' }, controller.signal)).rejects.toBe(reason)
    expect(live).toHaveBeenCalledTimes(1)
  })

  it('rejects an ordinary live profile read failure without exposing raw profile details', async () => {
    const { root, store } = await setup()
    await store.put('installations', installation({ id: `installation_${'b'.repeat(24)}` }))
    const raw = 'C:\\Users\\secret\\profile package spec'

    const failure = await listCapabilityVersions({
      store,
      config: config(root),
      launcher: { profileDependencySpec: async () => { throw new Error(raw) } } as unknown as DshLauncher,
    }, { packageName: 'dsh-tool-calculator' }).then(() => undefined, (error: unknown) => error)
    expect(failure).toMatchObject({ code: 'command_failed' })
    expect(failure).toBeInstanceOf(EvolutionError)
    expect((failure as Error).message).not.toContain(raw)
  })

  it('treats a successful undefined live spec as absent and reads each profile once', async () => {
    const { root, store } = await setup()
    const first = installation({ id: `installation_${'c'.repeat(24)}`, targetProfile: 'web' })
    const second = installation({ id: `installation_${'d'.repeat(24)}`, targetProfile: 'web', installSpec: NEW_SPEC })
    const third = installation({ id: `installation_${'e'.repeat(24)}`, targetProfile: 'desktop', installSpec: NEW_SPEC })
    await store.put('installations', first)
    await store.put('installations', second)
    await store.put('installations', third)
    const live = vi.fn(async (_dshHome: string, _profile: string, _packageName: string) => undefined)

    const result = await listCapabilityVersions({
      store,
      config: config(root),
      launcher: { profileDependencySpec: live } as unknown as DshLauncher,
    }, { packageName: 'dsh-tool-calculator' })
    expect(result.versions.every((item) => item.active === false)).toBe(true)
    expect(live).toHaveBeenCalledTimes(2)
    expect(live.mock.calls.map((call) => call[1]).sort()).toEqual(['desktop', 'web'])
  })

  it('forwards the exact tool execution signal into version listing', async () => {
    const listVersions = vi.fn(async () => ({ packageName: 'dsh-tool-calculator', versions: [] }))
    const service = { listVersions } as unknown as CapabilityEvolutionService
    const tool = createTools(service).find((item) => item.name === 'capability_versions')!
    const controller = new AbortController()
    const exec = execution(controller.signal)

    await tool.execute!({ package_name: 'dsh-tool-calculator' }, exec)
    expect(listVersions).toHaveBeenCalledWith({ packageName: 'dsh-tool-calculator' }, exec)
  })
})

describe('capability rollback', () => {
  async function rollbackDeps(options: { liveSpec?: string } = {}): Promise<{
    store: StateStore
    deps: VersionTrackingDeps
    currentId: string
    targetId: string
  }> {
    const { root, store, ctx } = await setup()
    const artifactRoot = path.join(root, 'review-artifacts', 'rollback')
    const artifactPath = path.join(artifactRoot, 'package', 'reviewed.tgz')
    const bytes = Buffer.from('rollback artifact')
    await mkdir(path.dirname(artifactPath), { recursive: true })
    await writeFile(artifactPath, bytes)
    const targetReview = attestedReview({
      installSpec: `file:${artifactPath.replaceAll('\\', '/')}`,
      artifact: { sha256: sha256(bytes), bytes: bytes.byteLength, entryCount: 1, ownedRoot: artifactRoot },
    })
    await store.put('reviews', targetReview)
    const targetId = `installation_${'1'.repeat(24)}`
    const currentId = `installation_${'2'.repeat(24)}`
    const dshHome = config(root).dshHome
    await store.put('installations', installation({
      id: targetId,
      dshHome,
      installPhase: 'completed',
      reviewId: targetReview.id,
      installSpec: targetReview.installSpec!,
      artifactSha256: sha256(bytes),
      supersededByInstallationId: currentId,
    }))
    await store.put('installations', installation({
      id: currentId,
      dshHome,
      installPhase: 'completed',
      createdAt: '2026-08-02T00:00:00.000Z',
      installSpec: NEW_SPEC,
      predecessorInstallationId: targetId,
      replacement: {
        state: 'new_present',
        oldSpecDigest: dependencySpecDigest(targetReview.installSpec!),
        newInstallSpec: NEW_SPEC,
        preparedAt: '2026-08-02T00:00:00.000Z',
        reconciledAt: '2026-08-02T00:01:00.000Z',
      },
    }))
    const launcher = {
      install: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
      profileTargetAbsent: async () => false,
      profileDependencySpec: async () => options.liveSpec ?? NEW_SPEC,
      profileSourceMatches: async (_home: string, _profile: string, _name: string, spec: string) => spec === targetReview.installSpec,
      verifyHost: async () => hostPassedEvidence,
      readInstalledVerificationFixtures: async () => ({ calculator: { arguments: { expression: '1+1' } } }),
    } as unknown as DshLauncher
    const installer = new PluginInstaller(
      ctx, config(root), store, launcher, async () => true, undefined, async () => ({
        evidence: { attempted: true, loaded: false, method: 'unsupported', reason: 'rollback requires restart' },
      }),
      undefined,
      'autoevo-verify',
    )
    return {
      store,
      currentId,
      targetId,
      deps: { store, config: config(root), launcher, createRollbackInstaller: () => installer },
    }
  }

  it('reinstalls the predecessor through the standard installer and links the lineage', async () => {
    const { store, deps, currentId, targetId } = await rollbackDeps()
    const result = await rollbackInstallation(deps, { installationId: currentId }, execution())
    expect(result.installSpec).toMatch(/^file:/u)
    expect(result.reviewId).toBe(`review_${'a'.repeat(64)}`)
    expect(result.predecessorInstallationId).toBe(currentId)
    expect(result.replacement?.state).toBe('new_present')
    expect((await store.getInstallation(currentId)).supersededByInstallationId).toBeUndefined()
    const chain = await listCapabilityVersions(deps, { packageName: 'dsh-tool-calculator' })
    expect(chain.versions.map((item) => item.installationId)).toEqual([targetId, currentId, result.id])
  })

  it.each([
    ['missing', undefined],
    ['wrong', `installation_${'9'.repeat(24)}`],
  ])('rolls back through the canonical child edge when the raw parent forward link is %s', async (_label, forward) => {
    const { store, deps, currentId, targetId } = await rollbackDeps()
    const target = await store.getInstallation(targetId)
    if (forward) target.supersededByInstallationId = forward
    else delete target.supersededByInstallationId
    await store.put('installations', target)

    const result = await rollbackInstallation(deps, { installationId: currentId }, execution())

    expect(result.predecessorInstallationId).toBe(currentId)
  })

  it.each(['self', 'descendant', 'sibling'] as const)('rejects an explicit %s rollback target before creating an installer', async (relation) => {
    const { store, deps, currentId, targetId } = await rollbackDeps()
    const current = await store.getInstallation(currentId)
    let targetInstallationId = currentId
    if (relation === 'descendant') {
      const descendant = committedChild(current, {
        id: `installation_${'3'.repeat(24)}`,
        createdAt: '2026-08-03T00:00:00.000Z',
        installSpec: `github:acme/calculator#${'e'.repeat(40)}`,
      })
      await store.put('installations', descendant)
      targetInstallationId = descendant.id
    } else if (relation === 'sibling') {
      const parent = await store.getInstallation(targetId)
      const sibling = committedChild(parent, {
        id: `installation_${'3'.repeat(24)}`,
        createdAt: '2026-08-03T00:00:00.000Z',
        installSpec: `github:acme/calculator#${'e'.repeat(40)}`,
      })
      await store.put('installations', sibling)
      targetInstallationId = sibling.id
    }
    const createRollbackInstaller = vi.fn(deps.createRollbackInstaller)

    await expect(rollbackInstallation(
      { ...deps, createRollbackInstaller },
      { installationId: currentId, targetInstallationId },
      execution(),
    )).rejects.toThrow(/not an ancestor/i)
    expect(createRollbackInstaller).not.toHaveBeenCalled()
  })

  it('rejects a stale foreign-home current receipt before live reads or installer creation', async () => {
    const { store, deps, currentId } = await rollbackDeps()
    const current = await store.getInstallation(currentId)
    await store.put('installations', { ...current, dshHome: path.join(current.dshHome, 'foreign') })
    const live = vi.fn(deps.launcher.profileDependencySpec!.bind(deps.launcher))
    const createRollbackInstaller = vi.fn(deps.createRollbackInstaller)

    await expect(rollbackInstallation({
      ...deps,
      launcher: { ...deps.launcher, profileDependencySpec: live } as unknown as DshLauncher,
      createRollbackInstaller,
    }, { installationId: currentId }, execution())).rejects.toThrow(/different DSH home/i)
    expect(live).not.toHaveBeenCalled()
    expect(createRollbackInstaller).not.toHaveBeenCalled()
  })

  it('rejects stale A but accepts canonical C in an A(S)-B(T)-C(S) chain', async () => {
    const { store, deps, currentId, targetId } = await rollbackDeps()
    const first = await store.getInstallation(targetId)
    const second = await store.getInstallation(currentId)
    const third = committedChild(second, {
      id: `installation_${'3'.repeat(24)}`,
      createdAt: '2026-08-03T00:00:00.000Z',
      installSpec: first.installSpec,
    })
    await store.put('installations', third)
    const live = vi.fn(async () => first.installSpec)
    const mutableLauncher = deps.launcher as unknown as { profileDependencySpec: typeof live }
    mutableLauncher.profileDependencySpec = live
    const createRollbackInstaller = vi.fn(deps.createRollbackInstaller)

    await expect(rollbackInstallation(
      { ...deps, createRollbackInstaller },
      { installationId: first.id, targetInstallationId: first.id },
      execution(),
    )).rejects.toThrow(/not an ancestor/i)
    expect(createRollbackInstaller).not.toHaveBeenCalled()

    const result = await rollbackInstallation(
      deps,
      { installationId: third.id, targetInstallationId: first.id },
      execution(),
    )
    expect(result.predecessorInstallationId).toBe(third.id)
  })

  it('rejects rollback before live reads or installer creation when a canonical same-spec child is corrupt', async () => {
    const { store, deps, currentId } = await rollbackDeps()
    const current = await store.getInstallation(currentId)
    const corruptChildId = `installation_${'6'.repeat(24)}`
    await writeFile(path.join(store.root, 'installations', `${corruptChildId}.json`), JSON.stringify({
      schemaVersion: 1,
      id: corruptChildId,
      createdAt: '2026-08-31T00:00:00.000Z',
      targetProfile: current.targetProfile,
      retention: current.retention,
      dshHome: current.dshHome,
      packageName: current.packageName,
      predecessorInstallationId: current.id,
      installSpec: current.installSpec,
    }), 'utf8')
    const live = vi.fn(async () => current.installSpec)
    const createRollbackInstaller = vi.fn(deps.createRollbackInstaller)

    await expect(rollbackInstallation({
      ...deps,
      launcher: { ...deps.launcher, profileDependencySpec: live } as unknown as DshLauncher,
      createRollbackInstaller,
    }, { installationId: currentId }, execution())).rejects.toMatchObject({
      code: 'invalid_input',
      details: { diagnosticCount: 1 },
    })
    expect(live).not.toHaveBeenCalled()
    expect(createRollbackInstaller).not.toHaveBeenCalled()
  })

  it('fails closed when the target has no linked review', async () => {
    const { store, deps, currentId, targetId } = await rollbackDeps()
    const target = await store.getInstallation(targetId)
    delete target.reviewId
    await store.put('installations', { ...target, origin: 'adopted' })
    await expect(rollbackInstallation(deps, { installationId: currentId }, execution()))
      .rejects.toThrow(/no linked review/i)
  })

  it('fails closed when the target artifact is gone', async () => {
    const { deps, currentId, targetId, store } = await rollbackDeps()
    const target = await store.getInstallation(targetId)
    await rm(target.installSpec.slice('file:'.length))
    await expect(rollbackInstallation(deps, { installationId: currentId }, execution()))
      .rejects.toThrow(/artifact is no longer available/i)
  })

  it('fails closed when the live profile spec drifted from the current receipt', async () => {
    const { deps, currentId } = await rollbackDeps({ liveSpec: OLD_SPEC })
    await expect(rollbackInstallation(deps, { installationId: currentId }, execution()))
      .rejects.toThrow(/does not match the given current installation/i)
  })

  it('refuses rollback before creating an installer when the target receipt drifted from its linked frozen review', async () => {
    const { store, deps, currentId, targetId } = await rollbackDeps()
    const target = await store.getInstallation(targetId)
    const linked = await store.getReview(target.reviewId!)
    const driftRoot = path.join(path.dirname(linked.artifact!.ownedRoot), 'rollback-drift')
    const driftPath = path.join(driftRoot, 'package', 'different.tgz')
    const driftBytes = Buffer.from('different rollback artifact')
    await mkdir(path.dirname(driftPath), { recursive: true })
    await writeFile(driftPath, driftBytes)
    await store.put('reviews', {
      ...linked,
      installSpec: `file:${driftPath.replaceAll('\\', '/')}`,
      artifact: {
        sha256: sha256(driftBytes),
        bytes: driftBytes.byteLength,
        entryCount: linked.inspectedFiles.length,
        ownedRoot: driftRoot,
      },
    })
    const createRollbackInstaller = vi.fn(deps.createRollbackInstaller)

    await expect(rollbackInstallation(
      { ...deps, createRollbackInstaller },
      { installationId: currentId },
      execution(),
    )).rejects.toMatchObject({ code: 'review_rejected' })
    expect(createRollbackInstaller).not.toHaveBeenCalled()
  })

  it('preserves exact cancellation when the live rollback source read aborts', async () => {
    const { deps, currentId } = await rollbackDeps()
    const controller = new AbortController()
    const reason = new Error('rollback live source cancelled')
    const createRollbackInstaller = vi.fn(deps.createRollbackInstaller)
    const launcher = {
      ...deps.launcher,
      profileDependencySpec: async () => {
        controller.abort(reason)
        throw new Error('read interrupted')
      },
    } as unknown as DshLauncher

    await expect(rollbackInstallation(
      { ...deps, launcher, createRollbackInstaller },
      { installationId: currentId },
      execution(controller.signal),
    )).rejects.toBe(reason)
    expect(createRollbackInstaller).not.toHaveBeenCalled()
  })

  it('requires an existing predecessor when no target is given', async () => {
    const { store, deps, currentId } = await rollbackDeps()
    const current = await store.getInstallation(currentId)
    delete current.predecessorInstallationId
    await store.put('installations', current)
    await expect(rollbackInstallation(deps, { installationId: currentId }, execution()))
      .rejects.toThrow(/no predecessor/i)
  })
})
