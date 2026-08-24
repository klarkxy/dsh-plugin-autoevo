import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { testReview } from '../helpers/records.js'
import { testRuntimeConfig } from '../helpers/runtime-config.js'
import { trackTempDirs } from '../helpers/temp-dirs.js'
import type { RuntimeConfig } from '../../src/config.js'
import type { ReviewRecord } from '../../src/contracts.js'
import type { CommandRunner } from '../../src/process/runner.js'
import { normalizeConfig } from '../../src/config.js'
import { SourceManager, sourceIdForRepository, _testing as sourceTesting } from '../../src/source-manager.js'
import { runInWorkspace } from '../../src/workspace-layout.js'

const temporary = trackTempDirs()

function config(
  root: string,
  sourceDir: string | false = path.join(root, 'sources'),
  stateDir: string | false = root,
): RuntimeConfig {
  return testRuntimeConfig(root, { stateDir, sourceDir })
}

function review(commit = 'c'.repeat(40)): ReviewRecord {
  return testReview({
    policyVersion: '1',
    createdAt: '2026-08-18T00:00:00.000Z',
    confidence: 0.9,
    sourceSnapshot: { kind: 'github', repository: 'acme/calculator', requestedRef: 'main', commit, defaultBranch: 'main' },
    manifest: {
      kind: 'bundle', packageName: 'dsh-tool-calculator', bundlePatch: './cordis.patch.yml', scripts: [],
      dependencies: [], peerDependencies: {}, expectedTools: ['calculator'],
    },
    compatibility: { status: 'compatible', reason: 'ok', runtimeVersion: '0.1.0-rc.6' },
    installSpec: `github:acme/calculator#${commit}`,
  })
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
      if (joined.startsWith('diff-tree --no-commit-id --name-only -r -z')) {
        return { exitCode: 0, signal: null, stdout: 'package.json\0', stderr: '' }
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
  it('keeps Host state under dshHome while leaving sources bound to the session workspace', () => {
    const cfg = normalizeConfig({ dshHome: path.resolve('C:/dsh') })
    expect(cfg.stateDir).toBe(path.resolve('C:/dsh/autoevo'))
    expect(cfg.sourceDir).toBeUndefined()
  })

  it('defaults omitted sourceDir to <workspace>/.autoevo/sources', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-source-default-'))
    temporary.push(root)
    const workspace = path.join(root, 'project')
    const manager = new SourceManager(config(root, false), scriptedGit({ head: 'c'.repeat(40), branch: 'main' }))
    expect(() => manager.sourceRoot).toThrow(/session workspace/i)
    expect(manager.sourceRootFor(workspace)).toBe(path.resolve(workspace, '.autoevo', 'sources'))
    expect(manager.sourcePath('acme_calculator', workspace)).toBe(path.resolve(workspace, '.autoevo', 'sources', 'acme_calculator'))
  })

  it('materializes into the session workspace and keeps Host control under stateDir', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-source-workspace-'))
    temporary.push(root)
    const workspace = path.join(root, 'project')
    const commit = 'c'.repeat(40)
    const manager = new SourceManager(config(root, false), scriptedGit({ head: commit, branch: 'main' }))
    const receipt = await manager.materializeReviewedGithub({
      review: review(commit),
      workflowId: `workflow_${'d'.repeat(24)}`,
      workspaceCwd: workspace,
    })
    expect(receipt.path).toBe(path.resolve(workspace, '.autoevo', 'sources', sourceIdForRepository('acme/calculator')))
    expect(manager.receiptPath(receipt.sourceId).startsWith(path.resolve(root, 'source-control'))).toBe(true)
    expect(await readFile(path.join(workspace, '.autoevo', '.gitignore'), 'utf8')).toMatch(/AutoEvo workspace state/i)
  })

  it('keeps receipts and locks under dshHome while sources stay in the session workspace', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-source-unified-'))
    temporary.push(root)
    const workspace = path.join(root, 'project')
    const commit = 'c'.repeat(40)
    const manager = new SourceManager(config(root, false, false), scriptedGit({ head: commit, branch: 'main' }))
    const autoevo = path.resolve(workspace, '.autoevo')
    await runInWorkspace(workspace, async () => {
      const receipt = await manager.materializeReviewedGithub({
        review: review(commit),
        workflowId: `workflow_${'d'.repeat(24)}`,
        workspaceCwd: workspace,
      })
      expect(receipt.path).toBe(path.join(autoevo, 'sources', sourceIdForRepository('acme/calculator')))
      const controlRoot = path.resolve(root, 'dsh-home', 'autoevo', 'source-control')
      expect(manager.receiptPath(receipt.sourceId)).toBe(path.join(controlRoot, `${receipt.sourceId}.json`))
      expect(manager.lockPath(receipt.sourceId).startsWith(controlRoot)).toBe(true)
      expect(await readFile(path.join(autoevo, '.gitignore'), 'utf8')).toMatch(/Installed DSH plugins do not depend/i)
    })
  })

  it('uses one Host lock namespace when sourceDir is shared across workspaces', () => {
    const root = path.resolve('C:/autoevo-shared-lock')
    const sharedSources = path.join(root, 'shared-sources')
    const first = new SourceManager(config(root, sharedSources, false), scriptedGit({
      head: 'c'.repeat(40),
      branch: 'main',
    }))
    const second = new SourceManager(config(root, sharedSources, false), scriptedGit({
      head: 'c'.repeat(40),
      branch: 'main',
    }))
    const sourceId = sourceIdForRepository('acme/calculator')
    expect(first.sourceRootFor('C:/workspace-a')).toBe(sharedSources)
    expect(second.sourceRootFor('C:/workspace-b')).toBe(sharedSources)
    expect(first.lockPath(sourceId)).toBe(second.lockPath(sourceId))
    expect(first.lockPath(sourceId)).toBe(path.join(root, 'dsh-home', 'autoevo', 'source-control', `${sourceId}.lock`))
  })

  it('relocates materialization into the current workspace when a receipt points elsewhere', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-source-reloc-'))
    temporary.push(root)
    const workspace = path.join(root, 'project')
    const commit = 'c'.repeat(40)
    const manager = new SourceManager(config(root, false), scriptedGit({ head: commit, branch: 'main' }))
    const sourceId = sourceIdForRepository('acme/calculator')
    const stalePath = path.join(root, 'legacy', sourceId)
    await mkdir(stalePath, { recursive: true })
    await mkdir(path.join(root, 'source-control'), { recursive: true })
    await writeFile(manager.receiptPath(sourceId), `${JSON.stringify({
      sourceId,
      repository: 'acme/calculator',
      path: stalePath,
      baseCommit: commit,
      branch: 'autoevo/old',
      headCommit: commit,
      reviewId: review().id,
      artifactHash: null,
      activeWorkflowId: null,
      gitConfigHash: 'a'.repeat(64),
    }, null, 2)}\n`, 'utf8')
    const receipt = await manager.materializeReviewedGithub({
      review: review(commit),
      workflowId: `workflow_${'d'.repeat(24)}`,
      workspaceCwd: workspace,
    })
    expect(receipt.path).toBe(path.resolve(workspace, '.autoevo', 'sources', sourceId))
    expect(manager.pathUnderSourceRoot(receipt.path, workspace)).toBe(true)
    expect(manager.pathUnderSourceRoot(stalePath, workspace)).toBe(false)
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

  it('claims a clean completed source for a later workflow and rejects a dirty tree', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-source-claim-'))
    temporary.push(root)
    const commit = 'c'.repeat(40)
    const firstId = `workflow_${'d'.repeat(24)}`
    const secondId = `workflow_${'e'.repeat(24)}`
    const state = { head: commit, branch: `autoevo/${firstId}`, dirty: '' }
    const manager = new SourceManager(config(root), scriptedGit(state))
    const receipt = await manager.materializeReviewedGithub({
      review: review(commit),
      workflowId: firstId,
    })
    await manager.completeWorkflow(receipt.sourceId, firstId)
    const inspected = await manager.inspectCompletedSource(receipt.sourceId)
    expect(inspected?.activeWorkflowId).toBeNull()
    const claimed = await manager.claimCompletedSourceForWorkflow(receipt.sourceId, secondId)
    expect(claimed.activeWorkflowId).toBe(secondId)
    await manager.completeWorkflow(receipt.sourceId, secondId)
    state.dirty = ' M package.json\n'
    await expect(manager.inspectCompletedSource(receipt.sourceId)).resolves.toBeUndefined()
  })

  it('adopts an inactive legacy receipt only after clean repository revalidation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-source-legacy-'))
    temporary.push(root)
    const commit = 'c'.repeat(40)
    const sourceId = sourceIdForRepository('acme/calculator')
    const cfg = config(root)
    const manager = new SourceManager(cfg, scriptedGit({ head: commit, branch: 'autoevo/legacy' }))
    const legacyRoot = path.join(cfg.sourceDir!, '.autoevo-control')
    const sourcePath = path.join(cfg.sourceDir!, sourceId)
    await mkdir(path.join(sourcePath, '.git', 'hooks'), { recursive: true })
    await writeFile(path.join(sourcePath, '.git', 'config'), '[core]\nrepositoryformatversion = 0\n', 'utf8')
    await mkdir(legacyRoot, { recursive: true })
    await writeFile(path.join(legacyRoot, `${sourceId}.json`), `${JSON.stringify({
      sourceId,
      repository: 'acme/calculator',
      path: sourcePath,
      baseCommit: commit,
      branch: 'autoevo/legacy',
      headCommit: commit,
      reviewId: review().id,
      artifactHash: 'a'.repeat(64),
      activeWorkflowId: null,
      gitConfigHash: 'a'.repeat(64),
    }, null, 2)}\n`, 'utf8')
    const receipt = await manager.readReceipt(sourceId)
    expect(receipt?.path).toBe(path.resolve(sourcePath))
    expect(await manager.receiptForManagedPath(sourcePath)).toMatchObject({ sourceId, activeWorkflowId: null })
  })

  it('does not adopt a legacy receipt owned by an active workflow', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-source-legacy-active-'))
    temporary.push(root)
    const sourceId = sourceIdForRepository('acme/calculator')
    const cfg = config(root)
    const manager = new SourceManager(cfg, scriptedGit({ head: 'c'.repeat(40), branch: 'autoevo/legacy' }))
    const legacyRoot = path.join(cfg.sourceDir!, '.autoevo-control')
    await mkdir(legacyRoot, { recursive: true })
    await writeFile(path.join(legacyRoot, `${sourceId}.json`), `${JSON.stringify({
      sourceId,
      repository: 'acme/calculator',
      path: path.join(cfg.sourceDir!, sourceId),
      baseCommit: 'c'.repeat(40),
      branch: 'autoevo/legacy',
      headCommit: 'c'.repeat(40),
      reviewId: review().id,
      artifactHash: 'a'.repeat(64),
      activeWorkflowId: `workflow_${'d'.repeat(24)}`,
      gitConfigHash: 'a'.repeat(64),
    }, null, 2)}\n`, 'utf8')
    await expect(manager.readReceipt(sourceId)).resolves.toBeUndefined()
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

  it('checkpoints interrupted child edits and resumes the same workflow cleanly', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-source-resume-'))
    temporary.push(root)
    const state: { head: string; branch: string; dirty: string; commits?: string[] } = {
      head: 'c'.repeat(40), branch: 'main', dirty: '',
    }
    const manager = new SourceManager(config(root), scriptedGit(state))
    const workflowId = `workflow_${'7'.repeat(24)}`
    const receipt = await manager.materializeReviewedGithub({ review: review(), workflowId })
    await writeFile(path.join(receipt.path, 'retry.js'), 'export const retry = true\n', 'utf8')
    state.dirty = '?? retry.js\n'

    const checkpoint = await manager.preserveInterruptedChild({
      sourceId: receipt.sourceId,
      workflowId,
      reviewId: review().id,
    })
    expect(checkpoint.headCommit).not.toBe(receipt.headCommit)
    expect(state.dirty).toBe('')

    await expect(manager.resumeWorkflowSource(receipt.sourceId, workflowId)).resolves.toMatchObject({
      activeWorkflowId: workflowId,
      headCommit: checkpoint.headCommit,
    })
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
