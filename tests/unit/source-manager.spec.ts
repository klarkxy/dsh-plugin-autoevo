import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeConfig } from '../../src/config.js'
import type { ReviewRecord } from '../../src/contracts.js'
import type { CommandRunner } from '../../src/process/runner.js'
import { SourceManager, sourceIdForRepository, _testing as sourceTesting } from '../../src/source-manager.js'

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((entry) => rm(entry, { recursive: true, force: true })))
})

function config(root: string, sourceDir?: string): RuntimeConfig {
  return {
    dshHome: path.join(root, 'dsh-home'),
    stateDir: root,
    ...(sourceDir !== undefined ? { sourceDir } : {}),
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

function review(commit = 'c'.repeat(40)): ReviewRecord {
  return {
    schemaVersion: 1,
    id: `review_${'a'.repeat(64)}`,
    policyVersion: '1',
    createdAt: '2026-08-18T00:00:00.000Z',
    resolutionId: `resolution_${'b'.repeat(24)}`,
    requirement: 'calculator',
    sourceSnapshot: {
      kind: 'github',
      repository: 'acme/calculator',
      requestedRef: 'main',
      commit,
      defaultBranch: 'main',
    },
    inspectedFiles: [],
    manifest: {
      kind: 'bundle',
      packageName: 'dsh-tool-calculator',
      bundlePatch: './cordis.patch.yml',
      scripts: [],
      dependencies: [],
      peerDependencies: {},
      expectedTools: ['calculator'],
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
    installSpec: `github:acme/calculator#${commit}`,
  }
}

function scriptedGit(state: {
  head: string
  branch: string
  dirty?: string
  commits?: string[]
}): CommandRunner {
  return {
    async run(request) {
      const raw = request.argv.slice(1)
      const args: string[] = []
      for (let index = 0; index < raw.length; index += 1) {
        if (raw[index] === '-c') {
          index += 1
          continue
        }
        args.push(raw[index]!)
      }
      const joined = args.join(' ')
      if (joined === 'init') {
        await mkdir(path.join(request.cwd, '.git'), { recursive: true })
        await writeFile(path.join(request.cwd, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n')
        return { exitCode: 0, signal: null, stdout: '', stderr: '' }
      }
      if (joined.startsWith('remote add origin')) {
        return { exitCode: 0, signal: null, stdout: '', stderr: '' }
      }
      if (joined.startsWith('fetch')) {
        return { exitCode: 0, signal: null, stdout: '', stderr: '' }
      }
      if (joined.startsWith('checkout -B')) {
        state.branch = args[2]!
        state.head = args[3]!
        await writeFile(path.join(request.cwd, 'package.json'), '{"name":"dsh-tool-calculator"}\n', 'utf8')
        return { exitCode: 0, signal: null, stdout: '', stderr: '' }
      }
      if (joined === 'status --porcelain') {
        return { exitCode: 0, signal: null, stdout: state.dirty ?? '', stderr: '' }
      }
      if (joined === 'rev-parse HEAD') {
        return { exitCode: 0, signal: null, stdout: `${state.head}\n`, stderr: '' }
      }
      if (joined === 'rev-parse --abbrev-ref HEAD') {
        return { exitCode: 0, signal: null, stdout: `${state.branch}\n`, stderr: '' }
      }
      if (joined === 'add -A') {
        return { exitCode: 0, signal: null, stdout: '', stderr: '' }
      }
      if (args.includes('commit')) {
        state.head = `commit_${(state.commits ??= []).length + 1}`.padEnd(40, '0')
        state.commits.push(state.head)
        state.dirty = ''
        return { exitCode: 0, signal: null, stdout: '', stderr: '' }
      }
      return { exitCode: 1, signal: null, stdout: '', stderr: `unexpected git ${joined}` }
    },
  }
}

describe('SourceManager defaults and provenance', () => {
  it('defaults omitted sourceDir to <stateDir>/sources', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-source-default-'))
    temporary.push(root)
    const manager = new SourceManager(config(root), scriptedGit({ head: 'c'.repeat(40), branch: 'main' }))
    expect(manager.sourceRoot).toBe(path.resolve(root, 'sources'))
    expect(manager.sourcePath('acme_calculator')).toBe(path.resolve(root, 'sources', 'acme_calculator'))
  })

  it('materializes exact reviewed commit provenance onto autoevo/<workflow-id>', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-source-prov-'))
    temporary.push(root)
    const commit = 'c'.repeat(40)
    const git = scriptedGit({ head: commit, branch: 'main' })
    const manager = new SourceManager(config(root), git)
    const receipt = await manager.materializeReviewedGithub({
      review: review(commit),
      workflowId: `workflow_${'d'.repeat(24)}`,
    })
    expect(receipt).toMatchObject({
      sourceId: sourceIdForRepository('acme/calculator'),
      repository: 'acme/calculator',
      baseCommit: commit,
      headCommit: commit,
      branch: `autoevo/workflow_${'d'.repeat(24)}`,
      reviewId: review().id,
      activeWorkflowId: `workflow_${'d'.repeat(24)}`,
    })
    expect(receipt.path).toBe(manager.sourcePath(receipt.sourceId))
    const stored = JSON.parse(await readFile(manager.receiptPath(receipt.sourceId), 'utf8'))
    expect(stored.headCommit).toBe(commit)
  })

  it('rejects a dirty tree before continuing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-source-dirty-'))
    temporary.push(root)
    const git = scriptedGit({ head: 'c'.repeat(40), branch: 'main', dirty: ' M package.json\n' })
    const manager = new SourceManager(config(root), git)
    await expect(manager.materializeReviewedGithub({
      review: review(),
      workflowId: `workflow_${'e'.repeat(24)}`,
    })).rejects.toThrow(/dirty/i)
  })

  it('rejects concurrent locks and recovers a stale lock after revalidation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-source-lock-'))
    temporary.push(root)
    const commit = 'c'.repeat(40)
    const git = scriptedGit({ head: commit, branch: `autoevo/workflow_${'f'.repeat(24)}` })
    const manager = new SourceManager(config(root), git)
    const first = await manager.materializeReviewedGithub({
      review: review(commit),
      workflowId: `workflow_${'f'.repeat(24)}`,
    })
    await expect(manager.materializeReviewedGithub({
      review: review(commit),
      workflowId: `workflow_${'a'.repeat(24)}`,
    })).rejects.toThrow(/locked by another active workflow/i)

    // Stale lock: dead pid plus matching clean head/branch allows recovery after revalidation.
    await writeFile(manager.lockPath(first.sourceId), `${JSON.stringify({
      workflowId: `workflow_${'f'.repeat(24)}`,
      createdAt: '2026-08-01T00:00:00.000Z',
      pid: 0,
      headCommit: commit,
      branch: `autoevo/workflow_${'f'.repeat(24)}`,
    }, null, 2)}\n`)
    const recovered = await manager.materializeReviewedGithub({
      review: review(commit),
      workflowId: `workflow_${'b'.repeat(24)}`,
    })
    expect(recovered.activeWorkflowId).toBe(`workflow_${'b'.repeat(24)}`)
    expect(recovered.branch).toBe(`autoevo/workflow_${'b'.repeat(24)}`)
  })

  it('defends against path escape and symlink roots', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-source-escape-'))
    temporary.push(root)
    const manager = new SourceManager(config(root), scriptedGit({ head: 'c'.repeat(40), branch: 'main' }))
    expect(() => manager.sourcePath(`..${path.sep}escape`)).toThrow(/safe single path segment/i)
    expect(() => manager.sourcePath('.')).toThrow(/safe single path segment/i)

    const outside = path.join(root, 'outside')
    await mkdir(outside, { recursive: true })
    await mkdir(manager.sourceRoot, { recursive: true })
    const linked = manager.sourcePath('linked')
    await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(manager.assertPathContainment('linked')).rejects.toThrow(/symlink|escaped/i)
  })

  it('keeps control metadata outside the child repo and finalizes reviewed provenance', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-source-finalize-'))
    temporary.push(root)
    const state = { head: 'c'.repeat(40), branch: 'main', dirty: '' }
    const manager = new SourceManager(config(root), scriptedGit(state))
    const workflowId = `workflow_${'d'.repeat(24)}`
    const receipt = await manager.materializeReviewedGithub({ review: review(), workflowId })
    expect(path.dirname(manager.receiptPath(receipt.sourceId))).not.toBe(receipt.path)
    await writeFile(path.join(receipt.path, 'lib.js'), 'export const x = 1\n', 'utf8')
    state.dirty = '?? lib.js\n'
    const committed = await manager.finalizeChildCommit({
      sourceId: receipt.sourceId,
      workflowId,
      reviewId: review().id,
      message: 'fix: managed child change',
    })
    expect(committed.headCommit).not.toBe(receipt.headCommit)
    const recorded = await manager.recordReviewedArtifact({
      sourceId: receipt.sourceId,
      workflowId,
      reviewId: `review_${'e'.repeat(64)}`,
      artifactHash: 'f'.repeat(64),
    })
    expect(recorded).toMatchObject({ reviewId: `review_${'e'.repeat(64)}`, artifactHash: 'f'.repeat(64) })
    await manager.completeWorkflow(receipt.sourceId, workflowId)
    expect((await manager.readReceipt(receipt.sourceId))?.activeWorkflowId).toBeNull()
  })

  it('rejects untracked dependency stores before Host git add', async () => {
    expect(sourceTesting.forbiddenUntrackedPath('?? .pnpm-store/v10/files/cache\n')).toBe('.pnpm-store/v10/files/cache')
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-source-cache-'))
    temporary.push(root)
    const state: { head: string; branch: string; dirty: string; commits?: string[] } = {
      head: 'c'.repeat(40), branch: 'main', dirty: '',
    }
    const manager = new SourceManager(config(root), scriptedGit(state))
    const workflowId = `workflow_${'9'.repeat(24)}`
    const receipt = await manager.materializeReviewedGithub({ review: review(), workflowId })
    state.dirty = '?? .pnpm-store/\n M src/index.ts\n'
    await expect(manager.finalizeChildCommit({
      sourceId: receipt.sourceId,
      workflowId,
      reviewId: review().id,
      message: 'fix: should reject cache',
    })).rejects.toThrow(/dependency\/cache artifacts/i)
    expect(state.commits).toBeUndefined()
  })

  it('rejects child tampering with repository Git configuration before Host commit', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-source-git-config-'))
    temporary.push(root)
    const state = { head: 'c'.repeat(40), branch: 'main', dirty: '' }
    const manager = new SourceManager(config(root), scriptedGit(state))
    const workflowId = `workflow_${'e'.repeat(24)}`
    const receipt = await manager.materializeReviewedGithub({ review: review(), workflowId })
    state.dirty = ' M package.json\n'
    await writeFile(path.join(receipt.path, '.git', 'config'), '[core]\n\thooksPath = evil\n')
    await expect(manager.finalizeChildCommit({
      sourceId: receipt.sourceId,
      workflowId,
      reviewId: review().id,
      message: 'fix: should not commit',
    })).rejects.toThrow(/Git configuration/i)
  })

  it('rejects child-created Git hooks before any Host commit can execute them', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-source-git-hooks-'))
    temporary.push(root)
    const state = { head: 'c'.repeat(40), branch: 'main', dirty: '' }
    const manager = new SourceManager(config(root), scriptedGit(state))
    const workflowId = `workflow_${'e'.repeat(24)}`
    const receipt = await manager.materializeReviewedGithub({ review: review(), workflowId })
    state.dirty = ' M package.json\n'
    await mkdir(path.join(receipt.path, '.git', 'hooks'), { recursive: true })
    await writeFile(path.join(receipt.path, '.git', 'hooks', 'pre-commit'), 'exit 0\n')
    await expect(manager.finalizeChildCommit({
      sourceId: receipt.sourceId,
      workflowId,
      reviewId: review().id,
      message: 'fix: should not run hook',
    })).rejects.toThrow(/Git configuration/i)
    await expect(manager.completeWorkflow(receipt.sourceId, workflowId)).rejects.toThrow(/final repository state changed/i)
    expect((await manager.readReceipt(receipt.sourceId))?.activeWorkflowId).toBe(workflowId)
  })

  it('keeps managed sources after uninstall-style artifact cleanup', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-source-survive-'))
    temporary.push(root)
    const manager = new SourceManager(config(root), scriptedGit({ head: 'c'.repeat(40), branch: 'main' }))
    const receipt = await manager.materializeReviewedGithub({
      review: review(),
      workflowId: `workflow_${'c'.repeat(24)}`,
    })
    // Simulate plugin_remove cleaning only owned artifacts, never sources.
    const artifacts = path.join(root, 'artifacts', 'installation_x')
    await mkdir(artifacts, { recursive: true })
    await writeFile(path.join(artifacts, 'plugin.tgz'), 'tgz')
    await rm(artifacts, { recursive: true, force: true })
    await expect(stat(receipt.path)).resolves.toMatchObject({ isDirectory: expect.any(Function) })
    await expect(stat(manager.receiptPath(receipt.sourceId))).resolves.toBeTruthy()
  })
})
