import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { testReview } from '../helpers/records.js'
import { testRuntimeConfig } from '../helpers/runtime-config.js'
import { trackTempDirs } from '../helpers/temp-dirs.js'
import type { RuntimeConfig } from '../../src/config.js'
import type { InstallationRecord, ReviewRecord, VerificationEvidence } from '../../src/contracts.js'
import { PluginInstaller } from '../../src/lifecycle/install.js'
import type { DshLauncher } from '../../src/lifecycle/launcher.js'
import {
  listCapabilityVersions,
  rollbackInstallation,
  versionChain,
  type VersionTrackingDeps,
} from '../../src/service-versions.js'
import { StateStore } from '../../src/state/store.js'
import { sha256 } from '../../src/state/hashes.js'

const temporary = trackTempDirs()

const OLD_SPEC = `github:acme/calculator#${'c'.repeat(40)}`
const NEW_SPEC = `github:acme/calculator#${'d'.repeat(40)}`

function config(root: string): RuntimeConfig {
  return testRuntimeConfig(root, { dshHome: path.join(root, 'persistent-dsh-home') })
}

function execution(): ToolRunContext {
  return {
    callId: 'call-1',
    agent: { session: { header: { cwd: process.cwd() } } },
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
  return {
    schemaVersion: 1,
    createdAt: '2026-08-01T00:00:00.000Z',
    reviewId: `review_${'a'.repeat(64)}`,
    targetProfile: 'web',
    retention: 'persistent',
    dshHome: 'persistent-dsh-home',
    packageName: 'dsh-tool-calculator',
    installSpec: OLD_SPEC,
    installState: 'installed',
    installOutcome: 'verified',
    installed: true,
    loaded: true,
    verified: true,
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
    const current = installation({
      id: `installation_${'2'.repeat(24)}`,
      createdAt: '2026-08-02T00:00:00.000Z',
      installSpec: NEW_SPEC,
      predecessorInstallationId: oldRecord.id,
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

  it('requires a package identity', async () => {
    const { root, store } = await setup()
    const launcher = {} as unknown as DshLauncher
    await expect(listCapabilityVersions({ store, config: config(root), launcher }, {}))
      .rejects.toThrow(/package_name or an installation_id/i)
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
    await store.put('installations', installation({
      id: targetId,
      reviewId: targetReview.id,
      installSpec: targetReview.installSpec!,
      supersededByInstallationId: currentId,
    }))
    await store.put('installations', installation({
      id: currentId,
      createdAt: '2026-08-02T00:00:00.000Z',
      installSpec: NEW_SPEC,
      predecessorInstallationId: targetId,
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
    expect((await store.getInstallation(currentId)).supersededByInstallationId).toBe(result.id)
    const chain = await listCapabilityVersions(deps, { packageName: 'dsh-tool-calculator' })
    expect(chain.versions.map((item) => item.installationId)).toEqual([targetId, currentId, result.id])
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
    await store.put('installations', { ...target, installSpec: 'file:/missing/artifact.tgz' })
    await expect(rollbackInstallation(deps, { installationId: currentId }, execution()))
      .rejects.toThrow(/artifact is no longer available/i)
  })

  it('fails closed when the live profile spec drifted from the current receipt', async () => {
    const { deps, currentId } = await rollbackDeps({ liveSpec: OLD_SPEC })
    await expect(rollbackInstallation(deps, { installationId: currentId }, execution()))
      .rejects.toThrow(/does not match the given current installation/i)
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
