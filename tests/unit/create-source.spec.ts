import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeConfig } from '../../src/config.js'
import { CreationGuard } from '../../src/creation-guard.js'
import { ExecutionGuard } from '../../src/execution-guard.js'
import { PluginInstaller } from '../../src/lifecycle/install.js'
import type { DshLauncher } from '../../src/lifecycle/launcher.js'
import type { CommandRunner } from '../../src/process/runner.js'
import { CapabilityEvolutionService } from '../../src/service.js'
import { SourceManager, sourceIdForCreate } from '../../src/source-manager.js'
import { StateStore } from '../../src/state/store.js'
import { sha256 } from '../../src/state/hashes.js'

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((entry) => rm(entry, { recursive: true, force: true })))
})

function config(root: string): RuntimeConfig {
  return {
    dshHome: path.join(root, 'dsh-home'),
    stateDir: root,
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
  } as RuntimeConfig
}

function scriptedGit(): CommandRunner {
  const state = { head: '0'.repeat(40), branch: 'main', commits: 0 }
  return {
    async run(request) {
      const args = request.argv.slice(1)
      const joined = args.join(' ')
      if (joined === 'init') {
        await mkdir(path.join(request.cwd, '.git'), { recursive: true })
        return { exitCode: 0, signal: null, stdout: '', stderr: '' }
      }
      if (joined.startsWith('checkout -B')) {
        state.branch = args[2]!
        return { exitCode: 0, signal: null, stdout: '', stderr: '' }
      }
      if (joined === 'status --porcelain') return { exitCode: 0, signal: null, stdout: '', stderr: '' }
      if (joined === 'rev-parse HEAD') return { exitCode: 0, signal: null, stdout: `${state.head}\n`, stderr: '' }
      if (joined === 'rev-parse --abbrev-ref HEAD') return { exitCode: 0, signal: null, stdout: `${state.branch}\n`, stderr: '' }
      if (joined === 'add -A') return { exitCode: 0, signal: null, stdout: '', stderr: '' }
      if (args[0] === 'commit') {
        state.commits += 1
        state.head = `scaffold${state.commits}`.padEnd(40, '0')
        return { exitCode: 0, signal: null, stdout: '', stderr: '' }
      }
      return { exitCode: 1, signal: null, stdout: '', stderr: `unexpected ${joined}` }
    },
  }
}

function capableSandbox(stateDir: string) {
  return {
    filesystem: {
      mode: 'workspace-write' as const,
      bindsManagedCwd: true,
      assertContained: async (candidate: string) => !candidate.includes('..') && !candidate.includes('escape-probe'),
    },
    shell: {
      mode: 'workspace-write' as const,
      bindsManagedCwd: true,
      canWrite: async (candidate: string) => {
        const root = path.join(stateDir, 'sources')
        const relative = path.relative(root, path.resolve(candidate))
        return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
          && !candidate.includes('escape-probe')
      },
    },
  }
}

describe('managed git create sources', () => {
  it('writes trusted scaffold provenance before the child begins', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-create-scaffold-'))
    temporary.push(root)
    const manager = new SourceManager(config(root), scriptedGit())
    const resolutionId = `resolution_${'c'.repeat(24)}`
    const receipt = await manager.initializeCreateSource({
      resolutionId,
      workflowId: `workflow_${'d'.repeat(24)}`,
      packageName: 'dsh-plugin-demo',
    })
    expect(receipt.sourceId).toBe(sourceIdForCreate(resolutionId))
    expect(receipt.repository).toBeNull()
    expect(receipt.branch).toBe(`autoevo/workflow_${'d'.repeat(24)}`)
    expect(receipt.baseCommit).toBe(receipt.headCommit)
    const pkg = await readFile(path.join(receipt.path, 'package.json'), 'utf8')
    expect(pkg).toContain('"name": "dsh-plugin-demo"')
    expect(pkg).toContain('"patch": "./cordis.patch.yml"')
    await expect(readFile(path.join(receipt.path, 'lib', 'index.js'), 'utf8'))
      .resolves.toContain('autoevo-scaffold')
    const stored = JSON.parse(await readFile(manager.receiptPath(receipt.sourceId), 'utf8'))
    expect(stored.headCommit).toBe(receipt.headCommit)
  })

  it('denies child writes outside the managed repo and nested publication', async () => {
    const child = new ExecutionGuard({ role: 'child' })
    expect(child.guard({
      callId: '1',
      name: 'capability_workflow_resume',
      arguments: {},
    } as never)).toMatch(/AutoEvo decision tools/i)
    expect(child.guard({
      callId: '2',
      name: 'pwsh',
      arguments: { command: 'git push origin HEAD' },
    } as never)).toMatch(/push\/tag\/release|publication/i)

    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-create-escape-'))
    temporary.push(root)
    const sandbox = capableSandbox(root)
    await expect(sandbox.shell.canWrite(path.join(root, 'outside', 'evil.js'))).resolves.toBe(false)
    await expect(sandbox.filesystem.assertContained(path.join(root, 'sources', 'x', '..', 'escape-probe'))).resolves.toBe(false)
  })

  it('fails closed when child sandbox is unavailable and does not create a source', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-create-nosandbox-'))
    temporary.push(root)
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_create' })
    const ctx = {
      tools: { schemas: () => [], get: () => undefined, execute: async () => ({ isError: false, value: { results: [] }, content: [] }), register: () => undefined },
      systemPrompt: { assemble: async () => ({ tools: [] }) },
      skills: { list: async () => [] },
      get: () => undefined,
    } as unknown as Context
    const service = new CapabilityEvolutionService(ctx, config(root), scriptedGit(), new StateStore(root), guard)
    const turn = {
      callId: 'c1',
      rootCallId: 'c1',
      token: Symbol('c1'),
      signal: new AbortController().signal,
      agent: { id: 'session-create', session: { header: { id: 'session-create', cwd: process.cwd(), version: 0, createdAt: 0 } } },
    } as unknown as ToolRunContext
    const started = await service.start('need a brand new capability', turn)
    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: 'Create new' }] })
    await expect(service.resume({
      workflowId: started.workflow.id,
      interruptId: started.workflow.interrupt!.interruptId,
    }, turn)).rejects.toThrow(/sandbox/i)
    const { access } = await import('node:fs/promises')
    await expect(access(path.join(root, 'sources'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('packages scaffold bytes stably and requires a fresh host confirmation before verified install', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-create-pack-'))
    temporary.push(root)
    const manager = new SourceManager(config(root), scriptedGit())
    const receipt = await manager.initializeCreateSource({
      resolutionId: `resolution_${'e'.repeat(24)}`,
      workflowId: `workflow_${'f'.repeat(24)}`,
    })
    const packed = await manager.buildNormalizedTgz({
      sourceId: receipt.sourceId,
      outputDir: path.join(root, 'artifacts'),
    })
    expect(packed.artifactHash).toMatch(/^[a-f0-9]{64}$/u)
    const again = await manager.buildNormalizedTgz({
      sourceId: receipt.sourceId,
      outputDir: path.join(root, 'artifacts-2'),
    })
    expect(again.artifactHash).toBe(packed.artifactHash)

    const store = new StateStore(root)
    const reviewId = `review_${'a'.repeat(64)}`
    await store.put('reviews', {
      schemaVersion: 1,
      id: reviewId,
      policyVersion: '1',
      createdAt: '2026-08-18T00:00:00.000Z',
      resolutionId: `resolution_${'e'.repeat(24)}`,
      requirement: 'demo',
      sourceSnapshot: {
        kind: 'local',
        path: receipt.path,
        baseReviewId: reviewId,
        baseCommit: receipt.baseCommit,
        statusHash: sha256('clean'),
      },
      inspectedFiles: [],
      manifest: {
        kind: 'bundle',
        packageName: 'dsh-plugin-new',
        bundlePatch: './cordis.patch.yml',
        scripts: [],
        dependencies: [],
        peerDependencies: {},
        expectedTools: [],
      },
      fit: 'full',
      confidence: 1,
      securityRisk: 'low',
      maintained: true,
      license: 'MIT',
      compatibility: { status: 'compatible', reason: 'ok', runtimeVersion: '0.1.0-rc.6' },
      missingCapabilities: [],
      findings: [],
      recommendation: 'use',
      installSpec: null,
    })
    // Review rejection path: partial fit cannot install.
    await store.put('reviews', {
      ...(await store.getReview(reviewId)),
      id: `review_${'b'.repeat(64)}`,
      fit: 'partial',
      recommendation: 'modify',
      installSpec: null,
    })
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const installer = new PluginInstaller(ctx, config(root), store, {
      materializeLocal: async () => ({ installSpec: packed.installSpec, artifactSha256: packed.artifactHash }),
      install: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
      verify: async () => ({
        attempted: true,
        exitCode: 0,
        expectedTools: [],
        calledTools: [],
        resultTools: [],
        failedTools: [],
        sessionFiles: [],
        taskResultObserved: true,
        reason: 'verified',
      }),
    } as unknown as DshLauncher, async () => true)
    await expect(installer.install({
      reviewId: `review_${'b'.repeat(64)}`,
      targetProfile: 'web',
      retention: 'persistent',
      verificationTask: 'ping',
    }, {
      callId: 'i1',
      agent: { session: { header: { cwd: process.cwd() } } },
    } as never)).rejects.toThrow(/does not authorize installation/i)

    // Confirmation replay: interrupt consumption is Host-owned; a second resume of the same interrupt must fail.
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_pack' })
    const service = new CapabilityEvolutionService(
      {
        tools: { schemas: () => [], get: () => undefined, execute: async () => ({ isError: false, value: { results: [] }, content: [] }), register: () => undefined },
        systemPrompt: { assemble: async () => ({ tools: [] }) },
        skills: { list: async () => [] },
        get: (name: string) => (name === 'sandbox' ? capableSandbox(root) : undefined),
      } as unknown as Context,
      config(root),
      scriptedGit(),
      new StateStore(path.join(root, 'state-replay')),
      guard,
    )
    const turn = {
      callId: 'c2',
      rootCallId: 'c2',
      token: Symbol('c2'),
      signal: new AbortController().signal,
      agent: { id: 'session-pack', session: { header: { id: 'session-pack', cwd: process.cwd(), version: 0, createdAt: 0 } } },
    } as unknown as ToolRunContext
    const started = await service.start('need create capability', turn)
    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: 'Create new' }] })
    const created = await service.resume({
      workflowId: started.workflow.id,
      interruptId: started.workflow.interrupt!.interruptId,
    }, turn)
    expect(created.workflow.pendingPath || created.workflow.cursor === 'await_modify_work' || created.workflow.cursor === 'create_authorized').toBeTruthy()
    guard.rememberUserMessage(turn.agent, { content: [{ type: 'text', text: 'Create new' }] })
    await expect(service.resume({
      workflowId: started.workflow.id,
      interruptId: started.workflow.interrupt!.interruptId,
    }, turn)).rejects.toThrow(/already consumed|not waiting|sandbox|locked|exists/i)

    // Verified install of a full local review using the packed artifact.
    await store.put('reviews', {
      ...(await store.getReview(reviewId)),
      fit: 'full',
      recommendation: 'use',
      installSpec: null,
    })
    const verified = await installer.install({
      reviewId,
      targetProfile: 'web',
      retention: 'persistent',
      verificationTask: 'ping',
    }, {
      callId: 'i2',
      agent: { session: { header: { cwd: process.cwd() } } },
    } as never)
    expect(verified).toMatchObject({ installOutcome: 'verified', installed: true, verified: true })
  })
})
