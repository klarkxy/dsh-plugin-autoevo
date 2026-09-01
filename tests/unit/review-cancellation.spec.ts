import os from 'node:os'
import path from 'node:path'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { testRuntimeConfig } from '../helpers/runtime-config.js'
import { testReview } from '../helpers/records.js'
import { trackTempDirs } from '../helpers/temp-dirs.js'
import { POLICY_VERSION, type EvolutionTarget, type ResolutionRecord } from '../../src/contracts.js'
import { CreationGuard } from '../../src/creation-guard.js'
import type { CommandRunner } from '../../src/process/runner.js'
import { reviewGithubPluginWithFiles, reviewLocalPlugin } from '../../src/review/index.js'
import { evaluatePluginContent } from '../../src/review/review.js'
import { dependencySpecDigest } from '../../src/resolver/installed-origin.js'
import { CapabilityEvolutionService } from '../../src/service.js'
import { dshRuntimeVersion, revalidateReview, reviewAndFreezeManagedSource, type ReviewOrchestrationDeps } from '../../src/service-review.js'
import type { SourceReceipt } from '../../src/source-manager.js'
import { hashObject } from '../../src/state/hashes.js'
import { sha256 } from '../../src/state/hashes.js'
import { StateStore } from '../../src/state/store.js'
import type { WorkflowExec, WorkflowRecord } from '../../src/workflow/contracts.js'

vi.mock('../../src/review/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/review/index.js')>()
  return { ...actual, reviewGithubPluginWithFiles: vi.fn(), reviewLocalPlugin: vi.fn() }
})

const temporary = trackTempDirs()

async function batchFixture(root: string): Promise<{
  store: StateStore
  service: CapabilityEvolutionService
  resolution: ResolutionRecord
  workflow: WorkflowRecord
  repositories: string[]
  candidateIds: string[]
}> {
  const config = testRuntimeConfig(root)
  const store = new StateStore(root)
  const repositories = ['acme/alpha', 'acme/beta', 'acme/gamma']
  const candidateIds = [
    `candidate_${'1'.repeat(24)}`,
    `candidate_${'2'.repeat(24)}`,
    `candidate_${'3'.repeat(24)}`,
  ]
  const resolution: ResolutionRecord = {
    schemaVersion: 2,
    id: `resolution_${'a'.repeat(24)}`,
    policyVersion: POLICY_VERSION,
    createdAt: '2026-08-31T00:00:00.000Z',
    requirement: 'review candidates',
    cwd: root,
    decision: 'inspect_remote',
    localCandidates: [],
    remoteCandidates: repositories.map((repository, index) => ({
      repository,
      name: `candidate-${index + 1}`,
      description: 'candidate',
      stars: 1,
      updatedAt: null,
      topics: [],
    })),
    remoteDiscoveryComplete: true,
    authorization: { state: 'selection_required', resolutionId: `resolution_${'a'.repeat(24)}`, reason: 'wait' },
    selectedRepositories: repositories,
    queries: [],
    reasons: [],
  }
  await store.put('resolutions', resolution)
  const workflow: WorkflowRecord = {
    schemaVersion: 2,
    id: `workflow_${'b'.repeat(24)}`,
    policyVersion: POLICY_VERSION,
    createdAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-08-31T00:00:00.000Z',
    requirement: resolution.requirement,
    status: 'running',
    cursor: 'review_github',
    generation: 1,
    candidateSnapshot: repositories.map((repository, index) => ({
      id: candidateIds[index]!,
      index: index + 1,
      kind: 'remote',
      name: `candidate-${index + 1}`,
      identity: repository,
      repository,
      commit: String(index + 1).repeat(40),
      digest: String(index + 4).repeat(64),
    })),
  }
  const runner: CommandRunner = {
    async run() {
      return { exitCode: 0, signal: null, stdout: '0.1.0-rc.6\n', stderr: '' }
    },
  }
  const service = new CapabilityEvolutionService(
    { get: () => undefined } as unknown as Context,
    config,
    runner,
    store,
    new CreationGuard({ isEvolutionMode: () => true }),
  )
  return { store, service, resolution, workflow, repositories, candidateIds }
}

function githubEvidence(options: Parameters<typeof reviewGithubPluginWithFiles>[0]) {
  const files = [
    { path: 'package.json', content: Buffer.from(JSON.stringify({ name: options.repository.replace('/', '-') })) },
  ]
  return {
    files,
    record: evaluatePluginContent({
      resolutionId: options.resolutionId,
      requirement: options.requirement,
      sourceSnapshot: {
        kind: 'github' as const,
        repository: options.repository,
        requestedRef: options.ref,
        commit: options.ref,
        defaultBranch: 'main',
      },
      files,
      runtimeVersion: '0.1.0-rc.6',
    }),
  }
}

describe('formal review cancellation', () => {
  async function exactInstalledReviewFixture(root: string) {
    const fixture = await batchFixture(root)
    const dependencySpec = `github:acme/alpha#${'1'.repeat(40)}`
    const target: EvolutionTarget = {
      kind: 'github_exact',
      repository: 'acme/alpha',
      commit: '1'.repeat(40),
      packageName: 'acme-alpha',
      profile: 'web',
      dependencySpec,
      specDigest: dependencySpecDigest(dependencySpec),
    }
    fixture.workflow.pendingReviewedCandidateId = fixture.candidateIds[0]!
    fixture.workflow.candidateSnapshot = [{
      id: fixture.candidateIds[0]!,
      index: 1,
      kind: 'local',
      name: target.packageName,
      identity: target.packageName,
      digest: '4'.repeat(64),
      evolutionTarget: target,
    }]
    const internals = fixture.service as unknown as {
      currentProfileOwner: () => Promise<string>
      launcher: { profileDependencySpec: (dshHome: string, profile: string, packageName: string) => Promise<string | undefined> }
      runner: CommandRunner
    }
    const owner = vi.spyOn(internals, 'currentProfileOwner').mockResolvedValue('web')
    const profileSpec = vi.spyOn(internals.launcher, 'profileDependencySpec').mockResolvedValue(dependencySpec)
    const runnerRun = vi.spyOn(internals.runner, 'run')
    return { ...fixture, target, owner, profileSpec, runnerRun }
  }

  it('rethrows the exact reason when frozen-artifact revalidation is already cancelled', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-revalidate-cancel-'))
    temporary.push(root)
    const artifactRoot = path.join(root, 'artifact')
    const artifactPath = path.join(artifactRoot, 'package', 'reviewed.tgz')
    const artifact = Buffer.from('frozen review')
    await mkdir(path.dirname(artifactPath), { recursive: true })
    await writeFile(artifactPath, artifact)
    const current = testReview({
      installSpec: `file:${artifactPath.replaceAll('\\', '/')}`,
      artifact: {
        sha256: sha256(artifact),
        bytes: artifact.byteLength,
        entryCount: 1,
        ownedRoot: artifactRoot,
      },
    })
    const controller = new AbortController()
    const reason = new Error('cancel review revalidation')
    controller.abort(reason)
    await expect(revalidateReview({} as ReviewOrchestrationDeps, current, controller.signal)).rejects.toBe(reason)
  })

  it('rethrows the exact abort reason when runtime-version probing fails during cancellation', async () => {
    const controller = new AbortController()
    const reason = new Error('runtime version cancelled')
    const runner: CommandRunner = {
      async run() {
        controller.abort(reason)
        throw reason
      },
    }

    let failure: unknown
    try {
      await dshRuntimeVersion({ runner, config: testRuntimeConfig(process.cwd()) }, process.cwd(), controller.signal)
    } catch (error) {
      failure = error
    }
    expect(failure).toBe(reason)
  })

  it.each([
    ['owner mismatch', async (fixture: Awaited<ReturnType<typeof exactInstalledReviewFixture>>) => {
      fixture.owner.mockResolvedValue('desktop')
    }],
    ['dependency absent', async (fixture: Awaited<ReturnType<typeof exactInstalledReviewFixture>>) => {
      fixture.profileSpec.mockResolvedValue(undefined)
    }],
    ['dependency drift', async (fixture: Awaited<ReturnType<typeof exactInstalledReviewFixture>>) => {
      fixture.profileSpec.mockResolvedValue(`github:acme/alpha#${'2'.repeat(40)}`)
    }],
    ['dependency unreadable', async (fixture: Awaited<ReturnType<typeof exactInstalledReviewFixture>>) => {
      fixture.profileSpec.mockRejectedValue(new Error('manifest unreadable'))
    }],
  ] as const)('fails closed before review work when exact installed-source %s', async (_label, arrange) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-exact-review-drift-'))
    temporary.push(root)
    const fixture = await exactInstalledReviewFixture(root)
    await arrange(fixture)
    fixture.runnerRun.mockClear()
    vi.mocked(reviewGithubPluginWithFiles).mockClear()
    const put = vi.spyOn(fixture.store, 'put')

    await expect(fixture.service.reviewExisting(
      fixture.resolution,
      fixture.target,
      {},
      fixture.workflow,
    )).rejects.toMatchObject({ code: 'review_expired' })

    expect(fixture.runnerRun).not.toHaveBeenCalled()
    expect(reviewGithubPluginWithFiles).not.toHaveBeenCalled()
    expect(put).not.toHaveBeenCalled()
  })

  it('preserves exact cancellation after the installed dependency read and starts no review work', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-exact-review-cancel-'))
    temporary.push(root)
    const fixture = await exactInstalledReviewFixture(root)
    const controller = new AbortController()
    const reason = new Error('cancel exact installed review')
    fixture.profileSpec.mockImplementation(async () => {
      controller.abort(reason)
      return fixture.target.dependencySpec
    })
    fixture.runnerRun.mockClear()
    vi.mocked(reviewGithubPluginWithFiles).mockClear()
    const put = vi.spyOn(fixture.store, 'put')

    await expect(fixture.service.reviewExisting(
      fixture.resolution,
      fixture.target,
      { signal: controller.signal },
      fixture.workflow,
    )).rejects.toBe(reason)

    expect(fixture.runnerRun).not.toHaveBeenCalled()
    expect(reviewGithubPluginWithFiles).not.toHaveBeenCalled()
    expect(put).not.toHaveBeenCalled()
  })

  it('allows exact current GitHub evidence through the installed-source review guard', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-exact-review-current-'))
    temporary.push(root)
    const fixture = await exactInstalledReviewFixture(root)
    vi.mocked(reviewGithubPluginWithFiles).mockImplementation(async (options) => githubEvidence(options))

    const result = await fixture.service.reviewExisting(
      fixture.resolution,
      fixture.target,
      {},
      fixture.workflow,
    )

    expect(result.review.sourceSnapshot).toMatchObject({
      kind: 'github',
      repository: fixture.target.repository,
      commit: fixture.target.commit,
    })
    expect(fixture.profileSpec).toHaveBeenCalledWith(
      expect.any(String),
      fixture.target.profile,
      fixture.target.packageName,
    )
    expect(reviewGithubPluginWithFiles).toHaveBeenCalledTimes(1)
  })

  it('does not persist or advance an aborted batch and does not start its adaptive third candidate', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-review-batch-cancel-'))
    temporary.push(root)
    const config = testRuntimeConfig(root)
    const store = new StateStore(root)
    const repositories = ['acme/alpha', 'acme/beta', 'acme/gamma']
    const candidateIds = [
      `candidate_${'1'.repeat(24)}`,
      `candidate_${'2'.repeat(24)}`,
      `candidate_${'3'.repeat(24)}`,
    ]
    const resolution: ResolutionRecord = {
      schemaVersion: 2,
      id: `resolution_${'a'.repeat(24)}`,
      policyVersion: POLICY_VERSION,
      createdAt: '2026-08-31T00:00:00.000Z',
      requirement: 'review candidates',
      cwd: root,
      decision: 'inspect_remote',
      localCandidates: [],
      remoteCandidates: repositories.map((repository, index) => ({
        repository,
        name: `candidate-${index + 1}`,
        description: 'candidate',
        stars: 1,
        updatedAt: null,
        topics: [],
      })),
      remoteDiscoveryComplete: true,
      authorization: { state: 'selection_required', resolutionId: `resolution_${'a'.repeat(24)}`, reason: 'wait' },
      selectedRepositories: repositories,
      queries: [],
      reasons: [],
    }
    await store.put('resolutions', resolution)
    const workflow: WorkflowRecord = {
      schemaVersion: 2,
      id: `workflow_${'b'.repeat(24)}`,
      policyVersion: POLICY_VERSION,
      createdAt: '2026-08-31T00:00:00.000Z',
      updatedAt: '2026-08-31T00:00:00.000Z',
      requirement: resolution.requirement,
      status: 'running',
      cursor: 'review_github',
      generation: 1,
      candidateSnapshot: repositories.map((repository, index) => ({
        id: candidateIds[index]!,
        index: index + 1,
        kind: 'remote',
        name: `candidate-${index + 1}`,
        identity: repository,
        repository,
        commit: String(index + 1).repeat(40),
        digest: String(index + 4).repeat(64),
      })),
    }
    const runner: CommandRunner = {
      async run() {
        return { exitCode: 0, signal: null, stdout: '0.1.0-rc.6\n', stderr: '' }
      },
    }
    const service = new CapabilityEvolutionService(
      { get: () => undefined } as unknown as Context,
      config,
      runner,
      store,
      new CreationGuard({ isEvolutionMode: () => true }),
    )
    const controller = new AbortController()
    const reason = new Error('batch review cancelled')
    const started: string[] = []
    vi.mocked(reviewGithubPluginWithFiles).mockImplementation(async (options) => {
      started.push(options.repository)
      expect(options.signal).toBe(controller.signal)
      controller.abort(reason)
      throw reason
    })

    let failure: unknown
    try {
      await service.reviewGithubBatch(
        resolution,
        candidateIds,
        'adaptive',
        { signal: controller.signal } as WorkflowExec,
        workflow,
      )
    } catch (error) {
      failure = error
    }

    expect(failure).toBe(reason)
    expect(started).toEqual(repositories.slice(0, 2))
    await expect(store.getResolution(resolution.id)).resolves.toEqual(resolution)
    await expect(store.listReviews(resolution.id)).resolves.toEqual([])
  })

  it('maps one ordinary review persistence failure to its candidate while keeping the successful review', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-review-persist-failure-'))
    temporary.push(root)
    const fixture = await batchFixture(root)
    vi.mocked(reviewGithubPluginWithFiles).mockImplementation(async (options) => githubEvidence(options))
    const originalPut = fixture.store.put.bind(fixture.store)
    let reviewPuts = 0
    vi.spyOn(fixture.store, 'put').mockImplementation(async (kind, record) => {
      if (kind === 'reviews') {
        reviewPuts += 1
        if (reviewPuts === 2) throw new Error('review receipt persistence failed')
      }
      await originalPut(kind, record)
    })

    const result = await fixture.service.reviewGithubBatch(
      fixture.resolution,
      fixture.candidateIds.slice(0, 2),
      'fixed',
      {} as WorkflowExec,
      fixture.workflow,
    )

    expect(result.reviews).toHaveLength(1)
    expect(result.failures).toEqual([expect.objectContaining({
      candidateId: fixture.candidateIds[1],
      repository: fixture.repositories[1],
      code: 'command_failed',
      message: 'review receipt persistence failed',
    })])
    await expect(fixture.store.listReviews(fixture.resolution.id)).resolves.toHaveLength(1)
  })

  it('treats an abort during the last initial review commit as terminal before candidate three or resolution persistence', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-review-persist-abort-'))
    temporary.push(root)
    const fixture = await batchFixture(root)
    const controller = new AbortController()
    const reason = new Error('abort during committed review put')
    const started: string[] = []
    vi.mocked(reviewGithubPluginWithFiles).mockImplementation(async (options) => {
      started.push(options.repository)
      expect(options.signal).toBe(controller.signal)
      return githubEvidence(options)
    })
    const originalPut = fixture.store.put.bind(fixture.store)
    let reviewPuts = 0
    let resolutionPuts = 0
    vi.spyOn(fixture.store, 'put').mockImplementation(async (kind, record) => {
      if (kind === 'resolutions') resolutionPuts += 1
      await originalPut(kind, record)
      if (kind === 'reviews') {
        reviewPuts += 1
        if (reviewPuts === 2) controller.abort(reason)
      }
    })

    let failure: unknown
    try {
      await fixture.service.reviewGithubBatch(
        fixture.resolution,
        fixture.candidateIds,
        'fixed',
        { signal: controller.signal } as WorkflowExec,
        fixture.workflow,
      )
    } catch (error) {
      failure = error
    }

    expect(failure).toBe(reason)
    expect(started).toEqual(fixture.repositories.slice(0, 2))
    expect(reviewPuts).toBe(2)
    expect(resolutionPuts).toBe(0)
    await expect(fixture.store.listReviews(fixture.resolution.id)).resolves.toHaveLength(2)
    await expect(fixture.store.getResolution(fixture.resolution.id)).resolves.toEqual(fixture.resolution)
  })

  it.each([
    { stage: 'review' as const, expected: { reviewPuts: 1, artifactPuts: 0, resolutionPuts: 0 } },
    { stage: 'artifact' as const, expected: { reviewPuts: 1, artifactPuts: 1, resolutionPuts: 0 } },
    { stage: 'resolution' as const, expected: { reviewPuts: 1, artifactPuts: 1, resolutionPuts: 1 } },
  ])('stops managed review with the exact reason after the $stage persistence commit', async ({ stage, expected }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), `autoevo-managed-review-${stage}-abort-`))
    temporary.push(root)
    const config = testRuntimeConfig(root)
    const store = new StateStore(root)
    const controller = new AbortController()
    const reason = new Error(`abort after managed ${stage} persistence`)
    const workflowId = `workflow_${'7'.repeat(24)}`
    const sourceId = 'managed_review_source'
    const sourcePath = path.join(root, 'source')
    const resolution: ResolutionRecord = {
      schemaVersion: 2,
      id: `resolution_${'8'.repeat(24)}`,
      policyVersion: POLICY_VERSION,
      createdAt: '2026-08-31T00:00:00.000Z',
      requirement: 'review managed source',
      cwd: root,
      decision: 'inspect_remote',
      localCandidates: [],
      remoteCandidates: [],
      remoteDiscoveryComplete: true,
      authorization: { state: 'selection_required', resolutionId: `resolution_${'8'.repeat(24)}`, reason: 'wait' },
      queries: [],
      reasons: [],
    }
    const record = testReview({
      resolutionId: resolution.id,
      requirement: resolution.requirement,
      sourceSnapshot: {
        kind: 'local',
        path: sourcePath,
        baseReviewId: `review_${'9'.repeat(64)}`,
        baseCommit: 'a'.repeat(40),
        statusHash: 'b'.repeat(64),
      },
      artifact: {
        sha256: 'c'.repeat(64),
        bytes: 8,
        entryCount: 1,
        ownedRoot: path.join(root, 'review-artifacts', 'managed'),
      },
      installSpec: `file:${path.join(root, 'review-artifacts', 'managed', 'package.tgz')}`,
    })
    vi.mocked(reviewLocalPlugin).mockResolvedValue({ record, contentHash: 'e'.repeat(64), files: [] })
    const receipt: SourceReceipt = {
      sourceId,
      repository: null,
      path: sourcePath,
      baseCommit: 'a'.repeat(40),
      branch: `autoevo/${workflowId}`,
      headCommit: 'a'.repeat(40),
      reviewId: `review_${'9'.repeat(64)}`,
      artifactHash: null,
      activeWorkflowId: workflowId,
      gitConfigHash: 'd'.repeat(64),
    }
    let artifactPuts = 0
    const sources = {
      async readReceipt() { return receipt },
      async recordReviewedArtifact() {
        artifactPuts += 1
        if (stage === 'artifact') controller.abort(reason)
        return { ...receipt, reviewId: record.id, artifactHash: record.artifact!.sha256 }
      },
    }
    let reviewPuts = 0
    let resolutionPuts = 0
    const originalPut = store.put.bind(store)
    vi.spyOn(store, 'put').mockImplementation(async (kind, persisted) => {
      await originalPut(kind, persisted)
      if (kind === 'reviews') {
        reviewPuts += 1
        if (stage === 'review') controller.abort(reason)
      }
      if (kind === 'resolutions') {
        resolutionPuts += 1
        if (stage === 'resolution') controller.abort(reason)
      }
    })
    const runner: CommandRunner = {
      async run() {
        return { exitCode: 0, signal: null, stdout: '0.1.0-rc.6\n', stderr: '' }
      },
    }
    const deps = {
      runner,
      config,
      store,
      sources,
      launcher: {},
    } as unknown as ReviewOrchestrationDeps

    await expect(reviewAndFreezeManagedSource(deps, {
      resolution,
      sourceId,
      path: sourcePath,
      baseReviewId: `review_${'9'.repeat(64)}`,
      lineageRootCommit: 'a'.repeat(40),
      workflowId,
      exec: { signal: controller.signal } as WorkflowExec,
    })).rejects.toBe(reason)
    expect({ reviewPuts, artifactPuts, resolutionPuts }).toEqual(expected)
  })

  it('preserves the exact managed-review abort when unsignaled cleanup also fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-managed-review-cleanup-failure-'))
    temporary.push(root)
    const fixture = await batchFixture(root)
    const controller = new AbortController()
    const reason = new Error('managed review primary abort')
    const cleanupFailure = new Error('managed source cleanup failed')
    const sourceId = 'managed_cleanup_source'
    const prior = testReview({
      resolutionId: fixture.resolution.id,
      sourceSnapshot: {
        kind: 'local',
        path: path.join(root, 'source'),
        baseReviewId: `review_${'a'.repeat(64)}`,
        baseCommit: 'b'.repeat(40),
        statusHash: 'c'.repeat(64),
      },
      installSpec: `file:${path.join(root, 'prior.tgz')}`,
    })
    await fixture.store.put('reviews', prior)
    const target: EvolutionTarget = {
      kind: 'managed_local',
      repository: '',
      commit: 'b'.repeat(40),
      packageName: prior.manifest.packageName!,
      profile: 'web',
      dependencySpec: prior.installSpec!,
      specDigest: 'd'.repeat(64),
      reviewId: prior.id,
      sourceId,
    }
    fixture.workflow.pendingReviewedCandidateId = `candidate_${'e'.repeat(24)}`
    fixture.workflow.candidateSnapshot = [{
      id: fixture.workflow.pendingReviewedCandidateId,
      index: 1,
      kind: 'local',
      name: target.packageName,
      identity: target.packageName,
      digest: 'f'.repeat(64),
      evolutionTarget: target,
    }]
    const receipt: SourceReceipt = {
      sourceId,
      repository: null,
      path: prior.sourceSnapshot.kind === 'local' ? prior.sourceSnapshot.path : root,
      baseCommit: target.commit,
      branch: `autoevo/${fixture.workflow.id}`,
      headCommit: target.commit,
      reviewId: prior.id,
      artifactHash: prior.artifact?.sha256 ?? '1'.repeat(64),
      activeWorkflowId: null,
      gitConfigHash: '2'.repeat(64),
    }
    vi.spyOn(fixture.service.sources, 'validateCompletedSnapshot').mockResolvedValue(receipt)
    vi.spyOn(fixture.service.sources, 'claimCompletedSourceForWorkflow').mockResolvedValue({
      ...receipt,
      activeWorkflowId: fixture.workflow.id,
    })
    vi.spyOn(fixture.service.sources, 'readReceipt').mockResolvedValue({
      ...receipt,
      activeWorkflowId: fixture.workflow.id,
    })
    const cleanup = vi.spyOn(fixture.service.sources, 'completeWorkflow').mockRejectedValue(cleanupFailure)
    vi.mocked(reviewLocalPlugin).mockImplementation(async () => {
      controller.abort(reason)
      throw reason
    })

    await expect(fixture.service.reviewExisting(
      fixture.resolution,
      target,
      { signal: controller.signal } as WorkflowExec,
      fixture.workflow,
    )).rejects.toBe(reason)
    expect(cleanup).toHaveBeenCalledWith(sourceId, fixture.workflow.id)
  })

  it('preserves an abort racing optional managed review lookup and starts no source or review work', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-managed-review-lookup-cancel-'))
    temporary.push(root)
    const fixture = await batchFixture(root)
    const controller = new AbortController()
    const reason = new Error('managed prior review lookup cancelled')
    const target: EvolutionTarget = {
      kind: 'managed_local',
      repository: '',
      commit: 'b'.repeat(40),
      packageName: 'dsh-plugin-managed',
      profile: 'web',
      dependencySpec: 'file:C:/state/managed.tgz',
      specDigest: 'd'.repeat(64),
      reviewId: `review_${'e'.repeat(64)}`,
      sourceId: 'managed_lookup_source',
    }
    fixture.workflow.pendingReviewedCandidateId = `candidate_${'e'.repeat(24)}`
    fixture.workflow.candidateSnapshot = [{
      id: fixture.workflow.pendingReviewedCandidateId,
      index: 1,
      kind: 'local',
      name: target.packageName,
      identity: target.packageName,
      digest: 'f'.repeat(64),
      evolutionTarget: target,
    }]
    vi.spyOn(fixture.store, 'getReview').mockImplementation(async () => {
      controller.abort(reason)
      throw new Error('ordinary review read failure')
    })
    const claim = vi.spyOn(fixture.service.sources, 'claimCompletedSourceForWorkflow')
    const put = vi.spyOn(fixture.store, 'put')
    vi.mocked(reviewLocalPlugin).mockClear()

    await expect(fixture.service.reviewExisting(
      fixture.resolution,
      target,
      { signal: controller.signal } as WorkflowExec,
      fixture.workflow,
    )).rejects.toBe(reason)
    expect(claim).not.toHaveBeenCalled()
    expect(reviewLocalPlugin).not.toHaveBeenCalled()
    expect(put).not.toHaveBeenCalled()
  })
})
