import { spawn } from 'node:child_process'
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { testRuntimeConfig } from '../helpers/runtime-config.js'
import { trackTempDirs } from '../helpers/temp-dirs.js'
import type { RuntimeConfig } from '../../src/config.js'
import { POLICY_VERSION, type EvolutionTarget, type ResolutionRecord, type ReviewRecord } from '../../src/contracts.js'
import { CreationGuard } from '../../src/creation-guard.js'
import type { ManagedChildHost, ManagedChildRequest } from '../../src/managed-child.js'
import type { CommandRequest, CommandResult, CommandRunner } from '../../src/process/runner.js'
import { testingCreatorFoundation, testingCreatorPreflight } from '../../src/creator-foundation.js'
import { mintCreatorReceipt } from '../../src/creator-foundation.js'
import { CapabilityEvolutionService } from '../../src/service.js'
import { dependencySpecDigest } from '../../src/resolver/installed-origin.js'
import { StateStore } from '../../src/state/store.js'
import type { WorkflowRecord } from '../../src/workflow/contracts.js'

const temporary = trackTempDirs()

function managedChild(...edits: Array<(request: ManagedChildRequest) => Promise<void>>): ManagedChildHost {
  let run = 0
  return {
    async run(request) {
      const index = run++
      const edit = edits[index]
      if (!edit) throw new Error(`unexpected managed child run ${index + 1}`)
      await edit(request)
      const sessionId = `child-${index + 1}`
      const preflight = request.preflight ?? testingCreatorPreflight()
      return {
        sessionId,
        taskResult: 'implemented\nAUTOEVO_CHILD_COMPLETED',
        sandbox: { ok: true, cwd: request.cwd, mode: 'workspace-write' } as never,
        creator: mintCreatorReceipt(preflight, sessionId),
      }
    },
  }
}

class NativeRunner implements CommandRunner {
  async run(request: CommandRequest): Promise<CommandResult> {
    if (request.argv[0] === 'dsh' && request.argv.includes('--version')) {
      return { exitCode: 0, signal: null, stdout: '0.1.0-rc.6\n', stderr: '' }
    }
    if (request.argv[0] === 'gh' && request.argv[1] === 'api') {
      const endpoint = request.argv.at(-1)!
      const commitMatch = /^repos\/acme\/repaired\/commits\/([a-f0-9]{40})$/u.exec(endpoint)
      if (commitMatch) {
        return {
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify({ sha: commitMatch[1], commit: { committer: { date: new Date().toISOString() } } }),
          stderr: '',
        }
      }
      if (endpoint === 'repos/acme/repaired') {
        return { exitCode: 0, signal: null, stdout: JSON.stringify({ default_branch: 'main' }), stderr: '' }
      }
      if (/^repos\/acme\/repaired\/git\/trees\/[a-f0-9]{40}\?recursive=1$/u.test(endpoint)) {
        return {
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify({
            truncated: false,
            tree: [
              { path: 'package.json', type: 'blob', sha: '1'.repeat(40), size: 256 },
              { path: 'cordis.patch.yml', type: 'blob', sha: '2'.repeat(40), size: 64 },
              { path: 'lib/index.js', type: 'blob', sha: '3'.repeat(40), size: 64 },
              { path: 'LICENSE', type: 'blob', sha: '4'.repeat(40), size: 4 },
            ],
          }),
          stderr: '',
        }
      }
      const blobMatch = /^repos\/acme\/repaired\/git\/blobs\/([1-4])\1{39}$/u.exec(endpoint)
      if (blobMatch) {
        const contents: Record<string, string> = {
          '1': `${JSON.stringify({
            name: 'dsh-plugin-repaired',
            version: '1.0.0',
            type: 'module',
            main: './lib/index.js',
            dsh: { bundle: { patch: './cordis.patch.yml' } },
            peerDependencies: {
              '@deepseek-ai/cordis': '^4.0.1',
              '@deepseek-ai/dsh-tools': '>=0.1.0-rc.6 <0.2.0',
            },
            license: 'MIT',
          }, null, 2)}\n`,
          '2': '- id: repaired\n  name: dsh-plugin-repaired\n',
          '3': 'export function apply() {}\n',
          '4': 'MIT\n',
        }
        return {
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify({ encoding: 'base64', content: Buffer.from(contents[blobMatch[1]!]!).toString('base64') }),
          stderr: '',
        }
      }
      return { exitCode: 1, signal: null, stdout: '', stderr: `unexpected gh endpoint: ${endpoint}` }
    }
    return await new Promise((resolve, reject) => {
      const [command, ...args] = request.argv
      const child = spawn(command, args, {
        cwd: request.cwd,
        env: { ...process.env, ...request.env },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
      child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
      child.once('error', reject)
      child.once('close', (exitCode, signal) => resolve({ exitCode, signal: signal as NodeJS.Signals | null, stdout, stderr }))
    })
  }
}

function config(root: string): RuntimeConfig {
  return testRuntimeConfig(root, {
    stateDir: path.join(root, 'state'),
    sourceDir: path.join(root, 'state', 'sources'),
  })
}

function resolution(root: string): ResolutionRecord {
  return {
    schemaVersion: 2,
    id: `resolution_${'a'.repeat(24)}`,
    policyVersion: POLICY_VERSION,
    createdAt: new Date().toISOString(),
    requirement: 'provide a hello tool',
    cwd: root,
    decision: 'inspect_remote',
    localCandidates: [],
    remoteCandidates: [],
    remoteDiscoveryComplete: true,
    authorization: { state: 'create_authorized', resolutionId: `resolution_${'a'.repeat(24)}`, reason: 'explicit user decision' },
    queries: [],
    reasons: [],
  }
}

function workflow(): WorkflowRecord {
  return {
    schemaVersion: 1,
    id: `workflow_${'b'.repeat(24)}`,
    policyVersion: POLICY_VERSION,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    requirement: 'provide a hello tool',
    status: 'running',
    cursor: 'prepare_create',
    generation: 1,
  }
}

describe('managed create vertical flow', () => {
  it('runs the managed child, then commits, reviews, and freezes a real npm tgz before returning', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-managed-create-e2e-'))
    temporary.push(root)
    const preflight = testingCreatorPreflight()
    const runner = new NativeRunner()
    const cfg = config(root)
    const store = new StateStore(cfg.stateDir!)
    const child = managedChild(async ({ cwd }) => {
      const pkgPath = path.join(cwd, 'package.json')
      const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
      await writeFile(pkgPath, `${JSON.stringify({ ...pkg, license: 'MIT' }, null, 2)}\n`)
      await writeFile(path.join(cwd, 'lib', 'index.js'), "export const name = 'hello-plugin'\nexport function apply() {}\n")
      await writeFile(path.join(cwd, 'LICENSE'), 'MIT\n')
    })
    const service = new CapabilityEvolutionService(
      { get: () => undefined } as unknown as Context,
      cfg,
      runner,
      store,
      new CreationGuard({ isEvolutionMode: () => true }),
      child,
      undefined,
      undefined,
      testingCreatorFoundation(preflight),
    )
    const flow = workflow()
    const exec = { agent: { id: 'parent', options: {}, session: { header: { id: 'parent', cwd: root, version: 0, createdAt: 0 } } } as unknown as Agent }
    const prepared = await service.prepareCreate(resolution(root), exec, flow)
    expect(flow.managedSourceId).toBeTruthy()
    expect(prepared.path).toBeTruthy()
    expect(prepared.review).toBeTruthy()
    const result = prepared
    expect(result.review?.sourceSnapshot.kind).toBe('local')
    expect(result.review?.installSpec).toMatch(/^file:.*\.tgz$/u)
    const artifactPath = result.review!.installSpec!.slice('file:'.length)
    const artifact = await readFile(artifactPath)
    expect(artifact.subarray(0, 2).toString('hex')).toBe('1f8b')
    const receipt = await service.sources.readReceipt(flow.managedSourceId!)
    expect(receipt).toMatchObject({ reviewId: result.review!.id, artifactHash: expect.stringMatching(/^[a-f0-9]{64}$/u) })
    expect(receipt?.headCommit).not.toBe(receipt?.baseCommit)
    expect(flow.creatorRecords?.at(-1)).toEqual(expect.objectContaining({
      operation: 'create',
      status: 'verified',
      receipt: expect.objectContaining({ presetId: 'evolution', childSessionId: 'child-1' }),
    }))
    const revalidate = service as unknown as { revalidate(review: NonNullable<typeof result.review>): Promise<boolean> }
    await expect(revalidate.revalidate(result.review!)).resolves.toBe(true)
  }, 60_000)

  it('checkpoints cancelled parent edits, reports recovery, and releases the source lock with an aborted signal', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-managed-cancel-e2e-'))
    temporary.push(root)
    const preflight = testingCreatorPreflight()
    const runner = new NativeRunner()
    const cfg = config(root)
    const store = new StateStore(cfg.stateDir!)
    const controller = new AbortController()
    const child = managedChild(async ({ cwd }) => {
      await writeFile(path.join(cwd, 'cancelled-edit.js'), 'export const preserved = true\n')
      controller.abort()
      throw new Error('child cancelled')
    })
    const service = new CapabilityEvolutionService(
      { get: () => undefined } as unknown as Context,
      cfg,
      runner,
      store,
      new CreationGuard({ isEvolutionMode: () => true }),
      child,
      undefined,
      undefined,
      testingCreatorFoundation(preflight),
    )
    const flow = workflow()
    const agent = { id: 'parent', options: {}, session: { header: { id: 'parent', cwd: root, version: 0, createdAt: 0 } } } as unknown as Agent
    const error = await service.prepareCreate(resolution(root), { agent, signal: controller.signal }, flow)
      .then(() => undefined, (cause: unknown) => cause)
    expect(error).toMatchObject({
      message: expect.stringMatching(/cancelled.*checkpointed/i),
      details: expect.objectContaining({ cancelled: true, recoveryRequired: true }),
    })
    expect(String((error as Error).message)).not.toMatch(/Executable is unavailable/u)

    const sourceId = flow.managedSourceId!
    const checkpoint = await service.sources.readReceipt(sourceId)
    expect(checkpoint?.headCommit).not.toBe(checkpoint?.baseCommit)
    expect(checkpoint?.activeWorkflowId).toBe(flow.id)
    await service.releaseManagedSource(flow, { agent })
    expect((await service.sources.readReceipt(sourceId))?.activeWorkflowId).toBeNull()
    await expect(readFile(service.sources.lockPath(sourceId), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(flow.creatorRecords?.at(-1)?.status).toBe('unavailable')
    const status = await runner.run({ argv: ['git', 'status', '--porcelain'], cwd: service.sources.sourcePath(sourceId) })
    expect(status.stdout.trim()).toBe('')
  }, 60_000)

  it('checkpoints ordinary managed-child failures as structured recovery state', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-managed-failure-e2e-'))
    temporary.push(root)
    const runner = new NativeRunner()
    const cfg = config(root)
    const store = new StateStore(cfg.stateDir!)
    const child = managedChild(async ({ cwd }) => {
      await writeFile(path.join(cwd, 'failed-edit.js'), 'export const preserved = true\n')
      throw new Error('child command failed')
    })
    const service = new CapabilityEvolutionService(
      { get: () => undefined } as unknown as Context,
      cfg,
      runner,
      store,
      new CreationGuard({ isEvolutionMode: () => true }),
      child,
      undefined,
      undefined,
      testingCreatorFoundation(testingCreatorPreflight()),
    )
    const flow = workflow()
    const agent = { id: 'parent', options: {}, session: { header: { id: 'parent', cwd: root, version: 0, createdAt: 0 } } } as unknown as Agent
    const error = await service.prepareCreate(resolution(root), { agent }, flow)
      .then(() => undefined, (cause: unknown) => cause)

    expect(error).toMatchObject({
      message: expect.stringMatching(/failed.*checkpointed/i),
      details: expect.objectContaining({ cancelled: false, recoveryRequired: true }),
    })
    const checkpoint = await service.sources.readReceipt(flow.managedSourceId!)
    expect(checkpoint?.headCommit).not.toBe(checkpoint?.baseCommit)
    expect(checkpoint?.activeWorkflowId).toBe(flow.id)
    expect(flow.creatorRecords?.at(-1)?.status).toBe('unavailable')
    await service.releaseManagedSource(flow, { agent })
  }, 60_000)

  it('does not clone, scaffold, or write sources when Creator preflight fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-managed-preflight-fail-'))
    temporary.push(root)
    const runner = new NativeRunner()
    const cfg = config(root)
    const store = new StateStore(cfg.stateDir!)
    const child: ManagedChildHost = {
      async run() {
        throw new Error('child must not start')
      },
    }
    const service = new CapabilityEvolutionService(
      { get: () => undefined } as unknown as Context,
      cfg,
      runner,
      store,
      new CreationGuard({ isEvolutionMode: () => true }),
      child,
      undefined,
      undefined,
      {
        async preflight() {
          throw new Error('Official Creator cordis preset is missing')
        },
      },
    )
    const flow = workflow()
    await expect(service.prepareCreate(
      resolution(root),
      { agent: { id: 'parent', options: {}, session: { header: { id: 'parent', cwd: root, version: 0, createdAt: 0 } } } as unknown as Agent },
      flow,
    )).rejects.toThrow(/cordis preset is missing/i)
    await expect(access(cfg.sourceDir!)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(flow.managedSourceId).toBeUndefined()
    expect(flow.creatorRecords).toEqual([expect.objectContaining({ operation: 'create', status: 'unavailable' })])
  }, 60_000)

  it('reclaims and freshly freezes a completed managed repair in a later workflow', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-managed-repair-reclaim-'))
    temporary.push(root)
    const runner = new NativeRunner()
    const cfg = config(root)
    const store = new StateStore(cfg.stateDir!)
    const child = managedChild(
      async ({ cwd }) => {
        const pkgPath = path.join(cwd, 'package.json')
        const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
        await writeFile(pkgPath, `${JSON.stringify({ ...pkg, name: 'dsh-plugin-repaired', license: 'MIT' }, null, 2)}\n`)
        await writeFile(path.join(cwd, 'LICENSE'), 'MIT\n')
      },
      async ({ cwd }) => {
        await writeFile(path.join(cwd, 'managed-repair.js'), 'export const repaired = true\n')
      },
      async ({ cwd }) => {
        await writeFile(path.join(cwd, 'managed-correction.js'), 'export const corrected = true\n')
      },
    )
    const service = new CapabilityEvolutionService(
      { get: () => undefined } as unknown as Context,
      cfg,
      runner,
      store,
      new CreationGuard({ isEvolutionMode: () => true }),
      child,
      undefined,
      undefined,
      testingCreatorFoundation(testingCreatorPreflight()),
    )
    const firstFlow = workflow()
    const agent = { id: 'parent', options: {}, session: { header: { id: 'parent', cwd: root, version: 0, createdAt: 0 } } } as unknown as Agent
    const frozen = await service.prepareCreate(resolution(root), { agent }, firstFlow)
    const initialReceipt = await service.sources.readReceipt(firstFlow.managedSourceId!)
    expect(frozen.review?.sourceSnapshot.kind).toBe('local')
    expect(initialReceipt?.artifactHash).toMatch(/^[a-f0-9]{64}$/u)

    const githubReview: ReviewRecord = {
      ...frozen.review!,
      id: `review_${'7'.repeat(64)}`,
      sourceSnapshot: {
        kind: 'github',
        repository: 'acme/repaired',
        requestedRef: initialReceipt!.baseCommit,
        commit: initialReceipt!.baseCommit,
        defaultBranch: 'main',
      },
      installSpec: `github:acme/repaired#${initialReceipt!.baseCommit}`,
    }
    const repairedReview: ReviewRecord = {
      ...frozen.review!,
      id: `review_${'8'.repeat(64)}`,
      createdAt: new Date(Date.now() + 1_000).toISOString(),
      sourceSnapshot: {
        kind: 'local',
        path: initialReceipt!.path,
        baseReviewId: githubReview.id,
        baseCommit: initialReceipt!.baseCommit,
        statusHash: frozen.review!.sourceSnapshot.kind === 'local'
          ? frozen.review!.sourceSnapshot.statusHash
          : '9'.repeat(64),
      },
    }
    await store.put('reviews', githubReview)
    await store.put('reviews', repairedReview)
    await service.sources.writeReceipt({ ...initialReceipt!, repository: 'acme/repaired', reviewId: repairedReview.id })
    await service.releaseManagedSource(firstFlow, { agent })

    const target: EvolutionTarget = {
      kind: 'reviewed_snapshot',
      repository: 'acme/repaired',
      commit: initialReceipt!.baseCommit,
      packageName: 'dsh-plugin-repaired',
      profile: 'web',
      dependencySpec: repairedReview.installSpec!,
      specDigest: dependencySpecDigest(repairedReview.installSpec!),
      reviewId: repairedReview.id,
      sourceId: firstFlow.managedSourceId!,
    }
    const secondResolution: ResolutionRecord = {
      ...resolution(root),
      id: `resolution_${'c'.repeat(24)}`,
      requirement: 'continue the completed managed repair',
      localCandidates: [{
        kind: 'plugin',
        name: target.packageName,
        description: 'managed repair',
        availability: 'known_source',
        confidence: 0.99,
        fit: 'partial',
        evolutionTarget: target,
      }],
      authorization: {
        state: 'selection_required',
        resolutionId: `resolution_${'c'.repeat(24)}`,
        reason: 'review managed snapshot',
      },
    }
    const secondFlow: WorkflowRecord = {
      ...workflow(),
      id: `workflow_${'d'.repeat(24)}`,
      requirement: secondResolution.requirement,
      resolutionId: secondResolution.id,
      candidateSnapshot: [{
        id: `candidate_${'e'.repeat(24)}`,
        index: 1,
        kind: 'local',
        name: target.packageName,
        identity: target.packageName,
        digest: 'f'.repeat(64),
        repository: target.repository,
        evolutionTarget: target,
      }],
      pendingReviewedCandidateId: `candidate_${'e'.repeat(24)}`,
    }
    await store.put('resolutions', secondResolution)
    await store.put('workflows', secondFlow)
    const reclaimed = await service.reviewExisting(secondResolution, target, { agent }, secondFlow)
    expect(reclaimed.review.sourceSnapshot).toMatchObject({
      kind: 'local',
      path: initialReceipt!.path,
      baseCommit: initialReceipt!.baseCommit,
    })
    expect(reclaimed.review.resolutionId).toBe(secondResolution.id)
    if (reclaimed.review.sourceSnapshot.kind !== 'local') throw new Error('reclaimed review must be local')
    const freshRoot = await store.getReview(reclaimed.review.sourceSnapshot.baseReviewId)
    expect(freshRoot).toMatchObject({
      resolutionId: secondResolution.id,
      sourceSnapshot: {
        kind: 'github',
        repository: target.repository,
        commit: target.commit,
      },
    })
    expect(reclaimed.review.installSpec).toMatch(/^file:.*\.tgz$/u)
    expect(reclaimed.review.installSpec).not.toBe(repairedReview.installSpec)
    expect(await service.sources.readReceipt(firstFlow.managedSourceId!)).toMatchObject({
      activeWorkflowId: secondFlow.id,
      reviewId: reclaimed.review.id,
      artifactHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    })
    await service.releaseManagedSource(secondFlow, { agent })
    expect(secondFlow.managedSourceId).toBe(firstFlow.managedSourceId)
    expect(await service.sources.readReceipt(firstFlow.managedSourceId!)).toMatchObject({
      activeWorkflowId: null,
      reviewId: reclaimed.review.id,
    })

    // A read-only review/re-freeze can release the source while the workflow
    // keeps its durable managedSourceId. A later fresh modify decision must
    // reclaim that clean completed tip instead of trying to resume a stale
    // process-owned lock.
    const preparedModify = await service.prepareModify(reclaimed.resolution, reclaimed.review, { agent }, secondFlow)
    expect(preparedModify.path).toBe(initialReceipt!.path)
    expect(await service.sources.readReceipt(firstFlow.managedSourceId!)).toMatchObject({
      activeWorkflowId: secondFlow.id,
      reviewId: preparedModify.review?.id,
    })
    await service.releaseManagedSource(secondFlow, { agent })
  }, 30_000)
})
