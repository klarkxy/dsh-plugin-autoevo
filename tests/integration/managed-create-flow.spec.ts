import { spawn } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeConfig } from '../../src/config.js'
import { POLICY_VERSION, type ResolutionRecord } from '../../src/contracts.js'
import { CreationGuard } from '../../src/creation-guard.js'
import type { ManagedChildHost } from '../../src/managed-child.js'
import type { CommandRequest, CommandResult, CommandRunner } from '../../src/process/runner.js'
import { testingCreatorFoundation, testingCreatorPreflight } from '../../src/creator-foundation.js'
import { CapabilityEvolutionService } from '../../src/service.js'
import { StateStore } from '../../src/state/store.js'
import type { WorkflowRecord } from '../../src/workflow/contracts.js'

const temporary: string[] = []
afterEach(async () => Promise.all(temporary.splice(0).map((entry) => rm(entry, { recursive: true, force: true }))))

class NativeRunner implements CommandRunner {
  async run(request: CommandRequest): Promise<CommandResult> {
    if (request.argv[0] === 'dsh' && request.argv.includes('--version')) {
      return { exitCode: 0, signal: null, stdout: '0.1.0-rc.6\n', stderr: '' }
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
  return {
    dshHome: path.join(root, 'dsh-home'),
    stateDir: path.join(root, 'state'),
    sourceDir: path.join(root, 'state', 'sources'),
    ghCommand: 'gh',
    gitCommand: 'git',
    dshCommand: 'dsh',
    dshCommandArgs: [],
    maxCandidates: 5,
    maxFiles: 80,
    maxRepositoryBytes: 1_048_576,
    commandTimeoutMs: 30_000,
    forwardedCredentialEnv: [],
    verificationPatchPaths: [],
    evolutionPreset: false,
  }
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
  it('prepares the source, lets the parent edit it, then commits, reviews, and freezes a real npm tgz', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-managed-create-e2e-'))
    temporary.push(root)
    const preflight = testingCreatorPreflight()
    const runner = new NativeRunner()
    const cfg = config(root)
    const store = new StateStore(cfg.stateDir)
    const service = new CapabilityEvolutionService(
      { get: () => undefined } as unknown as Context,
      cfg,
      runner,
      store,
      new CreationGuard({ isEvolutionMode: () => true }),
      undefined,
      undefined,
      undefined,
      testingCreatorFoundation(preflight),
    )
    const flow = workflow()
    const exec = { agent: { id: 'parent', options: {}, session: { header: { id: 'parent', cwd: root, version: 0, createdAt: 0 } } } as unknown as Agent }
    const prepared = await service.prepareCreate(resolution(root), exec, flow)
    expect(flow.managedSourceId).toBeTruthy()
    expect(prepared.path).toBeTruthy()
    expect(prepared.review).toBeUndefined()
    const pkgPath = path.join(prepared.path!, 'package.json')
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
    await writeFile(pkgPath, `${JSON.stringify({ ...pkg, license: 'MIT' }, null, 2)}\n`)
    await writeFile(path.join(prepared.path!, 'lib', 'index.js'), "export const name = 'hello-plugin'\nexport function apply() {}\n")
    await writeFile(path.join(prepared.path!, 'LICENSE'), 'MIT\n')
    const result = await service.finishManagedWork(prepared.resolution, exec, flow)
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
      receipt: expect.objectContaining({ presetId: 'evolution', childSessionId: 'parent' }),
    }))
    const revalidate = service as unknown as { revalidate(review: NonNullable<typeof result.review>): Promise<boolean> }
    await expect(revalidate.revalidate(result.review!)).resolves.toBe(true)
  }, 20_000)

  it('checkpoints cancelled parent edits, reports recovery, and releases the source lock with an aborted signal', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-managed-cancel-e2e-'))
    temporary.push(root)
    const preflight = testingCreatorPreflight()
    const runner = new NativeRunner()
    const cfg = config(root)
    const store = new StateStore(cfg.stateDir)
    const service = new CapabilityEvolutionService(
      { get: () => undefined } as unknown as Context,
      cfg,
      runner,
      store,
      new CreationGuard({ isEvolutionMode: () => true }),
      undefined,
      undefined,
      undefined,
      testingCreatorFoundation(preflight),
    )
    const flow = workflow()
    const agent = { id: 'parent', options: {}, session: { header: { id: 'parent', cwd: root, version: 0, createdAt: 0 } } } as unknown as Agent
    const prepared = await service.prepareCreate(resolution(root), { agent }, flow)
    await writeFile(path.join(prepared.path!, 'cancelled-edit.js'), 'export const preserved = true\n')
    const controller = new AbortController()
    controller.abort()
    const error = await service.finishManagedWork(prepared.resolution, { agent, signal: controller.signal }, flow)
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
  }, 20_000)

  it('does not clone, scaffold, or write sources when Creator preflight fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-managed-preflight-fail-'))
    temporary.push(root)
    const runner = new NativeRunner()
    const cfg = config(root)
    const store = new StateStore(cfg.stateDir)
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
  }, 20_000)
})
