import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { trackTempDirs } from '../helpers/temp-dirs.js'
import {
  POLICY_VERSION,
  type CandidateAvailability,
  type EvolutionTargetKind,
  type InstallationRecord,
  type LocalCapabilityCandidate,
  type ResolutionRecord,
  type ReviewRecord,
} from '../../src/contracts.js'
import { CreationGuard } from '../../src/creation-guard.js'
import { EvolutionError } from '../../src/errors.js'
import { StateStore } from '../../src/state/store.js'
import { candidateSnapshotFor, DISCOVERY_POOL_MAX } from '../../src/workflow/candidates.js'
import { WorkflowEngine } from '../../src/workflow/engine.js'
import type { WorkflowHost, WorkflowRecord, WorkflowView } from '../../src/workflow/contracts.js'

const temporary = trackTempDirs()

function exec(sessionId = 'session-1', cwd = process.cwd()): ToolRunContext {
  return {
    callId: 'call-1',
    rootCallId: 'call-1',
    token: Symbol('call-1'),
    signal: new AbortController().signal,
    agent: {
      id: sessionId,
      session: { header: { id: sessionId, cwd, version: 0, createdAt: 0 } },
    },
  } as unknown as ToolRunContext
}

function resolution(requirement = 'calculator'): ResolutionRecord {
  const id = `resolution_${'b'.repeat(24)}`
  return {
    schemaVersion: 2,
    id,
    policyVersion: POLICY_VERSION,
    createdAt: '2026-08-17T00:00:00.000Z',
    requirement,
    cwd: 'C:/workspace',
    decision: 'use_local',
    localCandidates: [{
      kind: 'tool',
      name: 'pwsh',
      description: 'Run a PowerShell command',
      availability: 'available',
      confidence: 0.9,
      fit: 'full',
    }],
    remoteCandidates: [],
    remoteDiscoveryComplete: true,
    authorization: { state: 'selection_required', resolutionId: id, reason: 'wait' },
    queries: [],
    reasons: ['local hit'],
  }
}

it('preserves all 105 bounded remote candidates alongside local discovery evidence', () => {
  const record = resolution('find a plugin')
  record.localCandidates[0]!.fit = 'partial'
  record.remoteCandidates = Array.from({ length: 105 }, (_, index) => ({
    repository: `remote-org/plugin-${index}`,
    name: `plugin-${index}`,
    description: 'remote candidate',
    stars: index,
    updatedAt: null,
    topics: ['dsh-plugin'],
  }))

  const snapshot = candidateSnapshotFor(record, new Set(), DISCOVERY_POOL_MAX)

  expect(snapshot.filter((candidate) => candidate.kind === 'local')).toHaveLength(1)
  expect(snapshot.filter((candidate) => candidate.kind === 'remote')).toHaveLength(105)
  expect(snapshot).toHaveLength(106)
})

function host(store: StateStore, record: ResolutionRecord): WorkflowHost {
  return {
    async bootstrapResolution(requirement) {
      const next = { ...record, requirement }
      await store.put('resolutions', next)
      return next
    },
    async discoverRemote(current) {
      return current
    },
    async ensureMarket(current) {
      return { resolution: current, market: { status: 'empty', reason: 'none' } }
    },
    async reviewGithub() {
      throw new Error('not used')
    },
    async reviewLocal() {
      throw new Error('not used')
    },
    async installReviewed() {
      throw new Error('not used')
    },
    async applyDecision(current) {
      return current
    },
    async applyNavigation(current, navigation) {
      const next = {
        ...current,
        authorization: {
          state: navigation.kind === 'stop' ? 'stopped' as const : current.authorization!.state,
          resolutionId: current.id,
          reason: navigation.kind,
        },
      }
      await store.put('resolutions', next)
      return next
    },
    async latestReview() {
      return undefined
    },
    async enableTargetProfile() {
      return 'web'
    },
    enableBuiltin: vi.fn(async () => {}),
    getResolution(id) {
      return store.getResolution(id)
    },
    getReview(id) {
      return store.getReview(id)
    },
    getInstallation(id) {
      return store.getInstallation(id)
    },
  }
}

async function startAndPresent(
  engine: WorkflowEngine,
  requirement: string,
  turn: ToolRunContext,
  count = 1,
): Promise<{ discovery: WorkflowView; selection: WorkflowView }> {
  const discovery = await engine.start(requirement, turn)
  const candidateIds = discovery.workflow.discoveryPool!.slice(0, count).map((item) => item.id)
  const selection = await engine.present({ workflowId: discovery.workflow.id, candidateIds }, turn)
  return { discovery, selection }
}

async function makeEngine(record: ResolutionRecord, suffix: string): Promise<{
  root: string
  store: StateStore
  guard: CreationGuard
  workflowHost: WorkflowHost
  engine: WorkflowEngine
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), `autoevo-engine-${suffix}-`))
  temporary.push(root)
  const store = new StateStore(root)
  const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_engine' })
  const workflowHost = host(store, record)
  const engine = new WorkflowEngine(store, guard, workflowHost)
  return { root, store, guard, workflowHost, engine }
}

function installedPluginCandidate(
  name: string,
  repository: string,
  commit: string,
  options: {
    kind?: EvolutionTargetKind
    description?: string
    availability?: CandidateAvailability
    reuseEligible?: boolean
    profileEvidence?: boolean
    specDigest?: string
  } = {},
): LocalCapabilityCandidate {
  const dependencySpec = `github:${repository}#${commit}`
  return {
    kind: 'plugin',
    name,
    description: options.description ?? name,
    availability: options.availability ?? 'installed_in_profile',
    confidence: 0.99,
    semanticFit: 'full',
    fit: 'partial',
    surfaceMatch: true,
    reuseEligible: options.reuseEligible ?? true,
    evolutionTarget: {
      kind: options.kind ?? 'github_exact',
      repository,
      commit,
      packageName: name,
      profile: 'web',
      dependencySpec,
      specDigest: options.specDigest ?? 'd'.repeat(64),
    },
    ...(options.profileEvidence ?? true
      ? {
        profileEvidence: {
          source: 'host_profile_manifest' as const,
          profile: 'web',
          packageName: name,
          dependencySpec,
          configuredBundle: true,
        },
      }
      : {}),
  }
}

async function reviewInstalledCandidate(
  engine: WorkflowEngine,
  guard: CreationGuard,
  turn: ToolRunContext,
  requirement: string,
  message: string,
): Promise<{
  selection: WorkflowView
  candidateId: string
  reviewed: Awaited<ReturnType<WorkflowEngine['resume']>>
}> {
  const { selection } = await startAndPresent(engine, requirement, turn)
  const candidateId = selection.workflow.candidateSnapshot![0]!.id
  guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: message }] })
  const reviewed = await engine.resume({
    workflowId: selection.workflow.id,
    interruptId: selection.workflow.interrupt!.interruptId,
    navigation: { kind: 'review_existing', candidateIds: [candidateId] },
  }, turn)
  return { selection, candidateId, reviewed }
}

describe('workflow engine autonomous discovery', () => {
  it('starts at a model-controlled discovery checkpoint without an interrupt or candidate snapshot', async () => {
    const { store, engine } = await makeEngine(resolution(), 'discovery')

    const view = await engine.start('run a PowerShell command', exec())

    expect(view.workflow).toMatchObject({ status: 'interrupted', cursor: 'await_discovery', generation: 1 })
    expect(view.workflow.interrupt).toBeUndefined()
    expect(view.workflow.candidateSnapshot).toBeUndefined()
    expect(view.workflow.discoveryPool).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'local', localName: 'pwsh', fit: 'full' }),
    ]))
    expect(view.workflow.discoveryBudget).toEqual({
      refinementRoundsUsed: 0,
      refinementQueriesUsed: [],
      explicitRepositories: [],
      activeTurnId: 'turn_unknown',
      activeTurnQueriesUsed: [],
      maxQueriesPerTurn: 5,
      maxCandidates: 113,
    })
    expect((await store.getWorkflow(view.workflow.id)).resolutionId).toBe(resolution().id)
  })

  it('keeps model-planned baseline queries separate from the Host-captured requirement', async () => {
    const record = resolution('summary only')
    record.decision = 'none'
    record.localCandidates[0] = { ...record.localCandidates[0]!, fit: 'partial' }
    record.remoteDiscoveryComplete = false
    const { guard, workflowHost, engine } = await makeEngine(record, 'baseline-queries')
    const discoverRemote = vi.fn(async (current: ResolutionRecord) => current)
    workflowHost.discoverRemote = discoverRemote
    const turn = exec('session-baseline-queries')
    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: '我需要一个自动审批代码审查的能力' }] })

    const view = await engine.start(
      'automatic approval review',
      turn,
      { operation: 'discover_or_reuse', requiredSurface: 'native_dsh_plugin' },
      undefined,
      [' auto review ', 'automatic approval', 'auto review'],
    )

    expect(view.workflow.requirement).toBe('我需要一个自动审批代码审查的能力')
    expect(view.workflow.searchRequirement).toBe('我需要一个自动审批代码审查的能力')
    expect(view.workflow.discoveryQueries).toEqual(['auto review', 'automatic approval'])
    expect(view.workflow.discoveryBudget).toBeUndefined()
    expect(discoverRemote).toHaveBeenCalledWith(expect.anything(), turn, {
      queries: ['auto review', 'automatic approval'],
    })
  })

  it('rejects invalid baseline query plans before starting discovery', async () => {
    const { workflowHost, engine } = await makeEngine(resolution(), 'baseline-query-invalid')
    const bootstrap = vi.spyOn(workflowHost, 'bootstrapResolution')
    await expect(engine.start(
      'calculator',
      exec(),
      undefined,
      undefined,
      ['one', 'two', 'three', 'four', 'five', 'six'],
    )).rejects.toThrow(/at most five .*queries/i)
    await expect(engine.start(
      'calculator',
      exec(),
      undefined,
      undefined,
      ['codex approve for me auto approval agent permissions'],
    )).rejects.toThrow(/one or two exact search terms/i)
    expect(bootstrap).not.toHaveBeenCalled()
  })

  it('binds profile install/configuration evidence into local candidate snapshots', async () => {
    const record = resolution('@dsh-external/dsh-conv-export')
    record.localCandidates[0] = {
      kind: 'plugin',
      name: '@dsh-external/dsh-conv-export',
      description: 'client conversation export',
      availability: 'installed_in_profile',
      confidence: 0.99,
      fit: 'full',
      profileEvidence: {
        source: 'host_profile_manifest',
        profile: 'web',
        packageName: '@dsh-external/dsh-conv-export',
        dependencySpec: 'workspace:*',
        configuredBundle: true,
      },
    }
    const { engine } = await makeEngine(record, 'profile-evidence')
    const view = await engine.start(record.requirement, exec())
    const candidate = view.workflow.discoveryPool![0]!
    expect(candidate.installation).toEqual({
      source: 'host_profile_manifest',
      profile: 'web',
      package_name: '@dsh-external/dsh-conv-export',
      dependency_spec: 'workspace:*',
      configured_bundle: true,
    })

    const changed = { ...record, localCandidates: [{
      ...record.localCandidates[0]!,
      profileEvidence: { ...record.localCandidates[0]!.profileEvidence!, configuredBundle: false },
    }] }
    const { engine: second } = await makeEngine(changed, 'profile-digest')
    const changedView = await second.start(changed.requirement, exec('session-2'))
    expect(changedView.workflow.discoveryPool![0]!.digest).not.toBe(candidate.digest)
  })

  it('present seals one to five pool candidates into Gate 1 and blocks same-turn resume', async () => {
    const { engine } = await makeEngine(resolution(), 'present')
    const turn = exec()
    const { discovery, selection } = await startAndPresent(engine, 'calculator', turn)

    expect(selection.workflow).toMatchObject({ status: 'interrupted', cursor: 'await_selection' })
    expect(selection.workflow.interrupt?.kind).toBe('await_selection')
    expect(selection.workflow.candidateSnapshot?.map((item) => item.id)).toEqual([
      discovery.workflow.discoveryPool![0]!.id,
    ])
    const parked = await engine.resume({
      workflowId: selection.workflow.id,
      interruptId: selection.workflow.interrupt!.interruptId,
      navigation: { kind: 'stop' },
    }, turn)
    expect(parked).toMatchObject({ status: 'parked', alreadyWaiting: true })
    expect(parked.workflow.consumedInterruptIds).toEqual([])
  })

  it('previews only the Agent-selected remote shortlist before sealing Gate 1', async () => {
    const record = resolution('automatic approval review')
    record.decision = 'inspect_remote'
    record.localCandidates = []
    record.remoteCandidates = [{
      repository: 'PerryLink/dsh-auto-review', name: 'dsh-auto-review', description: 'Second-model review',
      stars: 112, updatedAt: '2026-08-26T20:21:54Z', topics: ['dsh-plugin', 'auto-review'], defaultBranch: 'main',
    }]
    const { workflowHost, engine } = await makeEngine(record, 'present-preview')
    const previewGithubCandidates: NonNullable<WorkflowHost['previewGithubCandidates']> = vi.fn(async (
      _resolution: Parameters<NonNullable<WorkflowHost['previewGithubCandidates']>>[0],
      candidates: Parameters<NonNullable<WorkflowHost['previewGithubCandidates']>>[1],
    ) => ({
      previews: candidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        repository: candidate.repository,
        commit: 'a'.repeat(40),
        defaultBranch: 'main',
        inspectedFiles: [{ path: 'package.json', sha256: 'b'.repeat(64), bytes: 200 }],
        truncated: false,
        manifest: { kind: 'bundle' as const, packageName: 'dsh-auto-review', packageVersion: '0.7.0' },
        packageSummary: { description: 'Second-model review', keywords: ['auto-review'] },
      })),
      failures: [],
    }))
    workflowHost.previewGithubCandidates = previewGithubCandidates
    const turn = exec('session-present-preview')
    const discovery = await engine.start(record.requirement, turn)
    const candidate = discovery.workflow.discoveryPool!.find((item) => item.repository === 'PerryLink/dsh-auto-review')!
    const selection = await engine.present({ workflowId: discovery.workflow.id, candidateIds: [candidate.id] }, turn)

    expect(previewGithubCandidates).toHaveBeenCalledWith(expect.anything(), [{
      candidateId: candidate.id,
      repository: 'PerryLink/dsh-auto-review',
    }], turn)
    expect(selection.workflow.candidatePreviews?.[candidate.id]).toMatchObject({
      repository: 'PerryLink/dsh-auto-review', commit: 'a'.repeat(40), manifest: { packageName: 'dsh-auto-review' },
    })
    expect(selection.workflow.candidateSnapshot?.map((item) => item.id)).toEqual([candidate.id])
  })

  it('seals a zero-candidate result and accepts only a later fresh create decision', async () => {
    const record = resolution('lunar calendar conversion')
    const { root, guard, workflowHost, engine } = await makeEngine(record, 'present-empty')
    workflowHost.prepareCreate = async (current, _exec, workflow) => {
      const sourceRoot = path.join(root, 'managed-lunar-calendar')
      workflow.pendingPath = sourceRoot
      workflow.managedSourceId = 'managed-lunar-calendar'
      return { resolution: current, path: sourceRoot }
    }
    const turn = exec('session-present-empty', root)
    const discovery = await engine.start('lunar calendar conversion', turn)
    expect(discovery.workflow.discoveryPool?.length).toBeGreaterThan(0)

    const empty = await engine.present({
      workflowId: discovery.workflow.id,
      candidateIds: [],
    }, turn)

    expect(empty.workflow).toMatchObject({
      status: 'interrupted',
      cursor: 'await_selection',
      candidateSnapshot: [],
    })
    expect(empty.workflow.interrupt?.options.map((option) => option.id)).toEqual([
      'search_more',
      'create_new',
      'stop',
    ])

    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: '从零创建这个能力' }] })
    const constructing = await engine.resume({
      workflowId: empty.workflow.id,
      interruptId: empty.workflow.interrupt!.interruptId,
      decision: { action: 'create_new' },
    }, turn)

    expect(constructing.workflow).toMatchObject({
      status: 'interrupted',
      cursor: 'await_modify_work',
      pendingPath: path.join(root, 'managed-lunar-calendar'),
    })
    expect(guard.constructionRoot(turn.agent)).toBe(path.join(root, 'managed-lunar-calendar'))
  })

  it('automatically seals a completed empty discovery without requiring a presentation call', async () => {
    const record = resolution('unfamiliar capability')
    record.decision = 'inspect_remote'
    record.localCandidates = []
    record.remoteCandidates = []
    record.remoteDiscoveryComplete = true
    const { engine } = await makeEngine(record, 'auto-empty')
    const view = await engine.start(record.requirement, exec())

    expect(view.workflow).toMatchObject({ status: 'interrupted', cursor: 'await_selection', candidateSnapshot: [] })
    expect(view.workflow.interrupt?.options.map((option) => option.id)).toEqual([
      'search_more',
      'create_new',
      'stop',
    ])
  })

  it('rejects oversized presentations, duplicate ids, and candidates outside the discovery pool', async () => {
    const { store, engine } = await makeEngine(resolution(), 'present-invalid')
    const discovery = await engine.start('calculator', exec())
    const id = discovery.workflow.discoveryPool![0]!.id

    await expect(engine.present({
      workflowId: discovery.workflow.id,
      candidateIds: Array.from({ length: 6 }, (_, index) => `candidate_${String(index).padStart(24, '0')}`),
    }, exec())).rejects.toThrow(/zero to five/i)
    await expect(engine.present({ workflowId: discovery.workflow.id, candidateIds: [id, id] }, exec())).rejects.toThrow(/unique/i)
    await expect(engine.present({ workflowId: discovery.workflow.id, candidateIds: [`candidate_${'f'.repeat(24)}`] }, exec())).rejects.toThrow(/discovery pool/i)
    expect((await store.getWorkflow(discovery.workflow.id)).cursor).toBe('await_discovery')
  })

  it('refines only at discovery and records history without a workflow-wide round cap', async () => {
    const record = resolution()
    record.decision = 'inspect_remote'
    const { store, workflowHost, engine } = await makeEngine(record, 'refine')
    const refineRemote = vi.fn(async (current: ResolutionRecord, input: { queries: string[]; repositories: string[] }) => {
      const next = {
        ...current,
        queries: [...current.queries, ...input.queries],
        remoteCandidates: [{ repository: `acme/${input.queries[0] ?? input.repositories[0]}`, name: 'remote', description: '', stars: 1, updatedAt: null, topics: [] }],
      }
      await store.put('resolutions', next)
      return next
    })
    workflowHost.refineRemote = refineRemote
    const turn = exec()
    const started = await engine.start('calculator', turn)
    const first = await engine.refine({ workflowId: started.workflow.id, queries: ['calculator plugin'] }, turn)
    const second = await engine.refine({ workflowId: started.workflow.id, repositories: ['acme/calculator'] }, turn)
    const third = await engine.refine({ workflowId: first.workflow.id, queries: ['one more'] }, turn)

    expect(refineRemote).toHaveBeenCalledTimes(3)
    expect(third.workflow).toMatchObject({ cursor: 'await_discovery', status: 'interrupted' })
    expect(third.workflow.discoveryBudget).toMatchObject({
      refinementRoundsUsed: 3,
      refinementQueriesUsed: ['calculator plugin', 'one more'],
      explicitRepositories: ['acme/calculator'],
      activeTurnQueriesUsed: ['calculator plugin', 'one more'],
      maxQueriesPerTurn: 5,
    })
    expect(second.workflow.discoveryPool).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'remote' })]))
  })

  it('enforces the five-query discovery budget before calling the Host', async () => {
    const { workflowHost, engine } = await makeEngine(resolution(), 'query-budget')
    const refineRemote = vi.fn(async (current: ResolutionRecord) => current)
    workflowHost.refineRemote = refineRemote
    const started = await engine.start('calculator', exec())

    await engine.refine({ workflowId: started.workflow.id, queries: ['one', 'two', 'three', 'four', 'five'] }, exec())
    await expect(engine.refine({ workflowId: started.workflow.id, queries: ['six'] }, exec())).rejects.toThrow(/query budget/i)
    expect(refineRemote).toHaveBeenCalledTimes(1)
  })

  it('replenishes five queries after a fresh user request to continue searching', async () => {
    const record = resolution()
    record.localCandidates[0] = { ...record.localCandidates[0]!, fit: 'partial' }
    record.remoteDiscoveryComplete = false
    const { guard, workflowHost, engine } = await makeEngine(record, 'exhausted-empty')
    const refineRemote = vi.fn(async (current: ResolutionRecord) => current)
    workflowHost.refineRemote = refineRemote
    const turn = exec()
    const started = await engine.start('calculator', turn)

    await engine.refine({ workflowId: started.workflow.id, queries: ['first', 'second'] }, turn)
    const exhausted = await engine.refine({ workflowId: started.workflow.id, queries: ['third', 'fourth', 'fifth'] }, turn)

    expect(exhausted.workflow).toMatchObject({ cursor: 'await_confirmation', status: 'interrupted' })
    expect(exhausted.workflow.candidateSnapshot).toEqual([])
    expect(exhausted.workflow.interrupt?.options.map((option) => option.id)).toEqual(['search_more', 'stop'])
    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: '扩大范围，再继续找一轮' }] })

    const continued = await engine.resume({
      workflowId: exhausted.workflow.id,
      interruptId: exhausted.workflow.interrupt!.interruptId,
      navigation: { kind: 'search_more', queries: ['sixth', 'seventh', 'eighth', 'ninth', 'tenth'] },
    }, turn)

    expect(continued.workflow).toMatchObject({ cursor: 'await_confirmation', status: 'interrupted' })
    expect(continued.workflow.discoveryBudget).toMatchObject({
      refinementRoundsUsed: 3,
      refinementQueriesUsed: ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'],
      activeTurnQueriesUsed: ['sixth', 'seventh', 'eighth', 'ninth', 'tenth'],
      maxQueriesPerTurn: 5,
    })
  })

  it('returns search_more from Gate 1 to autonomous discovery without retaining the sealed snapshot', async () => {
    const record = resolution()
    record.decision = 'inspect_remote'
    record.remoteCandidates = [
      { repository: 'acme/one', name: 'one', description: '', stars: 2, updatedAt: null, topics: [] },
      { repository: 'acme/two', name: 'two', description: '', stars: 1, updatedAt: null, topics: [] },
    ]
    const { guard, engine } = await makeEngine(record, 'search-more')
    const turn = exec()
    const { selection } = await startAndPresent(engine, 'calculator', turn, 2)
    const firstIds = selection.workflow.candidateSnapshot!.map((item) => item.id)
    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: '再找找' }] })

    const more = await engine.resume({
      workflowId: selection.workflow.id,
      interruptId: selection.workflow.interrupt!.interruptId,
      navigation: { kind: 'search_more' },
    }, turn)

    expect(more.workflow).toMatchObject({ status: 'interrupted', cursor: 'await_discovery' })
    expect(more.workflow.interrupt).toBeUndefined()
    expect(more.workflow.candidateSnapshot).toBeUndefined()
    expect(more.workflow.seenCandidateIds).toEqual(expect.arrayContaining(firstIds))
    expect(more.workflow.rejectedCandidateIds).toEqual(expect.arrayContaining(firstIds))
  })

  it('refines search_more with fresh terms and an exact GitHub root before consuming the turn', async () => {
    const record = resolution('review capability')
    record.decision = 'inspect_remote'
    record.remoteCandidates = [
      { repository: 'acme/old-review', name: 'old-review', description: '', stars: 1, updatedAt: null, topics: [] },
    ]
    const { store, guard, workflowHost, engine } = await makeEngine(record, 'search-more-hints')
    const refineRemote = vi.fn(async (current: ResolutionRecord, input: { queries: string[]; repositories: string[] }) => {
      const next = {
        ...current,
        queries: [...current.queries, ...input.queries],
        remoteCandidates: [
          ...current.remoteCandidates,
          { repository: input.repositories[0]!, name: 'dsh-auto-review', description: 'Auto review approvals', stars: 3, updatedAt: null, topics: ['dsh-plugin'] },
        ],
      }
      await store.put('resolutions', next)
      return next
    })
    workflowHost.refineRemote = refineRemote
    const turn = exec()
    const { selection } = await startAndPresent(engine, 'review capability', turn)
    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: 'https://github.com/PerryLink/dsh-auto-review' }] })

    const more = await engine.resume({
      workflowId: selection.workflow.id,
      interruptId: selection.workflow.interrupt!.interruptId,
      navigation: { kind: 'search_more', queries: ['auto review'] },
    }, turn)

    expect(refineRemote).toHaveBeenCalledWith(expect.anything(), {
      queries: ['auto review'],
      repositories: ['PerryLink/dsh-auto-review'],
    }, expect.anything())
    expect(more.workflow.discoveryBudget).toMatchObject({
      refinementRoundsUsed: 1,
      refinementQueriesUsed: ['auto review'],
      explicitRepositories: ['PerryLink/dsh-auto-review'],
    })
    expect(more.workflow.discoveryPool).toEqual(expect.arrayContaining([
      expect.objectContaining({ repository: 'PerryLink/dsh-auto-review' }),
    ]))
    expect(more.workflow.consumedInterruptIds).toContain(selection.workflow.interrupt!.interruptId)
  })

  it('parks a fresh retry gate when hinted search_more fails after consuming the turn', async () => {
    const record = resolution('review capability')
    record.decision = 'inspect_remote'
    record.remoteCandidates = [
      { repository: 'acme/old-review', name: 'old-review', description: '', stars: 1, updatedAt: null, topics: [] },
    ]
    const { store, guard, workflowHost, engine } = await makeEngine(record, 'search-more-failure')
    const refineRemote = vi.fn(async () => {
      throw new EvolutionError('github_unavailable', 'temporary GitHub failure')
    })
    workflowHost.refineRemote = refineRemote
    const turn = exec()
    const { selection } = await startAndPresent(engine, 'review capability', turn)
    const consumedInterruptId = selection.workflow.interrupt!.interruptId
    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: '换个词继续找' }] })

    const failed = await engine.resume({
      workflowId: selection.workflow.id,
      interruptId: consumedInterruptId,
      navigation: { kind: 'search_more', queries: ['review automation'] },
    }, turn)

    expect(refineRemote).toHaveBeenCalledTimes(1)
    expect(failed.workflow).toMatchObject({
      status: 'interrupted',
      cursor: 'await_selection',
      candidateSnapshot: [],
      lastFailure: {
        stage: 'discovery',
        code: 'github_unavailable',
        retryable: true,
      },
    })
    expect(failed.workflow.interrupt?.interruptId).not.toBe(consumedInterruptId)
    expect(failed.workflow.interrupt?.options.map((option) => option.id)).toEqual(['search_more', 'stop'])
    expect(failed.workflow.consumedInterruptIds).toContain(consumedInterruptId)
    expect(failed.workflow.discoveryBudget).toMatchObject({ refinementRoundsUsed: 0 })
    expect(failed.resolution?.remoteDiscoveryComplete).toBe(false)

    const persisted = await store.getWorkflow(selection.workflow.id)
    expect(persisted.interrupt?.interruptId).toBe(failed.workflow.interrupt?.interruptId)
    expect(persisted.consumedInterruptIds).toContain(consumedInterruptId)
  })

  it('rejects a non-root GitHub refinement URL without consuming the interrupt', async () => {
    const record = resolution()
    record.decision = 'inspect_remote'
    record.remoteCandidates = [
      { repository: 'acme/review', name: 'review', description: '', stars: 1, updatedAt: null, topics: [] },
    ]
    const { store, guard, workflowHost, engine } = await makeEngine(record, 'search-more-invalid-url')
    const refineRemote = vi.fn(async (current: ResolutionRecord) => current)
    workflowHost.refineRemote = refineRemote
    const turn = exec()
    const { selection } = await startAndPresent(engine, 'calculator', turn)
    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: '再找找' }] })

    await expect(engine.resume({
      workflowId: selection.workflow.id,
      interruptId: selection.workflow.interrupt!.interruptId,
      navigation: {
        kind: 'search_more',
        repositories: ['https://github.com/acme/review/tree/main'],
      },
    }, turn)).rejects.toThrow(/exact https:\/\/github\.com\/owner\/repository root URL/i)

    const unchanged = await store.getWorkflow(selection.workflow.id)
    expect(unchanged.status).toBe('interrupted')
    expect(unchanged.consumedInterruptIds).not.toContain(selection.workflow.interrupt!.interruptId)
    expect(refineRemote).not.toHaveBeenCalled()
  })

  it('permits local reuse only after Gate 1 and binds the receipt and lease to the sealed candidate', async () => {
    const { guard, engine } = await makeEngine(resolution(), 'reuse')
    const turn = exec()
    const { selection } = await startAndPresent(engine, 'calculator', turn)
    const candidate = selection.workflow.candidateSnapshot![0]!
    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: '用已有的' }] })

    const reused = await engine.resume({
      workflowId: selection.workflow.id,
      interruptId: selection.workflow.interrupt!.interruptId,
      navigation: { kind: 'reuse_local', candidateIds: [candidate.id] },
    }, turn)

    expect(reused.workflow).toMatchObject({ status: 'completed', cursor: 'reuse_local' })
    expect(reused.workflow.selectionReceipt).toMatchObject({ kind: 'reuse_local', candidateIds: [candidate.id] })
    expect(reused.workflow.selectionReceipt?.candidateDigests[candidate.id]).toBe(candidate.digest)
    expect(reused.workflow.executionLease).toMatchObject({ candidateId: candidate.id, candidateDigest: candidate.digest, endpoint: { kind: 'exact_tool', name: 'pwsh' } })
  })

  it('parks a host-bundled Gate-1 selection and enables only after a fresh bound Gate-2 decision', async () => {
    const record = resolution('current time')
    record.localCandidates = [{
      kind: 'plugin',
      name: '@deepseek-ai/dsh-time-context',
      description: 'Opt-in durable per-step context with the current time and elapsed time',
      availability: 'host_bundled',
      confidence: 0.92,
      fit: 'full',
      reuseEligible: false,
      hostBundled: {
        packageName: '@deepseek-ai/dsh-time-context',
        version: '0.1.1-rc.2',
        mountId: 'time-context',
      },
    }]
    const { guard, engine, workflowHost } = await makeEngine(record, 'enable-builtin')
    const turn = exec()
    const { selection } = await startAndPresent(engine, 'current time', turn)
    const candidate = selection.workflow.candidateSnapshot![0]!
    expect(selection.workflow.interrupt?.options.map((option) => option.id)).toContain('enable_builtin')
    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: '直接启用' }] })
    const confirmation = await engine.resume({
      workflowId: selection.workflow.id,
      interruptId: selection.workflow.interrupt!.interruptId,
      navigation: { kind: 'enable_builtin', candidateIds: [candidate.id] },
    }, turn)

    expect(confirmation.workflow).toMatchObject({ status: 'interrupted', cursor: 'await_confirmation' })
    expect(confirmation.workflow.selectionReceipt).toMatchObject({
      phase: 'gate1',
      kind: 'enable_builtin',
      candidateIds: [candidate.id],
    })
    expect(confirmation.workflow.interrupt?.options).toEqual([
      expect.objectContaining({ id: 'enable_builtin', candidateIds: [candidate.id] }),
      expect.objectContaining({ id: 'stop' }),
    ])
    expect(confirmation.workflow.interrupt?.facts).toMatchObject({
      builtinEnablement: {
        candidateId: candidate.id,
        packageName: '@deepseek-ai/dsh-time-context',
        version: '0.1.1-rc.2',
        mountId: 'time-context',
        targetProfile: 'web',
      },
    })
    expect(workflowHost.enableBuiltin).not.toHaveBeenCalled()

    const sameTurn = await engine.resume({
      workflowId: confirmation.workflow.id,
      interruptId: confirmation.workflow.interrupt!.interruptId,
      decision: { action: 'enable_builtin', candidateId: candidate.id },
    }, turn)
    expect(sameTurn.status).toBe('parked')
    expect(workflowHost.enableBuiltin).not.toHaveBeenCalled()

    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: '确认启用这个内置能力' }] })
    // Terminal settlement clears the grant on the shared record object; capture at execution time.
    let capturedCommitment: unknown
    let capturedReceipt: unknown
    vi.mocked(workflowHost.enableBuiltin!).mockImplementation(async (workflow) => {
      capturedCommitment = structuredClone(workflow.actionCommitment)
      capturedReceipt = structuredClone(workflow.selectionReceipt)
    })

    const enabled = await engine.resume({
      workflowId: confirmation.workflow.id,
      interruptId: confirmation.workflow.interrupt!.interruptId,
      decision: { action: 'enable_builtin', candidateId: candidate.id },
    }, turn)

    expect(enabled.workflow).toMatchObject({ status: 'completed', cursor: 'restart_required' })
    expect(capturedCommitment).toMatchObject({
      requestedAction: 'enable_builtin',
      candidateId: candidate.id,
      targetProfile: 'web',
      endpoint: {
        kind: 'host_bundled_enable',
        packageName: '@deepseek-ai/dsh-time-context',
        version: '0.1.1-rc.2',
        mountId: 'time-context',
        targetProfile: 'web',
      },
    })
    expect(capturedReceipt).toMatchObject({ phase: 'gate2', kind: 'enable_builtin', candidateIds: [candidate.id] })
    expect(enabled.workflow.executionLease).toBeUndefined()
    expect(workflowHost.enableBuiltin).toHaveBeenCalledTimes(1)
  })

  it('rejects stale or forged Gate-2 built-in enablement without mutation', async () => {
    const record = resolution('current time')
    record.localCandidates = [
      {
        kind: 'plugin',
        name: '@deepseek-ai/dsh-time-context',
        description: 'Time context',
        availability: 'host_bundled',
        confidence: 0.92,
        fit: 'full',
        reuseEligible: false,
        hostBundled: {
          packageName: '@deepseek-ai/dsh-time-context',
          version: '0.1.1-rc.2',
          mountId: 'time-context',
        },
      },
      {
        kind: 'plugin',
        name: '@deepseek-ai/dsh-other-context',
        description: 'Other context',
        availability: 'host_bundled',
        confidence: 0.9,
        fit: 'full',
        reuseEligible: false,
        hostBundled: {
          packageName: '@deepseek-ai/dsh-other-context',
          version: '0.1.1-rc.2',
          mountId: 'other-context',
        },
      },
    ]
    const { guard, engine, workflowHost } = await makeEngine(record, 'enable-builtin-forged')
    const turn = exec()
    const { selection } = await startAndPresent(engine, 'current time', turn, 2)
    const [selected, forged] = selection.workflow.candidateSnapshot!
    const gate1InterruptId = selection.workflow.interrupt!.interruptId
    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: '先看第一个内置能力' }] })
    const confirmation = await engine.resume({
      workflowId: selection.workflow.id,
      interruptId: gate1InterruptId,
      navigation: { kind: 'enable_builtin', candidateIds: [selected!.id] },
    }, turn)

    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: '确认启用第二个' }] })
    await expect(engine.resume({
      workflowId: confirmation.workflow.id,
      interruptId: gate1InterruptId,
      decision: { action: 'enable_builtin', candidateId: selected!.id },
    }, turn)).rejects.toMatchObject({ code: 'invalid_input' })

    const invalid = await engine.resume({
      workflowId: confirmation.workflow.id,
      interruptId: confirmation.workflow.interrupt!.interruptId,
      decision: { action: 'enable_builtin', candidateId: forged!.id },
    }, turn)
    expect(invalid.status).toBe('invalid_resume')
    expect(invalid.resumeHint).toMatch(/candidate_id is not allowed/i)
    expect(workflowHost.enableBuiltin).not.toHaveBeenCalled()
  })

  it('requires a fresh trusted turn after denied built-in approval returns to confirmation', async () => {
    const record = resolution('current time')
    record.localCandidates = [{
      kind: 'plugin',
      name: '@deepseek-ai/dsh-time-context',
      description: 'Time context',
      availability: 'host_bundled',
      confidence: 0.92,
      fit: 'full',
      reuseEligible: false,
      hostBundled: {
        packageName: '@deepseek-ai/dsh-time-context',
        version: '0.1.1-rc.2',
        mountId: 'time-context',
      },
    }]
    const { store, guard, engine, workflowHost } = await makeEngine(record, 'enable-builtin-denied')
    const turn = exec()
    const { selection } = await startAndPresent(engine, 'current time', turn)
    const candidate = selection.workflow.candidateSnapshot![0]!
    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: '先查看这个内置能力' }] })
    const confirmation = await engine.resume({
      workflowId: selection.workflow.id,
      interruptId: selection.workflow.interrupt!.interruptId,
      navigation: { kind: 'enable_builtin', candidateIds: [candidate.id] },
    }, turn)

    vi.mocked(workflowHost.enableBuiltin!).mockImplementation(async (workflow) => {
      const id = workflow.pendingInstallationId!
      const failed: InstallationRecord = {
        schemaVersion: 1,
        id,
        createdAt: '2026-08-27T00:00:00.000Z',
        workflowId: workflow.id,
        targetProfile: 'web',
        retention: 'persistent',
        dshHome: 'C:/dsh',
        packageName: '@deepseek-ai/dsh-time-context',
        installSpec: 'builtin:0.1.1-rc.2:time-context:0',
        installPhase: 'completed',
        installState: 'not_installed',
        installOutcome: 'failed_absent',
        installed: false,
        loaded: false,
        verified: false,
        restartRequired: false,
        removed: true,
        installFailure: {
          stage: 'install',
          code: 'approval_required',
          summary: 'The profile change was denied.',
          message: 'The profile change was denied.',
          retryable: true,
        },
        verification: {
          attempted: false,
          expectedTools: [],
          calledTools: [],
          resultTools: [],
          failedTools: [],
          sessionFiles: [],
          taskResultObserved: false,
          reason: 'Built-in enablement had no profile effect.',
        },
      }
      await store.put('installations', failed)
      throw new EvolutionError('approval_required', 'The profile change was denied.', { outcome: 'denied' })
    })

    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: '确认启用' }] })
    const denied = await engine.resume({
      workflowId: confirmation.workflow.id,
      interruptId: confirmation.workflow.interrupt!.interruptId,
      decision: { action: 'enable_builtin', candidateId: candidate.id },
    }, turn)

    expect(denied.workflow).toMatchObject({
      status: 'interrupted',
      cursor: 'await_confirmation',
      lastFailure: { code: 'approval_required', retryable: true },
    })
    expect(workflowHost.enableBuiltin).toHaveBeenCalledTimes(1)

    const sameTurn = await engine.resume({
      workflowId: denied.workflow.id,
      interruptId: denied.workflow.interrupt!.interruptId,
      decision: { action: 'enable_builtin', candidateId: candidate.id },
    }, turn)
    expect(sameTurn.status).toBe('parked')
    expect(workflowHost.enableBuiltin).toHaveBeenCalledTimes(1)
  })

  it('rejects enable_builtin for a non-bundled candidate', async () => {
    const { guard, engine } = await makeEngine(resolution(), 'enable-builtin-invalid')
    const turn = exec()
    const { selection } = await startAndPresent(engine, 'calculator', turn)
    const candidate = selection.workflow.candidateSnapshot![0]!
    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: '启用' }] })

    const invalid = await engine.resume({
      workflowId: selection.workflow.id,
      interruptId: selection.workflow.interrupt!.interruptId,
      navigation: { kind: 'enable_builtin', candidateIds: [candidate.id] },
    }, turn)

    expect(invalid.status).toBe('invalid_resume')
  })

  it('keeps Gate 1 candidate scope sealed for navigation and leaves authorization unconsumed', async () => {
    const { store, guard, engine } = await makeEngine(resolution(), 'scope')
    const turn = exec()
    const { selection } = await startAndPresent(engine, 'calculator', turn)
    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: '用别的' }] })

    const invalid = await engine.resume({
      workflowId: selection.workflow.id,
      interruptId: selection.workflow.interrupt!.interruptId,
      navigation: { kind: 'reuse_local', candidateIds: [`candidate_${'f'.repeat(24)}`] },
    }, turn)

    expect(invalid.status).toBe('invalid_resume')
    expect(invalid.resumeHint).toMatch(/outside the current candidate snapshot/i)
    expect((await store.getWorkflow(selection.workflow.id)).consumedInterruptIds).toEqual([])
  })

  it('blocks the duplicate invalid action fingerprint after two same-turn attempts', async () => {
    const { guard, engine } = await makeEngine(resolution(), 'invalid-breaker')
    const turn = exec()
    const { selection } = await startAndPresent(engine, 'calculator', turn)
    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: '停' }] })
    const input = {
      workflowId: selection.workflow.id,
      interruptId: selection.workflow.interrupt!.interruptId,
      navigation: { kind: 'reuse_local' as const, candidateIds: [`candidate_${'f'.repeat(24)}`] },
    }

    const first = await engine.resume(input, turn)
    const second = await engine.resume(input, turn)
    const blocked = await engine.resume(input, turn)

    expect(first.resumeHint).not.toMatch(/Repeated invalid action/i)
    expect(second.resumeHint).toMatch(/Repeated invalid action is blocked/i)
    expect(blocked.resumeHint).toMatch(/^Repeated invalid action is blocked until a fresh user turn\./i)
    expect(blocked.workflow.invalidResumeAttempt).toMatchObject({ count: 2 })
    expect(blocked.workflow.consumedInterruptIds).toEqual([])
  })

  it('diagnoses incomplete discovery without changing the autonomous checkpoint', async () => {
    const record = resolution()
    record.remoteDiscoveryComplete = false
    record.reasons = [
      'Finder failed at C:\\Users\\Jane Doe\\token.txt; '
      + '\\\\server\\share\\private key.txt; /home/alice/.config/token; '
      + 'api_key=top-secret; see https://example.test/?token=abc',
    ]
    const { engine } = await makeEngine(record, 'diagnose')
    const started = await engine.start('calculator', exec())

    const diagnosed = await engine.diagnose({ workflowId: started.workflow.id, probes: ['discovery'] }, exec())

    expect(diagnosed.diagnosis?.facts).toEqual([expect.objectContaining({ probe: 'discovery', status: 'failed', code: 'search_incomplete' })])
    expect(JSON.stringify(diagnosed.diagnosis)).not.toContain('secret')
    expect(JSON.stringify(diagnosed.diagnosis)).not.toContain('Jane Doe')
    expect(JSON.stringify(diagnosed.diagnosis)).not.toContain('server')
    expect(JSON.stringify(diagnosed.diagnosis)).not.toContain('/home/alice')
    expect(JSON.stringify(diagnosed.diagnosis)).not.toContain('token=abc')
    expect(diagnosed.workflow).toMatchObject({ status: 'interrupted', cursor: 'await_discovery', generation: started.workflow.generation })
    const second = await engine.diagnose({ workflowId: started.workflow.id, probes: ['review'] }, exec())
    expect(second.diagnosis?.budget).toMatchObject({ maxCalls: 2, usedCalls: 2, maxProbes: 8, usedProbes: 2 })
    await expect(engine.diagnose({ workflowId: started.workflow.id, probes: ['discovery'] }, exec()))
      .rejects.toThrow(/call budget is exhausted/i)
  })

  it('diagnoses an installation from its bounded summary and structured failure facts', async () => {
    const { store, engine } = await makeEngine(resolution(), 'diagnose-installation')
    const started = await engine.start('calculator', exec())
    const workflow = await store.getWorkflow(started.workflow.id)
    const installationId = `installation_${'9'.repeat(24)}`
    workflow.lastInstallationId = installationId
    await store.put('workflows', workflow)
    await store.put('installations', {
      schemaVersion: 1,
      id: installationId,
      createdAt: '2026-08-28T00:00:00.000Z',
      reviewId: `review_${'8'.repeat(24)}`,
      targetProfile: 'web',
      retention: 'persistent',
      dshHome: 'C:/Users/test/.dsh',
      packageName: 'dsh-plugin-demo',
      installSpec: 'github:acme/demo#commit',
      installState: 'not_installed',
      installOutcome: 'failed_absent',
      installed: false,
      loaded: false,
      verified: false,
      restartRequired: false,
      removed: false,
      installFailure: {
        stage: 'install',
        code: 'command_failed',
        summary: 'stdout: ERR_PNPM_EPERM operation not permitted',
        message: 'dsh exited with code 1',
        retryable: true,
        exitCode: 1,
        diagnosticHash: 'a'.repeat(64),
      },
      verification: {
        attempted: false,
        expectedTools: [],
        calledTools: [],
        resultTools: [],
        failedTools: [],
        sessionFiles: [],
        taskResultObserved: false,
        reason: 'installation failed before verification',
      },
    } satisfies InstallationRecord)

    const diagnosed = await engine.diagnose({ workflowId: workflow.id, probes: ['installation'] }, exec())
    expect(diagnosed.diagnosis?.facts).toEqual([expect.objectContaining({
      probe: 'installation',
      status: 'failed',
      summary: 'stdout: ERR_PNPM_EPERM operation not permitted',
      evidenceHash: 'a'.repeat(64),
      facts: expect.objectContaining({
        targetProfile: 'web',
        failureStage: 'install',
        exitCode: 1,
        retryable: true,
        verificationAttempted: false,
      }),
    })])
  })

  it('diagnoses a prepare_create managed-child failure without a linked review', async () => {
    const record = resolution()
    record.localCandidates[0] = { ...record.localCandidates[0]!, fit: 'partial' }
    record.remoteDiscoveryComplete = false
    const { store, guard, workflowHost, engine } = await makeEngine(record, 'diagnose-create-failure')
    workflowHost.prepareCreate = async () => {
      throw new EvolutionError('command_failed', 'Managed construction requires the Capability Evolution parent session', {
        reason: 'creator_foundation_unavailable',
      })
    }
    let refineCalls = 0
    workflowHost.refineRemote = async (current) => {
      refineCalls += 1
      return refineCalls >= 2 ? { ...current, remoteDiscoveryComplete: true } : current
    }
    const turn = exec()
    const started = await engine.start('calculator', turn)
    await engine.refine({ workflowId: started.workflow.id, queries: ['first', 'second'] }, turn)
    const exhausted = await engine.refine({ workflowId: started.workflow.id, queries: ['third', 'fourth', 'fifth'] }, turn)
    expect(exhausted.workflow).toMatchObject({ cursor: 'await_confirmation', status: 'interrupted' })
    expect(exhausted.workflow.interrupt?.options.map((option) => option.id)).toContain('create_new')
    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: '没有合适的，新建一个' }] })

    await expect(engine.resume({
      workflowId: exhausted.workflow.id,
      interruptId: exhausted.workflow.interrupt!.interruptId,
      decision: { action: 'create_new' },
    }, turn)).rejects.toThrow(/Capability Evolution parent session/i)
    const failed = await store.getWorkflow(started.workflow.id)
    expect(failed).toMatchObject({ status: 'failed', cursor: 'prepare_create' })
    expect(failed.lastFailure).toMatchObject({ stage: 'managed_child', code: 'command_failed' })

    const diagnosed = await engine.diagnose({ workflowId: started.workflow.id, probes: ['managed_child'] }, turn)
    expect(diagnosed.diagnosis?.facts).toEqual([expect.objectContaining({
      probe: 'managed_child',
      status: 'failed',
      code: 'command_failed',
    })])
  })

  it('keeps managed construction open when sealing rejects the current source state', async () => {
    const record = resolution('new capability')
    record.localCandidates = []
    record.remoteCandidates = []
    record.remoteDiscoveryComplete = true
    const { root, store, guard, workflowHost, engine } = await makeEngine(record, 'repair-seal')
    const sourceRoot = path.join(root, 'managed-source')
    const staleReview: ReviewRecord = {
      schemaVersion: 1,
      id: `review_${'f'.repeat(64)}`,
      policyVersion: POLICY_VERSION,
      createdAt: '2026-08-26T00:00:00.000Z',
      resolutionId: record.id,
      requirement: record.requirement,
      sourceSnapshot: {
        kind: 'local',
        path: sourceRoot,
        baseReviewId: `review_${'a'.repeat(64)}`,
        baseCommit: 'b'.repeat(40),
        statusHash: 'c'.repeat(64),
      },
      inspectedFiles: [],
      manifest: {
        kind: 'bundle',
        packageName: 'dsh-plugin-generated',
        scripts: [],
        dependencies: [],
        peerDependencies: {},
        expectedTools: [],
      },
      fit: 'full',
      confidence: 0.9,
      securityRisk: 'low',
      maintained: true,
      license: 'MIT',
      compatibility: { status: 'compatible', reason: 'local review', runtimeVersion: '0.1.0' },
      missingCapabilities: [],
      findings: [],
      recommendation: 'use',
      installSpec: `file:${path.join(root, 'stale.tgz')}`,
    }
    workflowHost.prepareCreate = async (current, _exec, workflow) => {
      workflow.pendingPath = sourceRoot
      workflow.managedSourceId = 'managed-generated'
      return { resolution: current, path: sourceRoot }
    }
    let finishAttempts = 0
    workflowHost.finishManagedWork = async (current, _exec, workflow) => {
      finishAttempts += 1
      await store.put('reviews', staleReview)
      workflow.lastReviewId = staleReview.id
      workflow.lineageTipReviewId = staleReview.id
      if (finishAttempts === 1) {
        throw new EvolutionError('review_rejected', 'Managed child changed Git branch or HEAD instead of only editing the working tree')
      }
      return { resolution: current, path: sourceRoot, review: staleReview }
    }

    const turn = exec('session-repair-seal', root)
    const discovery = await engine.start(record.requirement, turn)
    const started = await engine.present({ workflowId: discovery.workflow.id, candidateIds: [] }, turn)
    expect(started.workflow).toMatchObject({ cursor: 'await_selection', status: 'interrupted' })
    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: '新建' }] })
    const constructing = await engine.resume({
      workflowId: started.workflow.id,
      interruptId: started.workflow.interrupt!.interruptId,
      decision: { action: 'create_new' },
    }, turn)
    expect(constructing.workflow.cursor).toBe('await_modify_work')

    const repairable = await engine.resume({
      workflowId: constructing.workflow.id,
      navigation: { kind: 'finish_managed_work' },
    }, turn)

    expect(repairable.workflow).toMatchObject({
      cursor: 'await_modify_work',
      status: 'interrupted',
      lastFailure: {
        stage: 'managed_child',
        code: 'review_rejected',
        retryable: true,
      },
    })
    expect(repairable.workflow.interrupt).toBeUndefined()
    expect(guard.constructionRoot(turn.agent)).toBe(sourceRoot)

    const repaired = await engine.resume({
      workflowId: constructing.workflow.id,
      navigation: { kind: 'finish_managed_work' },
    }, turn)
    expect(repaired.workflow).toMatchObject({ cursor: 'await_confirmation', status: 'interrupted' })
    expect(repaired.workflow.lastFailure).toBeUndefined()
    expect(guard.constructionRoot(turn.agent)).toBeUndefined()
  })

  it.each([
    {
      name: 'recovery-required result',
      finish: async () => {
        throw new EvolutionError('command_failed', 'managed construction needs recovery', {
          recoveryRequired: true,
        })
      },
      expectedCursor: 'recovery_required',
      rejects: false,
    },
    {
      name: 'unexpected exception',
      finish: async () => {
        throw new Error('managed construction crashed')
      },
      expectedCursor: 'complete_managed_work',
      rejects: true,
    },
  ])('releases constructor state after $name', async ({ finish, expectedCursor, rejects }) => {
    const record = resolution('new capability')
    record.localCandidates = []
    record.remoteCandidates = []
    record.remoteDiscoveryComplete = false
    const { root, store, guard, workflowHost, engine } = await makeEngine(record, `constructor-exit-${rejects}`)
    let refinementCalls = 0
    workflowHost.refineRemote = async (current) => {
      refinementCalls += 1
      return refinementCalls >= 2 ? { ...current, remoteDiscoveryComplete: true } : current
    }
    workflowHost.prepareCreate = async (current, _exec, workflow) => {
      const sourceRoot = path.join(root, 'managed-source')
      workflow.pendingPath = sourceRoot
      workflow.managedSourceId = 'managed-new-capability'
      return { resolution: current, path: sourceRoot }
    }
    workflowHost.finishManagedWork = finish

    const turn = exec(`session-constructor-exit-${rejects}`, root)
    const discovery = await engine.start('new capability', turn, {
      operation: 'discover_or_reuse',
      requiredSurface: 'native_dsh_plugin',
    })
    await engine.refine({ workflowId: discovery.workflow.id, queries: ['first search', 'second search'] }, turn)
    const started = await engine.refine({
      workflowId: discovery.workflow.id,
      queries: ['third search', 'fourth search', 'fifth search'],
    }, turn)
    expect(started.workflow).toMatchObject({ cursor: 'await_confirmation', status: 'interrupted' })
    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: '创建新的能力' }] })
    const constructing = await engine.resume({
      workflowId: started.workflow.id,
      interruptId: started.workflow.interrupt!.interruptId,
      decision: { action: 'create_new' },
    }, turn)
    expect(constructing.workflow.cursor, JSON.stringify({
      options: started.workflow.interrupt?.options,
      resumeHint: constructing.resumeHint,
    })).toBe('await_modify_work')
    expect(guard.constructionRoot(turn.agent)).toBe(path.join(root, 'managed-source'))

    const finishPromise = engine.resume({
      workflowId: constructing.workflow.id,
      navigation: { kind: 'finish_managed_work' },
    }, turn)
    if (rejects) {
      await expect(finishPromise).rejects.toThrow(/managed construction crashed/i)
    } else {
      await expect(finishPromise).resolves.toMatchObject({
        workflow: { cursor: expectedCursor, status: 'interrupted' },
      })
    }

    expect(guard.constructionRoot(turn.agent)).toBeUndefined()
    const stored = await store.getWorkflow(constructing.workflow.id)
    expect(stored.cursor).toBe(expectedCursor)
    if (rejects) expect(stored.status).toBe('failed')
  })

  it('cleans the exact linked installation and starts a new audited workflow after a fresh user recovery request', async () => {
    const record = resolution('calculator')
    const { root, store, guard, workflowHost, engine } = await makeEngine(record, 'recover')
    await store.put('resolutions', record)
    const workflowId = `workflow_${'a'.repeat(24)}`
    const installationId = `installation_${'d'.repeat(24)}`
    const installation: InstallationRecord = {
      schemaVersion: 1,
      id: installationId,
      createdAt: '2026-08-21T00:00:00.000Z',
      reviewId: `review_${'e'.repeat(24)}`,
      workflowId,
      targetProfile: 'headless',
      retention: 'persistent',
      dshHome: root,
      packageName: 'dsh-plugin-demo',
      installSpec: 'file:demo.tgz',
      installState: 'installed',
      installOutcome: 'recovery_required',
      installed: false,
      loaded: false,
      verified: false,
      restartRequired: false,
      removed: false,
      verification: {
        attempted: true,
        exitCode: 1,
        expectedTools: [],
        calledTools: [],
        resultTools: [],
        failedTools: [],
        sessionFiles: [],
        taskResultObserved: false,
        reason: 'child cause unknown',
      },
    }
    await store.put('installations', installation)
    const workflow: WorkflowRecord = {
      schemaVersion: 2,
      id: workflowId,
      policyVersion: POLICY_VERSION,
      createdAt: '2026-08-21T00:00:00.000Z',
      updatedAt: '2026-08-21T00:00:00.000Z',
      requirement: 'calculator',
      requirementNormalized: 'calculator',
      cwd: process.cwd(),
      ownerSessionId: 'session-1',
      bootId: 'boot_previous',
      resolutionId: record.id,
      status: 'running',
      cursor: 'install_verify',
      generation: 3,
      consumedInterruptIds: [],
      lastInstallationId: installationId,
    }
    await store.put('workflows', workflow)
    const cleanupInstallation = vi.fn(async (id: string) => ({ installationId: id, removed: true, restartRequired: true }))
    workflowHost.cleanupInstallation = cleanupInstallation
    const turn = exec()
    const recoveredAfterRestart = await engine.start('calculator', turn)
    expect(recoveredAfterRestart).toMatchObject({
      status: 'parked',
      alreadyWaiting: true,
      workflow: { cursor: 'recovery_required', status: 'interrupted' },
    })
    expect(recoveredAfterRestart.workflow.interrupt?.kind).toBe('await_recovery')
    await expect(engine.recover({ workflowId: workflow.id }, turn)).rejects.toThrow(/interrupt_id/i)

    const sameTurn = await engine.recover({
      workflowId: workflow.id,
      interruptId: recoveredAfterRestart.workflow.interrupt!.interruptId,
    }, turn)
    expect(sameTurn).toMatchObject({ status: 'parked', alreadyWaiting: true })
    expect(cleanupInstallation).not.toHaveBeenCalled()

    const tampered = await store.getWorkflow(workflow.id)
    tampered.lastInstallationId = `installation_${'9'.repeat(24)}`
    await store.put('workflows', tampered)
    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: '清理掉并重新开始' }] })
    await expect(engine.recover({
      workflowId: workflow.id,
      interruptId: recoveredAfterRestart.workflow.interrupt!.interruptId,
    }, turn)).rejects.toThrow(/no longer matches the sealed workflow state/i)
    expect(cleanupInstallation).not.toHaveBeenCalled()

    tampered.lastInstallationId = installationId
    await store.put('workflows', tampered)

    const restarted = await engine.recover({
      workflowId: workflow.id,
      interruptId: recoveredAfterRestart.workflow.interrupt!.interruptId,
    }, turn)

    expect(cleanupInstallation).toHaveBeenCalledOnce()
    expect(cleanupInstallation).toHaveBeenCalledWith(installationId, expect.objectContaining({ agent: turn.agent }))
    expect(restarted.workflow).toMatchObject({
      cursor: 'await_discovery',
      status: 'interrupted',
      recoveredFromWorkflowId: workflow.id,
    })
    expect(restarted.workflow.id).not.toBe(workflow.id)
    const old = await store.getWorkflow(workflow.id)
    expect(old).toMatchObject({
      status: 'completed',
      cursor: 'recovery_required',
      recovery: {
        action: 'cleanup_and_restart',
        cleanup: 'removed',
        installationId,
        restartRequired: true,
        restartedAsWorkflowId: restarted.workflow.id,
      },
      lastFailure: { code: 'service_restart_incomplete' },
    })
    expect(old.interrupt).toBeUndefined()
  })

  it('restarts a completed installation from an explicit user request without forging a recovery interrupt', async () => {
    const record = resolution('calculator')
    const { root, store, guard, workflowHost, engine } = await makeEngine(record, 'completed-recover')
    await store.put('resolutions', record)
    const workflowId = `workflow_${'a'.repeat(24)}`
    const installationId = `installation_${'d'.repeat(24)}`
    const installation: InstallationRecord = {
      schemaVersion: 1,
      id: installationId,
      createdAt: '2026-08-21T00:00:00.000Z',
      reviewId: `review_${'e'.repeat(24)}`,
      workflowId,
      targetProfile: 'headless',
      retention: 'persistent',
      dshHome: root,
      packageName: 'dsh-plugin-demo',
      installSpec: 'file:demo.tgz',
      installState: 'installed',
      installOutcome: 'activated',
      installed: true,
      loaded: true,
      verified: false,
      restartRequired: false,
      removed: false,
      verification: {
        attempted: true,
        expectedTools: [],
        calledTools: [],
        resultTools: [],
        failedTools: [],
        sessionFiles: [],
        taskResultObserved: false,
        reason: 'bundle activated',
      },
    }
    await store.put('installations', installation)
    const workflow: WorkflowRecord = {
      schemaVersion: 2,
      id: workflowId,
      policyVersion: POLICY_VERSION,
      createdAt: '2026-08-21T00:00:00.000Z',
      updatedAt: '2026-08-21T00:00:00.000Z',
      requirement: 'calculator',
      requirementNormalized: 'calculator',
      cwd: process.cwd(),
      ownerSessionId: 'session-1',
      bootId: 'boot_engine',
      resolutionId: record.id,
      status: 'completed',
      cursor: 'activated',
      generation: 4,
      consumedInterruptIds: [`interrupt_${'c'.repeat(24)}`],
      lastInstallationId: installationId,
      lastReviewId: `review_${'e'.repeat(24)}`,
      selectionReceipt: { id: 'selection_old' } as unknown as NonNullable<WorkflowRecord['selectionReceipt']>,
      actionCommitment: { id: 'commitment_old' } as unknown as NonNullable<WorkflowRecord['actionCommitment']>,
      completionTurnId: 'turn_install',
    }
    await store.put('workflows', workflow)
    const cleanupInstallation = vi.fn(async (id: string) => ({ installationId: id, removed: true, restartRequired: true }))
    workflowHost.cleanupInstallation = cleanupInstallation
    const turn = exec()

    const sameTurn = await engine.recover({ workflowId: workflow.id }, turn)
    expect(sameTurn).toMatchObject({ status: 'parked', alreadyWaiting: true })
    expect(cleanupInstallation).not.toHaveBeenCalled()
    expect((await store.listWorkflows()).map((item) => item.id)).toEqual([workflow.id])

    await expect(engine.recover({
      workflowId: workflow.id,
      interruptId: `interrupt_${'c'.repeat(24)}`,
    }, turn)).rejects.toThrow(/omit interrupt_id/i)
    expect(cleanupInstallation).not.toHaveBeenCalled()

    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: '清理掉，从头开始' }] })
    const denied = vi.fn(async () => {
      throw new EvolutionError('approval_required', 'The removal was not approved (denied)', { outcome: 'denied' })
    })
    const deniedEngine = new WorkflowEngine(store, guard, { ...host(store, record), cleanupInstallation: denied })
    await expect(deniedEngine.recover({ workflowId: workflow.id }, turn)).rejects.toMatchObject({
      code: 'approval_required',
    })
    expect(denied).toHaveBeenCalledOnce()
    expect(await store.getWorkflow(workflow.id)).toMatchObject({
      status: 'completed',
      cursor: 'activated',
      generation: 4,
    })
    expect((await store.getWorkflow(workflow.id)).recovery).toBeUndefined()
    expect((await store.listWorkflows()).map((item) => item.id)).toEqual([workflow.id])
    expect(await store.getInstallation(installationId)).toMatchObject({ removed: false })

    const restarted = await engine.recover({ workflowId: workflow.id }, turn)
    expect(cleanupInstallation).toHaveBeenCalledOnce()
    expect(cleanupInstallation).toHaveBeenCalledWith(installationId, expect.objectContaining({ agent: turn.agent }))
    expect(restarted.workflow.id).not.toBe(workflow.id)
    expect(restarted.workflow).toMatchObject({
      cursor: 'await_discovery',
      status: 'interrupted',
      generation: 1,
      recoveredFromWorkflowId: workflow.id,
    })
    expect(restarted.workflow.lastInstallationId).toBeUndefined()
    expect(restarted.workflow.lastReviewId).toBeUndefined()
    expect(restarted.workflow.selectionReceipt).toBeUndefined()
    expect(restarted.workflow.actionCommitment).toBeUndefined()
    expect(restarted.workflow.consumedVerificationAttempts).toBeUndefined()
    const old = await store.getWorkflow(workflow.id)
    expect(old).toMatchObject({
      status: 'completed',
      cursor: 'activated',
      lastInstallationId: installationId,
      lastReviewId: `review_${'e'.repeat(24)}`,
      recovery: {
        action: 'cleanup_and_restart',
        cleanup: 'removed',
        installationId,
        restartRequired: true,
        restartedAsWorkflowId: restarted.workflow.id,
      },
    })
    expect(old.interrupt).toBeUndefined()
    expect(old.selectionReceipt).toEqual({ id: 'selection_old' })

    await expect(engine.recover({ workflowId: workflow.id }, turn)).rejects.toThrow(/not waiting for a recovery decision/i)
  })

  it('keeps a completed V9 temporary receipt readable and explicitly removes it before a fresh V10 workflow', async () => {
    const record = resolution('calculator')
    const { root, store, guard, workflowHost, engine } = await makeEngine(record, 'legacy-v9-completed')
    await store.put('resolutions', record)
    const workflowId = `workflow_${'a'.repeat(24)}`
    const installationId = `installation_${'d'.repeat(24)}`
    await store.put('installations', {
      schemaVersion: 1,
      id: installationId,
      createdAt: '2026-08-21T00:00:00.000Z',
      reviewId: `review_${'e'.repeat(24)}`,
      workflowId,
      targetProfile: 'headless',
      retention: 'temporary',
      dshHome: root,
      packageName: 'dsh-plugin-demo',
      installSpec: 'file:demo.tgz',
      installState: 'installed',
      installOutcome: 'activated',
      installed: true,
      loaded: true,
      verified: false,
      restartRequired: false,
      removed: false,
      verification: {
        attempted: true,
        expectedTools: [],
        calledTools: [],
        resultTools: [],
        failedTools: [],
        sessionFiles: [],
        taskResultObserved: false,
        reason: 'legacy temporary activation',
      },
    } satisfies InstallationRecord)
    await store.put('workflows', {
      schemaVersion: 2,
      id: workflowId,
      policyVersion: '9',
      createdAt: '2026-08-21T00:00:00.000Z',
      updatedAt: '2026-08-21T00:00:00.000Z',
      requirement: 'calculator',
      requirementNormalized: 'calculator',
      cwd: process.cwd(),
      ownerSessionId: 'session-1',
      bootId: 'boot_engine',
      resolutionId: record.id,
      status: 'completed',
      cursor: 'activated',
      generation: 4,
      lastInstallationId: installationId,
      lastReviewId: `review_${'e'.repeat(24)}`,
      completionTurnId: 'turn_install',
    } satisfies WorkflowRecord)
    const cleanupInstallation = vi.fn(async (id: string) => ({ installationId: id, removed: true, restartRequired: true }))
    workflowHost.cleanupInstallation = cleanupInstallation
    const turn = exec()
    const currentRequest = '现在清理旧试装并找农历转换能力'
    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: currentRequest }] })

    const restarted = await engine.recover({ workflowId }, turn)

    expect(cleanupInstallation).toHaveBeenCalledWith(installationId, expect.objectContaining({ agent: turn.agent }))
    expect(restarted.workflow).toMatchObject({
      schemaVersion: 3,
      policyVersion: POLICY_VERSION,
      requirement: currentRequest,
      searchRequirement: currentRequest,
      recoveredFromWorkflowId: workflowId,
      cursor: 'await_discovery',
      status: 'interrupted',
    })
    expect(await store.getWorkflow(workflowId)).toMatchObject({
      policyVersion: '9',
      status: 'completed',
      recovery: {
        action: 'cleanup_and_restart',
        cleanup: 'removed',
        installationId,
        restartRequired: true,
        restartedAsWorkflowId: restarted.workflow.id,
      },
    })
  })

  it('rejects completed-install restart when the receipt is not the unreplaced owned success receipt', async () => {
    const record = resolution('calculator')
    const { root, store, guard, workflowHost, engine } = await makeEngine(record, 'completed-receipt')
    await store.put('resolutions', record)
    const workflowId = `workflow_${'a'.repeat(24)}`
    const installationId = `installation_${'d'.repeat(24)}`
    await store.put('installations', {
      schemaVersion: 1,
      id: installationId,
      createdAt: '2026-08-21T00:00:00.000Z',
      reviewId: `review_${'e'.repeat(24)}`,
      workflowId: `workflow_${'f'.repeat(24)}`,
      targetProfile: 'headless',
      retention: 'persistent',
      dshHome: root,
      packageName: 'dsh-plugin-demo',
      installSpec: 'file:demo.tgz',
      installOutcome: 'verified',
      installed: true,
      loaded: true,
      verified: true,
      restartRequired: false,
      removed: false,
      verification: {
        attempted: true,
        expectedTools: [],
        calledTools: [],
        resultTools: [],
        failedTools: [],
        sessionFiles: [],
        taskResultObserved: true,
        reason: 'verified',
      },
    } satisfies InstallationRecord)
    const workflow: WorkflowRecord = {
      schemaVersion: 2,
      id: workflowId,
      policyVersion: POLICY_VERSION,
      createdAt: '2026-08-21T00:00:00.000Z',
      updatedAt: '2026-08-21T00:00:00.000Z',
      requirement: 'calculator',
      requirementNormalized: 'calculator',
      cwd: process.cwd(),
      ownerSessionId: 'session-1',
      bootId: 'boot_engine',
      resolutionId: record.id,
      status: 'completed',
      cursor: 'installed',
      generation: 2,
      lastInstallationId: installationId,
    }
    await store.put('workflows', workflow)
    const cleanupInstallation = vi.fn(async (id: string) => ({ installationId: id, removed: true, restartRequired: false }))
    workflowHost.cleanupInstallation = cleanupInstallation
    const turn = exec()
    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: '清理并重来' }] })
    await expect(engine.recover({ workflowId }, turn)).rejects.toThrow(/not owned by this recovery workflow/i)
    expect(cleanupInstallation).not.toHaveBeenCalled()
    expect((await store.listWorkflows()).map((item) => item.id)).toEqual([workflowId])
  })

  it('keeps a persisted current-policy Gate 1 interrupt readable for the owning session', async () => {
    const record = resolution()
    const { store, engine } = await makeEngine(record, 'v5-compat')
    await store.put('resolutions', record)
    const persisted: WorkflowRecord = {
      schemaVersion: 1,
      id: `workflow_${'a'.repeat(24)}`,
      policyVersion: POLICY_VERSION,
      createdAt: '2026-08-17T00:00:00.000Z',
      updatedAt: '2026-08-17T00:00:00.000Z',
      requirement: 'calculator',
      requirementNormalized: 'calculator',
      cwd: process.cwd(),
      ownerSessionId: 'session-1',
      bootId: 'boot_engine',
      resolutionId: record.id,
      status: 'interrupted',
      cursor: 'await_selection',
      generation: 1,
      candidateSnapshot: [],
      consumedInterruptIds: [],
      interrupt: {
        kind: 'await_selection',
        interruptId: `interrupt_${'c'.repeat(24)}`,
        ownerSessionId: 'session-1',
        bootId: 'boot_engine',
        validAfterTurnId: `turn_${'d'.repeat(24)}`,
        snapshotDigest: 'e'.repeat(64),
        options: [],
        facts: {},
      },
    }
    await store.put('workflows', persisted)

    const started = await engine.start('calculator', exec())

    expect(started.workflow.id).not.toBe(persisted.id)
    expect((await store.getWorkflow(persisted.id)).interrupt?.interruptId).toBe(persisted.interrupt!.interruptId)
  })

  it('does not reuse an unfinished workflow across different start intents', async () => {
    const record = resolution()
    const { engine } = await makeEngine(record, 'intent-reuse')
    const turn = exec('session-1', 'C:/workspace')
    const first = await engine.start('calculator', turn, {
      operation: 'evolve_existing',
      requiredSurface: 'native_dsh_plugin',
      targetName: 'dsh-plugin-alpha',
    })
    const second = await engine.start('calculator', turn, {
      operation: 'discover_or_reuse',
      requiredSurface: 'any',
    })
    expect(second.workflow.id).not.toBe(first.workflow.id)
    const same = await engine.start('calculator', turn, {
      operation: 'evolve_existing',
      requiredSurface: 'native_dsh_plugin',
      targetName: 'dsh-plugin-alpha',
    })
    expect(same.workflow.id).toBe(first.workflow.id)
  })

  it('offers review_existing for an installed GitHub SHA without treating Gate-1 use_this as review', async () => {
    const commit = '5'.repeat(40)
    const record = resolution('dsh-plugin-alpha')
    record.localCandidates[0] = installedPluginCandidate('dsh-plugin-alpha', 'anonymous-lab/dsh-plugin-alpha', commit, { description: 'synthetic provider synthetic model OAuth' })
    const { guard, engine } = await makeEngine(record, 'review-existing')
    const turn = exec()
    const { selection } = await startAndPresent(engine, 'dsh-plugin-alpha', turn)
    const optionIds = selection.workflow.interrupt?.options.map((item) => item.id) ?? []
    expect(optionIds).toEqual(expect.arrayContaining(['review_existing', 'reuse_local', 'search_more', 'stop']))
    expect(optionIds).not.toContain('modify_this')
    const candidateId = selection.workflow.candidateSnapshot![0]!.id
    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: '装这个' }] })
    const rejected = await engine.resume({
      workflowId: selection.workflow.id,
      interruptId: selection.workflow.interrupt!.interruptId,
      decision: { action: 'use_this', candidateId },
    }, turn)
    expect(rejected.status).toBe('invalid_resume')
    expect(rejected.workflow.cursor).toBe('await_selection')
    expect(rejected.workflow.interrupt?.interruptId).toBe(selection.workflow.interrupt!.interruptId)
  })

  it('hides search_more at Gate 1 when evolving a failed known source', async () => {
    const commit = 'd'.repeat(40)
    const record = resolution('record-sync')
    record.intent = {
      operation: 'evolve_existing',
      requiredSurface: 'native_dsh_plugin',
      targetName: 'record-sync',
      evolveReason: 'repair',
    }
    record.localCandidates = [installedPluginCandidate('dsh-plugin-beta', 'anonymous-lab/dsh-plugin-beta', commit, {
      kind: 'failed_install',
      description: 'failed activation',
      availability: 'known_source',
      reuseEligible: false,
      profileEvidence: false,
      specDigest: 'e'.repeat(64),
    })]
    const { engine } = await makeEngine(record, 'failed-lineage')
    const turn = exec()
    const started = await engine.start('record-sync', turn, record.intent)
    expect(started.workflow.cursor).toBe('await_discovery')
    const candidateIds = started.workflow.discoveryPool!.map((item) => item.id)
    const selection = await engine.present({ workflowId: started.workflow.id, candidateIds }, turn)
    const optionIds = selection.workflow.interrupt?.options.map((item) => item.id) ?? []
    expect(optionIds).toEqual(['review_existing', 'stop'])
    expect(optionIds).not.toContain('search_more')
    expect(optionIds).not.toContain('reuse_local')
  })

  it('replays a failed known-source review through install without a live replacement binding', async () => {
    const commit = 'd'.repeat(40)
    const oldSpec = `github:anonymous-lab/dsh-plugin-beta#${commit}`
    const record = resolution('record-sync')
    record.intent = {
      operation: 'evolve_existing',
      requiredSurface: 'native_dsh_plugin',
      targetName: 'record-sync',
      evolveReason: 'repair',
    }
    record.localCandidates[0] = installedPluginCandidate('dsh-plugin-beta', 'anonymous-lab/dsh-plugin-beta', commit, {
      kind: 'failed_install',
      description: 'failed activation',
      availability: 'known_source',
      reuseEligible: false,
      profileEvidence: false,
      specDigest: 'e'.repeat(64),
    })
    const { root, store, guard, workflowHost, engine } = await makeEngine(record, 'failed-install-replay')
    const fixedReview: ReviewRecord = {
      schemaVersion: 1,
      id: `review_${'f'.repeat(64)}`,
      policyVersion: POLICY_VERSION,
      createdAt: '2026-08-23T10:58:59.000Z',
      resolutionId: record.id,
      requirement: record.requirement,
      sourceSnapshot: {
        kind: 'local',
        path: path.join(root, 'managed-source'),
        baseReviewId: `review_${'a'.repeat(64)}`,
        baseCommit: commit,
        statusHash: '7'.repeat(64),
      },
      inspectedFiles: [],
      manifest: {
        kind: 'bundle',
        packageName: 'dsh-plugin-beta',
        scripts: [],
        dependencies: [],
        peerDependencies: {},
        expectedTools: [],
      },
      fit: 'full',
      confidence: 0.9,
      securityRisk: 'low',
      maintained: true,
      license: 'MIT',
      compatibility: { status: 'compatible', reason: 'fixed wrapper', runtimeVersion: '0.1.1-rc.1' },
      missingCapabilities: [],
      findings: [],
      recommendation: 'use',
      installSpec: `file:${path.join(root, 'dsh-plugin-beta-fixed.tgz')}`,
    }
    const installs: Array<{ retention: string; replacement?: unknown }> = []
    workflowHost.listInstallProfiles = async () => ['web']
    workflowHost.latestReview = async () => fixedReview
    workflowHost.reviewExisting = async (resolution, target) => {
      expect(target).toMatchObject({
        kind: 'failed_install',
        dependencySpec: oldSpec,
      })
      await store.put('reviews', fixedReview)
      const next = {
        ...resolution,
        selectedRepositories: [target.repository],
        authorization: {
          state: 'confirmation_required' as const,
          resolutionId: resolution.id,
          reason: 'reviewed repaired source',
          reviewId: fixedReview.id,
        },
      }
      await store.put('resolutions', next)
      return { resolution: next, review: fixedReview }
    }
    workflowHost.installReviewed = async (_review, input) => {
      installs.push({ retention: input.retention, replacement: input.replacement })
      const installation: InstallationRecord = {
        schemaVersion: 1,
        id: `installation_${'9'.repeat(24)}`,
        createdAt: '2026-08-23T11:00:00.000Z',
        reviewId: fixedReview.id,
        targetProfile: input.targetProfile,
        retention: input.retention,
        dshHome: root,
        packageName: 'dsh-plugin-beta',
        installSpec: fixedReview.installSpec ?? '',
        installState: 'installed',
        installOutcome: 'activated',
        installed: true,
        loaded: false,
        verified: false,
        restartRequired: true,
        removed: false,
        verification: {
          attempted: true,
          expectedTools: [],
          calledTools: [],
          resultTools: [],
          failedTools: [],
          sessionFiles: [],
          taskResultObserved: false,
          layer: 'bundle_activation',
          status: 'passed',
          sourceMatched: true,
          reason: 'first persistent install activated',
        },
      }
      await store.put('installations', installation)
      return installation
    }
    const turn = exec()
    const { candidateId, reviewed } = await reviewInstalledCandidate(engine, guard, turn, record.requirement, '审查这份失败来源')
    expect(reviewed.workflow.cursor).toBe('await_confirmation')
    expect(reviewed.workflow.interrupt?.options.find((item) => item.id === 'use_this')?.candidateIds).toEqual([candidateId])
    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: '安装修好的这份' }] })
    const installed = await engine.resume({
      workflowId: reviewed.workflow.id,
      interruptId: reviewed.workflow.interrupt!.interruptId,
      decision: { action: 'use_this', candidateId },
    }, turn)
    expect(installed.workflow.lastFailure).toBeUndefined()
    expect(installs).toEqual([{ retention: 'persistent', replacement: undefined }])
    expect(installed.workflow.cursor).toBe('restart_required')
  })

  it('reviews an installed exact SHA into confirmation with modify_this and without search_more', async () => {
    const commit = '5'.repeat(40)
    const record = resolution('dsh-plugin-alpha')
    record.localCandidates[0] = installedPluginCandidate('dsh-plugin-alpha', 'anonymous-lab/dsh-plugin-alpha', commit, { description: 'synthetic provider synthetic model OAuth' })
    const { store, guard, workflowHost, engine } = await makeEngine(record, 'installed-review')
    const review: ReviewRecord = {
      schemaVersion: 1,
      id: `review_${'a'.repeat(64)}`,
      policyVersion: POLICY_VERSION,
      createdAt: '2026-08-22T00:00:00.000Z',
      resolutionId: record.id,
      requirement: 'dsh-plugin-alpha',
      sourceSnapshot: {
        kind: 'github',
        repository: 'anonymous-lab/dsh-plugin-alpha',
        requestedRef: commit,
        commit,
        defaultBranch: 'main',
      },
      inspectedFiles: [],
      manifest: {
        kind: 'bundle',
        packageName: 'dsh-plugin-alpha',
        scripts: [],
        dependencies: [],
        peerDependencies: {},
        expectedTools: [],
      },
      fit: 'full',
      confidence: 0.9,
      securityRisk: 'low',
      maintained: true,
      license: 'MIT',
      compatibility: { status: 'compatible', reason: 'ok', runtimeVersion: '0.1.0-rc.6' },
      missingCapabilities: [],
      findings: [],
      recommendation: 'modify',
      installSpec: `github:anonymous-lab/dsh-plugin-alpha#${commit}`,
    }
    workflowHost.listInstallProfiles = async () => ['web']
    workflowHost.reviewExisting = async (resolution, target) => {
      expect(target.commit).toBe(commit)
      await store.put('reviews', review)
      const next = {
        ...resolution,
        selectedRepositories: [target.repository],
        authorization: {
          state: 'confirmation_required' as const,
          resolutionId: resolution.id,
          reason: 'reviewed installed source',
          reviewId: review.id,
        },
      }
      await store.put('resolutions', next)
      return { resolution: next, review }
    }
    const turn = exec()
    const { selection } = await startAndPresent(engine, 'dsh-plugin-alpha', turn)
    const candidateId = selection.workflow.candidateSnapshot![0]!.id
    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: '审这个已装来源' }] })
    const reviewed = await engine.resume({
      workflowId: selection.workflow.id,
      interruptId: selection.workflow.interrupt!.interruptId,
      navigation: { kind: 'review_existing', candidateIds: [candidateId] },
    }, turn)
    expect(reviewed.workflow.cursor).toBe('await_confirmation')
    expect(reviewed.workflow.reviewIdsByCandidate?.[candidateId]).toBe(review.id)
    const optionIds = reviewed.workflow.interrupt?.options.map((item) => item.id) ?? []
    expect(optionIds).toContain('modify_this')
    expect(optionIds).not.toContain('search_more')
    expect(optionIds).not.toContain('review_candidates')
    expect(reviewed.workflow.interrupt?.options.find((item) => item.id === 'modify_this')?.candidateIds).toEqual([candidateId])
  })

  it('keeps the installed candidate through modify and sends replacement on use_this', async () => {
    const commit = '5'.repeat(40)
    const record = resolution('dsh-plugin-alpha')
    record.localCandidates[0] = installedPluginCandidate('dsh-plugin-alpha', 'anonymous-lab/dsh-plugin-alpha', commit, { description: 'synthetic provider synthetic model OAuth' })
    const { root, store, guard, workflowHost, engine } = await makeEngine(record, 'installed-replace')
    const githubReview: ReviewRecord = {
      schemaVersion: 1,
      id: `review_${'a'.repeat(64)}`,
      policyVersion: POLICY_VERSION,
      createdAt: '2026-08-22T00:00:00.000Z',
      resolutionId: record.id,
      requirement: 'dsh-plugin-alpha',
      sourceSnapshot: {
        kind: 'github',
        repository: 'anonymous-lab/dsh-plugin-alpha',
        requestedRef: commit,
        commit,
        defaultBranch: 'main',
      },
      inspectedFiles: [],
      manifest: {
        kind: 'bundle',
        packageName: 'dsh-plugin-alpha',
        scripts: [],
        dependencies: [],
        peerDependencies: {},
        expectedTools: [],
      },
      fit: 'full',
      confidence: 0.9,
      securityRisk: 'low',
      maintained: true,
      license: 'MIT',
      compatibility: { status: 'compatible', reason: 'ok', runtimeVersion: '0.1.0-rc.6' },
      missingCapabilities: [],
      findings: [],
      recommendation: 'modify',
      installSpec: `github:anonymous-lab/dsh-plugin-alpha#${commit}`,
    }
    const localReview: ReviewRecord = {
      ...githubReview,
      id: `review_${'b'.repeat(64)}`,
      sourceSnapshot: {
        kind: 'local',
        path: path.join(root, 'src'),
        baseReviewId: githubReview.id,
        baseCommit: commit,
        statusHash: 'c'.repeat(64),
      },
      installSpec: `file:${path.join(root, 'dsh-plugin-alpha.tgz')}`,
      recommendation: 'use',
    }
    let latest: ReviewRecord = githubReview
    const installs: Array<{ retention: string; replacement?: unknown }> = []
    workflowHost.listInstallProfiles = async () => ['web']
    workflowHost.latestReview = async () => latest
    workflowHost.reviewExisting = async (resolution, target) => {
      expect(target.repository).toBe('anonymous-lab/dsh-plugin-alpha')
      await store.put('reviews', githubReview)
      const next = {
        ...resolution,
        selectedRepositories: [target.repository],
        authorization: {
          state: 'confirmation_required' as const,
          resolutionId: resolution.id,
          reason: 'reviewed installed source',
          reviewId: githubReview.id,
        },
      }
      await store.put('resolutions', next)
      return { resolution: next, review: githubReview }
    }
    workflowHost.prepareModify = async (resolution, review, _exec, workflow) => {
      expect(review.id).toBe(githubReview.id)
      workflow.pendingPath = path.join(root, 'src')
      workflow.managedSourceId = 'anonymous-lab_dsh-plugin-alpha'
      return { resolution, path: workflow.pendingPath }
    }
    workflowHost.finishManagedWork = async (resolution, _exec, workflow) => {
      latest = localReview
      await store.put('reviews', localReview)
      workflow.lastReviewId = localReview.id
      workflow.lineageTipReviewId = localReview.id
      return { resolution, ...(workflow.pendingPath ? { path: workflow.pendingPath } : {}), review: localReview }
    }
    workflowHost.installReviewed = async (_review, input) => {
      installs.push({ retention: input.retention, replacement: input.replacement })
      const installation: InstallationRecord = {
        schemaVersion: 1,
        id: `installation_${'e'.repeat(24)}`,
        createdAt: new Date().toISOString(),
        reviewId: localReview.id,
        targetProfile: 'web',
        retention: 'persistent',
        dshHome: root,
        packageName: 'dsh-plugin-alpha',
        installSpec: localReview.installSpec ?? '',
        installState: 'installed',
        installOutcome: 'activated',
        installed: true,
        loaded: false,
        verified: false,
        restartRequired: true,
        removed: false,
        replacement: {
          state: 'new_present',
          oldSpecDigest: 'd'.repeat(64),
          newInstallSpec: localReview.installSpec ?? '',
          preparedAt: new Date().toISOString(),
        },
        verification: {
          attempted: true,
          expectedTools: [],
          calledTools: [],
          resultTools: [],
          failedTools: [],
          sessionFiles: [],
          taskResultObserved: false,
          layer: 'bundle_activation',
          status: 'passed',
          sourceMatched: true,
          reason: 'replaced',
        },
      }
      await store.put('installations', installation)
      return installation
    }
    const turn = exec()
    const { candidateId, reviewed } = await reviewInstalledCandidate(engine, guard, turn, 'dsh-plugin-alpha', '审已装来源')
    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: '在这个上改' }] })
    const modifying = await engine.resume({
      workflowId: reviewed.workflow.id,
      interruptId: reviewed.workflow.interrupt!.interruptId,
      decision: { action: 'modify_this', candidateId },
    }, turn)
    expect(modifying.workflow.cursor).toBe('await_modify_work')
    const finished = await engine.resume({
      workflowId: modifying.workflow.id,
      navigation: { kind: 'finish_managed_work' },
    }, turn)
    expect(finished.workflow.cursor).toBe('await_confirmation')
    expect(finished.workflow.reviewIdsByCandidate?.[candidateId]).toBe(localReview.id)
    expect(finished.workflow.interrupt?.options.map((item) => item.id)).toEqual(expect.arrayContaining(['use_this', 'modify_this']))
    expect(finished.workflow.interrupt?.options.map((item) => item.id)).not.toContain('search_more')
    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: '装回去' }] })
    const installed = await engine.resume({
      workflowId: finished.workflow.id,
      interruptId: finished.workflow.interrupt!.interruptId,
      decision: { action: 'use_this', candidateId },
    }, turn)
    expect(installs).toEqual([expect.objectContaining({
      retention: 'persistent',
      replacement: expect.objectContaining({
        profile: 'web',
        packageName: 'dsh-plugin-alpha',
        oldDependencySpec: `github:anonymous-lab/dsh-plugin-alpha#${commit}`,
      }),
    })])
    expect(installed.workflow.cursor).toBe('restart_required')
  })

  it('captures the original wording, clarifies once, and searches only after a fresh answer', async () => {
    const record = resolution('summary')
    record.decision = 'none'
    record.localCandidates[0] = { ...record.localCandidates[0]!, fit: 'partial' }
    record.remoteDiscoveryComplete = false
    const { engine, guard, workflowHost } = await makeEngine(record, 'clarification')
    const turn = exec('session-clarification')
    const bootstrap = vi.spyOn(workflowHost, 'bootstrapResolution')
    const discoverRemote = vi.spyOn(workflowHost, 'discoverRemote')
    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: '  帮我处理日期，但先别猜  ' }] })
    const started = await engine.start('date conversion summary', turn, {
      operation: 'discover_or_reuse',
      requiredSurface: 'native_dsh_plugin',
    }, '你需要哪一种日历转换？')
    expect(started.workflow).toMatchObject({
      schemaVersion: 3,
      cursor: 'await_clarification',
      requirement: '  帮我处理日期，但先别猜  ',
      requestSummary: 'date conversion summary',
    })
    expect(bootstrap).not.toHaveBeenCalled()

    const sameTurn = await engine.resume({
      workflowId: started.workflow.id,
      interruptId: started.workflow.interrupt!.interruptId,
      navigation: {
        kind: 'clarify_requirement',
        clarifiedIntent: { operation: 'discover_or_reuse', requiredSurface: 'native_dsh_plugin' },
      },
    }, turn)
    expect(sameTurn.alreadyWaiting).toBe(true)

    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: '是公历转农历，保留原格式。' }] })
    const searched = await engine.resume({
      workflowId: started.workflow.id,
      interruptId: started.workflow.interrupt!.interruptId,
      navigation: {
        kind: 'clarify_requirement',
        queries: ['gregorian lunar', '保留日期格式'],
        clarifiedIntent: { operation: 'discover_or_reuse', requiredSurface: 'native_dsh_plugin' },
      },
    }, turn)
    expect(searched.workflow.clarificationAnswer).toBe('是公历转农历，保留原格式。')
    expect(searched.workflow.discoveryQueries).toEqual(['gregorian lunar', '保留日期格式'])
    expect(searched.workflow.actionCommitment).toBeUndefined()
    expect(bootstrap).toHaveBeenCalledWith(
      '  帮我处理日期，但先别猜  \n\n是公历转农历，保留原格式。',
      turn,
      { operation: 'discover_or_reuse', requiredSurface: 'native_dsh_plugin' },
    )
    expect(discoverRemote).toHaveBeenCalledWith(expect.anything(), turn, {
      queries: ['gregorian lunar', '保留日期格式'],
    })
  })

  it('rejects pre-clarification queries so they cannot become a stale search plan', async () => {
    const { engine } = await makeEngine(resolution('summary'), 'stale-pre-clarification-query')
    await expect(engine.start(
      'date conversion summary',
      exec('session-stale-pre-clarification-query'),
      { operation: 'discover_or_reuse', requiredSurface: 'native_dsh_plugin' },
      '你需要哪一种日历转换？',
      ['date conversion'],
    )).rejects.toThrow(/queries must be omitted until the fresh clarification answer/i)
  })

  it('does not append an option-only clarification answer into search text', async () => {
    const { engine, guard, workflowHost } = await makeEngine(resolution('summary'), 'option-clarification')
    const turn = exec('session-option-clarification')
    const bootstrap = vi.spyOn(workflowHost, 'bootstrapResolution')
    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: '  帮我处理日期，但先别猜  ' }] })
    const started = await engine.start('date conversion summary', turn, {
      operation: 'discover_or_reuse',
      requiredSurface: 'native_dsh_plugin',
    }, '你需要哪一种日历转换？')
    const sameTurn = await engine.resume({
      workflowId: started.workflow.id,
      interruptId: started.workflow.interrupt!.interruptId,
      navigation: {
        kind: 'clarify_requirement',
        clarifiedIntent: { operation: 'discover_or_reuse', requiredSurface: 'native_dsh_plugin' },
      },
    }, turn)
    expect(sameTurn.alreadyWaiting).toBe(true)
    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: '1' }] })
    const searched = await engine.resume({
      workflowId: started.workflow.id,
      interruptId: started.workflow.interrupt!.interruptId,
      navigation: {
        kind: 'clarify_requirement',
        clarifiedIntent: { operation: 'discover_or_reuse', requiredSurface: 'native_dsh_plugin' },
      },
    }, turn)
    expect(searched.workflow.clarificationAnswer).toBe('1')
    expect(bootstrap).toHaveBeenCalledWith(
      '  帮我处理日期，但先别猜  ',
      turn,
      { operation: 'discover_or_reuse', requiredSurface: 'native_dsh_plugin' },
    )
  })

  it('supersedes a pending clarification when a fresh top-level requirement starts', async () => {
    const { engine, guard, store } = await makeEngine(resolution('first'), 'supersede')
    const turn = exec('session-supersede')
    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: '第一个含糊需求' }] })
    const first = await engine.start('first summary', turn, undefined, '你具体指什么？')
    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: '现在改成找农历转换插件' }] })
    const second = await engine.start('lunar calendar plugin', turn)
    expect(second.workflow.id).not.toBe(first.workflow.id)
    expect(await store.getWorkflow(first.workflow.id)).toMatchObject({
      status: 'completed',
      cursor: 'superseded',
      supersededByWorkflowId: second.workflow.id,
    })
  })

  it('retries a legacy pre-verification install only after a fresh receipt-bound decision', async () => {
    const record = resolution('calculator')
    const { root, store, guard, workflowHost, engine } = await makeEngine(record, 'legacy-preverify-retry')
    await store.put('resolutions', record)
    const workflowId = `workflow_${'6'.repeat(24)}`
    const reviewId = `review_${'7'.repeat(64)}`
    const candidateId = `candidate_${'8'.repeat(24)}`
    const installationId = `installation_${'9'.repeat(24)}`
    const repository = 'acme/retryable'
    const commit = 'a'.repeat(40)
    const inspected: ReviewRecord = {
      schemaVersion: 1,
      id: reviewId,
      policyVersion: POLICY_VERSION,
      createdAt: '2026-08-28T00:00:00.000Z',
      resolutionId: record.id,
      requirement: 'calculator',
      sourceSnapshot: { kind: 'github', repository, requestedRef: commit, commit, defaultBranch: 'main' },
      inspectedFiles: [],
      manifest: {
        kind: 'bundle',
        packageName: 'dsh-plugin-retryable',
        scripts: [],
        dependencies: [],
        peerDependencies: {},
        expectedTools: [],
      },
      fit: 'full',
      confidence: 0.9,
      securityRisk: 'low',
      maintained: true,
      license: 'MIT',
      compatibility: { status: 'compatible', reason: 'ok', runtimeVersion: '0.1.0-rc.6' },
      missingCapabilities: [],
      findings: [],
      recommendation: 'use',
      installSpec: `github:${repository}#${commit}`,
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
        expectedTools: [],
        toolFixtures: [],
        verificationLayer: 'manual_runtime',
      },
    }
    await store.put('reviews', inspected)
    const failed: InstallationRecord = {
      schemaVersion: 1,
      id: installationId,
      createdAt: '2026-08-28T00:00:01.000Z',
      reviewId,
      workflowId,
      targetProfile: 'web',
      retention: 'persistent',
      dshHome: root,
      packageName: 'dsh-plugin-retryable',
      installSpec: inspected.installSpec!,
      installState: 'not_installed',
      installOutcome: 'failed_absent',
      installed: false,
      loaded: false,
      verified: false,
      restartRequired: false,
      removed: false,
      verification: {
        attempted: false,
        expectedTools: [], calledTools: [], resultTools: [], failedTools: [], sessionFiles: [],
        taskResultObserved: false,
        reason: 'install failed before verification',
      },
      installFailure: { stage: 'install', code: 'command_failed', message: 'pnpm failed', retryable: true },
    }
    await store.put('installations', failed)
    const stored: WorkflowRecord = {
      schemaVersion: 2,
      id: workflowId,
      policyVersion: POLICY_VERSION,
      createdAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:01.000Z',
      requirement: 'calculator',
      requirementNormalized: 'calculator',
      cwd: root,
      ownerSessionId: 'session-1',
      bootId: 'boot_previous',
      resolutionId: record.id,
      status: 'interrupted',
      cursor: 'await_confirmation',
      generation: 2,
      intent: { operation: 'discover_or_reuse', requiredSurface: 'any' },
      candidateSnapshot: [{
        id: candidateId, index: 1, kind: 'remote', name: 'retryable', identity: repository,
        repository, digest: 'b'.repeat(64),
      }],
      reviewedCandidateIds: [candidateId],
      reviewIdsByCandidate: { [candidateId]: reviewId },
      lastReviewId: reviewId,
      lineageTipReviewId: reviewId,
      lastInstallationId: installationId,
      consumedVerificationAttempts: [
        { reviewId, sourceIdentity: `github:${repository}#${commit}`, layer: 'manual_runtime' },
        { reviewId, sourceIdentity: `github:${repository}#${commit}`, layer: 'tool_roundtrip' },
      ],
      lastFailure: { stage: 'install', code: 'command_failed', message: 'pnpm failed', retryable: true },
      interrupt: {
        kind: 'await_confirmation', options: [], facts: {},
        interruptId: `interrupt_${'1'.repeat(24)}`,
        ownerSessionId: 'session-1', bootId: 'boot_previous',
        validAfterTurnId: `turn_${'2'.repeat(24)}`, snapshotDigest: '3'.repeat(64),
      },
    }
    await store.put('workflows', stored)
    workflowHost.listInstallProfiles = async () => ['web']
    workflowHost.latestReview = async () => inspected
    const installCalls: WorkflowRecord[] = []
    workflowHost.installReviewed = async (_review, input, _exec, activeWorkflow) => {
      if (!activeWorkflow) throw new Error('expected workflow binding')
      installCalls.push(structuredClone(activeWorkflow))
      return {
        ...failed,
        id: activeWorkflow.pendingInstallationId!,
        createdAt: '2026-08-28T00:00:03.000Z',
        installState: 'installed',
        installOutcome: 'awaiting_user_test',
        installed: true,
        loaded: true,
        removed: false,
        targetProfile: input.targetProfile,
        retention: input.retention,
        verification: { ...failed.verification, attempted: true, status: 'pending_user_test', reason: 'await user test' },
        installFailure: undefined,
      } as unknown as InstallationRecord
    }
    const turn = exec('session-1', root)

    const reissued = await engine.start('calculator', turn)
    expect(reissued.workflow.interrupt?.options.find((item) => item.id === 'use_this')?.candidateIds)
      .toEqual([candidateId])
    expect(installCalls).toHaveLength(0)

    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: '重试安装这个候选' }] })
    const retried = await engine.resume({
      workflowId,
      interruptId: reissued.workflow.interrupt!.interruptId,
      decision: { action: 'use_this', candidateId },
    }, turn)

    expect(installCalls).toHaveLength(1)
    expect(installCalls[0]!.actionCommitment).toBeDefined()
    expect(installCalls[0]!.consumedVerificationAttempts).toEqual([{
      reviewId,
      sourceIdentity: `github:${repository}#${commit}`,
      layer: 'tool_roundtrip',
    }])
    expect(retried.workflow.cursor).toBe('awaiting_user_test')
  })
})
