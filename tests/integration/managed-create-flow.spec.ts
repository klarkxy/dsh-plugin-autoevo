import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeConfig } from '../../src/config.js'
import type { ResolutionRecord } from '../../src/contracts.js'
import { CreationGuard } from '../../src/creation-guard.js'
import type { ManagedChildHost } from '../../src/managed-child.js'
import type { CommandRequest, CommandResult, CommandRunner } from '../../src/process/runner.js'
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
    policyVersion: 'v2-2026-08-15',
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
    policyVersion: 'v2-2026-08-15',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    requirement: 'provide a hello tool',
    status: 'running',
    cursor: 'prepare_create',
    generation: 1,
  }
}

describe('managed create vertical flow', () => {
  it('runs the child, commits, reviews, and freezes a real npm tgz before confirmation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-managed-create-e2e-'))
    temporary.push(root)
    const child: ManagedChildHost = {
      async run(request) {
        const pkgPath = path.join(request.cwd, 'package.json')
        const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
        await writeFile(pkgPath, `${JSON.stringify({ ...pkg, license: 'MIT' }, null, 2)}\n`)
        await writeFile(path.join(request.cwd, 'lib', 'index.js'), "export const name = 'hello-plugin'\nexport function apply() {}\n")
        await writeFile(path.join(request.cwd, 'LICENSE'), 'MIT\n')
        return {
          sessionId: 'child-test',
          taskResult: 'implemented\nAUTOEVO_CHILD_COMPLETED',
          sandbox: { ok: true, mode: 'workspace-write', cwd: request.cwd, platform: process.platform, enforcement: 'partial', isolation: 'integrity-partial', note: 'test' },
        }
      },
    }
    const runner = new NativeRunner()
    const cfg = config(root)
    const store = new StateStore(cfg.stateDir)
    const service = new CapabilityEvolutionService(
      { get: () => undefined } as unknown as Context,
      cfg,
      runner,
      store,
      new CreationGuard({ isEvolutionMode: () => true }),
      child,
    )
    const flow = workflow()
    const result = await service.prepareCreate(
      resolution(root),
      { agent: { id: 'parent', options: {}, session: { header: { id: 'parent', cwd: root, version: 0, createdAt: 0 } } } as unknown as Agent },
      flow,
    )
    expect(flow.managedSourceId).toBeTruthy()
    expect(result.review?.sourceSnapshot.kind).toBe('local')
    expect(result.review?.installSpec).toMatch(/^file:.*\.tgz$/u)
    const artifactPath = result.review!.installSpec!.slice('file:'.length)
    const artifact = await readFile(artifactPath)
    expect(artifact.subarray(0, 2).toString('hex')).toBe('1f8b')
    const receipt = await service.sources.readReceipt(flow.managedSourceId!)
    expect(receipt).toMatchObject({ reviewId: result.review!.id, artifactHash: expect.stringMatching(/^[a-f0-9]{64}$/u) })
    expect(receipt?.headCommit).not.toBe(receipt?.baseCommit)
    const revalidate = service as unknown as { revalidate(review: NonNullable<typeof result.review>): Promise<boolean> }
    await expect(revalidate.revalidate(result.review!)).resolves.toBe(true)
  })
})
