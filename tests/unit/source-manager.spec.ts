import { mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { testReview } from '../helpers/records.js'
import { testRuntimeConfig } from '../helpers/runtime-config.js'
import { tempRoot, trackTempDirs } from '../helpers/temp-dirs.js'
import type { RuntimeConfig } from '../../src/config.js'
import type { ReviewRecord } from '../../src/contracts.js'
import type { CommandRunner } from '../../src/process/runner.js'
import { normalizeConfig } from '../../src/config.js'
import { SourceManager, sourceIdForRepository, _testing as sourceTesting, type SourceReceipt } from '../../src/source-manager.js'
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

type CompletionOwnerAcquire = (
  sourceId: string,
  workflowId: string,
  proofHash: string,
  lockRaw: string,
  lockToken: string,
) => Promise<unknown>

async function leaveCompletionProof(
  manager: SourceManager,
  sourceId: string,
  workflowId: string,
): Promise<{ receipt: SourceReceipt; lockRaw: string }> {
  const internal = manager as unknown as { acquireCompletionRecoveryOwner: CompletionOwnerAcquire }
  const acquire = internal.acquireCompletionRecoveryOwner
  internal.acquireCompletionRecoveryOwner = async () => undefined
  try {
    await expect(manager.completeWorkflow(sourceId, workflowId)).rejects.toThrow(/did not converge/i)
  } finally {
    internal.acquireCompletionRecoveryOwner = acquire
  }
  const receipt = await manager.readReceipt(sourceId)
  if (!receipt?.completionProof) throw new Error('expected a durable workflow completion proof')
  return { receipt, lockRaw: await readFile(manager.lockPath(sourceId), 'utf8') }
}

describe('SourceManager defaults and provenance', () => {
  it('keeps Host state under dshHome while leaving sources bound to the session workspace', () => {
    const cfg = normalizeConfig({ dshHome: path.resolve('C:/dsh') })
    expect(cfg.stateDir).toBe(path.resolve('C:/dsh/autoevo'))
    expect(cfg.sourceDir).toBeUndefined()
  })

  it('defaults omitted sourceDir to <workspace>/.autoevo/sources', async () => {
    const root = await tempRoot('autoevo-source-default-', temporary)
    const workspace = path.join(root, 'project')
    const manager = new SourceManager(config(root, false), scriptedGit({ head: 'c'.repeat(40), branch: 'main' }))
    expect(() => manager.sourceRoot).toThrow(/session workspace/i)
    expect(manager.sourceRootFor(workspace)).toBe(path.resolve(workspace, '.autoevo', 'sources'))
    expect(manager.sourcePath('acme_calculator', workspace)).toBe(path.resolve(workspace, '.autoevo', 'sources', 'acme_calculator'))
  })

  it('materializes into the session workspace and keeps Host control under stateDir', async () => {
    const root = await tempRoot('autoevo-source-workspace-', temporary)
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
    const root = await tempRoot('autoevo-source-unified-', temporary)
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
    const root = await tempRoot('autoevo-source-reloc-', temporary)
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
    expect(await manager.pathUnderSourceRoot(receipt.path, workspace)).toBe(true)
    expect(await manager.pathUnderSourceRoot(stalePath, workspace)).toBe(false)
  })

  it('materializes exact reviewed commit provenance onto autoevo/<workflow-id>', async () => {
    const root = await tempRoot('autoevo-source-prov-', temporary)
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

  it('strictly distinguishes a missing Git directory from an existing one', async () => {
    const root = await tempRoot('autoevo-source-git-directory-baseline-', temporary)
    const manager = new SourceManager(config(root), scriptedGit({ head: 'c'.repeat(40), branch: 'main' }))
    const gitDirectory = path.join(root, 'candidate', '.git')
    const internal = manager as unknown as {
      hasGitDirectory(candidate: string, signal?: AbortSignal): Promise<boolean>
    }

    await expect(internal.hasGitDirectory.call(manager, gitDirectory)).resolves.toBe(false)
    await mkdir(gitDirectory, { recursive: true })
    await expect(internal.hasGitDirectory.call(manager, gitDirectory)).resolves.toBe(true)
  })

  it('propagates Git-directory I/O failure before scaffold mutation and releases only its lock', async () => {
    const root = await tempRoot('autoevo-source-git-directory-eio-', temporary)
    const base = scriptedGit({ head: '0'.repeat(40), branch: 'main', dirty: '?? package.json\n' })
    const runner: CommandRunner = { run: vi.fn(async (request) => await base.run(request)) }
    const manager = new SourceManager(config(root), runner)
    const resolutionId = `resolution_${'1'.repeat(24)}`
    const workflowId = `workflow_${'1'.repeat(24)}`
    const sourceId = sourceTesting.sourceIdForCreate(resolutionId)
    const receiptWrite = vi.spyOn(manager, 'writeReceipt')
    const eio = Object.assign(new Error('Git directory probe failed'), { code: 'EIO' })
    const internal = manager as unknown as {
      accessGitDirectory(candidate: string): Promise<void>
    }
    internal.accessGitDirectory = vi.fn(async () => { throw eio })

    await expect(manager.initializeCreateSource({ resolutionId, workflowId })).rejects.toBe(eio)
    expect(runner.run).not.toHaveBeenCalled()
    expect(receiptWrite).not.toHaveBeenCalled()
    await expect(stat(path.join(manager.sourcePath(sourceId), '.git'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(path.join(manager.sourcePath(sourceId), 'lib'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(path.join(manager.sourcePath(sourceId), 'package.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(manager.lockPath(sourceId))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('returns exact cancellation when a Git-directory probe aborts then returns, before Git mutation', async () => {
    const root = await tempRoot('autoevo-source-git-directory-abort-return-', temporary)
    const base = scriptedGit({ head: 'c'.repeat(40), branch: 'main' })
    const runner: CommandRunner = { run: vi.fn(async (request) => await base.run(request)) }
    const manager = new SourceManager(config(root), runner)
    const workflowId = `workflow_${'2'.repeat(24)}`
    const sourceId = sourceIdForRepository('acme/calculator')
    const controller = new AbortController()
    const reason = new Error('Git directory probe cancelled after returning')
    const receiptWrite = vi.spyOn(manager, 'writeReceipt')
    const internal = manager as unknown as {
      accessGitDirectory(candidate: string): Promise<void>
    }
    internal.accessGitDirectory = vi.fn(async () => { controller.abort(reason) })

    await expect(manager.materializeReviewedGithub({
      review: review(),
      workflowId,
      signal: controller.signal,
    })).rejects.toBe(reason)
    expect(runner.run).not.toHaveBeenCalled()
    expect(receiptWrite).not.toHaveBeenCalled()
    await expect(stat(path.join(manager.sourcePath(sourceId), '.git'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(path.join(manager.sourcePath(sourceId), 'package.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(manager.lockPath(sourceId))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves a replacement lock when an aborting Git-directory probe rejects ordinarily', async () => {
    const root = await tempRoot('autoevo-source-git-directory-abort-reject-', temporary)
    const base = scriptedGit({ head: '0'.repeat(40), branch: 'main', dirty: '?? package.json\n' })
    const runner: CommandRunner = { run: vi.fn(async (request) => await base.run(request)) }
    const manager = new SourceManager(config(root), runner)
    const resolutionId = `resolution_${'3'.repeat(24)}`
    const workflowId = `workflow_${'3'.repeat(24)}`
    const replacementWorkflowId = `workflow_${'4'.repeat(24)}`
    const sourceId = sourceTesting.sourceIdForCreate(resolutionId)
    const controller = new AbortController()
    const reason = new Error('Git directory probe cancelled while rejecting')
    const receiptWrite = vi.spyOn(manager, 'writeReceipt')
    const replacementToken = 'replacement-git-directory-token'
    const internal = manager as unknown as {
      accessGitDirectory(candidate: string): Promise<void>
    }
    internal.accessGitDirectory = vi.fn(async () => {
      const initial = JSON.parse(await readFile(manager.lockPath(sourceId), 'utf8')) as Record<string, unknown>
      await writeFile(manager.lockPath(sourceId), `${JSON.stringify({
        ...initial,
        workflowId: replacementWorkflowId,
        lockToken: replacementToken,
      }, null, 2)}\n`, 'utf8')
      controller.abort(reason)
      throw new Error('ordinary probe rejection')
    })

    await expect(manager.initializeCreateSource({
      resolutionId,
      workflowId,
      signal: controller.signal,
    })).rejects.toBe(reason)
    expect(runner.run).not.toHaveBeenCalled()
    expect(receiptWrite).not.toHaveBeenCalled()
    await expect(stat(path.join(manager.sourcePath(sourceId), '.git'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(path.join(manager.sourcePath(sourceId), 'lib'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(path.join(manager.sourcePath(sourceId), 'package.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.parse(await readFile(manager.lockPath(sourceId), 'utf8'))).toMatchObject({
      workflowId: replacementWorkflowId,
      lockToken: replacementToken,
    })
  })

  it('lets only one same-workflow materialization invocation enter Git mutation', async () => {
    const root = await tempRoot('autoevo-source-same-workflow-materialize-', temporary)
    const workflowId = `workflow_${'7'.repeat(24)}`
    const state = { head: 'c'.repeat(40), branch: 'main' }
    const base = scriptedGit(state)
    let releaseFetch!: () => void
    const fetchBlocked = new Promise<void>((resolve) => { releaseFetch = resolve })
    let enteredFetch!: () => void
    const fetchEntered = new Promise<void>((resolve) => { enteredFetch = resolve })
    let fetches = 0
    const runner: CommandRunner = {
      async run(request) {
        if (request.argv.includes('fetch')) {
          fetches += 1
          enteredFetch()
          await fetchBlocked
        }
        return await base.run(request)
      },
    }
    const manager = new SourceManager(config(root), runner)
    const first = manager.materializeReviewedGithub({ review: review(), workflowId })
    await fetchEntered
    await expect(manager.materializeReviewedGithub({ review: review(), workflowId }))
      .rejects.toThrow(/already locked by this workflow invocation/i)
    expect(fetches).toBe(1)
    releaseFetch()
    await expect(first).resolves.toMatchObject({ activeWorkflowId: workflowId })
  })

  it('lets only one same-workflow scaffold invocation enter Git mutation', async () => {
    const root = await tempRoot('autoevo-source-same-workflow-create-', temporary)
    const workflowId = `workflow_${'8'.repeat(24)}`
    const base = scriptedGit({ head: '0'.repeat(40), branch: 'main', dirty: '?? package.json\n' })
    let releaseInit!: () => void
    const initBlocked = new Promise<void>((resolve) => { releaseInit = resolve })
    let enteredInit!: () => void
    const initEntered = new Promise<void>((resolve) => { enteredInit = resolve })
    let inits = 0
    const runner: CommandRunner = {
      async run(request) {
        if (request.argv.at(-1) === 'init') {
          inits += 1
          enteredInit()
          await initBlocked
        }
        return await base.run(request)
      },
    }
    const manager = new SourceManager(config(root), runner)
    const input = { resolutionId: `resolution_${'8'.repeat(24)}`, workflowId }
    const first = manager.initializeCreateSource(input)
    await initEntered
    await expect(manager.initializeCreateSource(input)).rejects.toThrow(/already locked by this workflow invocation/i)
    expect(inits).toBe(1)
    releaseInit()
    await expect(first).resolves.toMatchObject({ activeWorkflowId: workflowId })
  })

  it('does not delete a replacement token when stale invocation cleanup releases its old token', async () => {
    const root = await tempRoot('autoevo-source-token-cleanup-', temporary)
    const manager = new SourceManager(config(root), scriptedGit({ head: 'c'.repeat(40), branch: 'main' }))
    const sourceId = sourceIdForRepository('acme/calculator')
    const workflowId = `workflow_${'9'.repeat(24)}`
    await manager.acquireLock(sourceId, workflowId)
    const original = JSON.parse(await readFile(manager.lockPath(sourceId), 'utf8')) as { lockToken: string }
    await writeFile(manager.lockPath(sourceId), `${JSON.stringify({
      workflowId,
      pid: process.pid,
      createdAt: '2026-08-31T00:00:00.000Z',
      lockToken: 'replacement-token',
    }, null, 2)}\n`, 'utf8')
    const internal = manager as unknown as { releaseLockToken(sourceId: string, lockToken: string): Promise<void> }
    await internal.releaseLockToken(sourceId, original.lockToken)
    expect(JSON.parse(await readFile(manager.lockPath(sourceId), 'utf8'))).toMatchObject({ lockToken: 'replacement-token' })
  })

  it('cleans an initial lock only when a rejecting writer left this exact token body', async () => {
    const root = await tempRoot('autoevo-source-initial-lock-write-reject-', temporary)
    const manager = new SourceManager(config(root), scriptedGit({ head: 'c'.repeat(40), branch: 'main' }))
    const internal = manager as unknown as {
      writeInitialLock(lockFile: string, body: string): Promise<void>
      releaseLockToken(sourceId: string, lockToken: string): Promise<void>
    }
    const realWrite = internal.writeInitialLock.bind(manager)
    const writerFailure = new Error('initial writer rejected after payload landed')
    internal.writeInitialLock = async (lockFile, body) => {
      await realWrite(lockFile, body)
      throw writerFailure
    }
    const sourceId = sourceIdForRepository('acme/calculator')
    const workflowId = `workflow_${'1'.repeat(24)}`

    await expect(manager.acquireLock(sourceId, workflowId)).rejects.toBe(writerFailure)
    await expect(readFile(manager.lockPath(sourceId), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    internal.writeInitialLock = realWrite
    await manager.acquireLock(sourceId, workflowId)
    const retryToken = (JSON.parse(await readFile(manager.lockPath(sourceId), 'utf8')) as { lockToken: string }).lockToken
    await internal.releaseLockToken(sourceId, retryToken)

    const replacementSource = sourceIdForRepository('acme/replacement')
    const replacementWorkflow = `workflow_${'2'.repeat(24)}`
    const replacementBody = `${JSON.stringify({ workflowId: replacementWorkflow, pid: process.pid, lockToken: 'replacement-token' }, null, 2)}\n`
    internal.writeInitialLock = async (lockFile, body) => {
      await realWrite(lockFile, body)
      await writeFile(lockFile, replacementBody, 'utf8')
      throw writerFailure
    }
    await expect(manager.acquireLock(replacementSource, replacementWorkflow)).rejects.toBe(writerFailure)
    expect(await readFile(manager.lockPath(replacementSource), 'utf8')).toBe(replacementBody)
    internal.writeInitialLock = realWrite
  })

  it('converges a completion proof before public acquisition and then refuses mutation authority', async () => {
    const root = await tempRoot('autoevo-source-proof-acquire-', temporary)
    const workflowId = `workflow_${'a'.repeat(24)}`
    const manager = new SourceManager(config(root), scriptedGit({ head: 'c'.repeat(40), branch: `autoevo/${workflowId}` }))
    const initial = await manager.materializeReviewedGithub({ review: review(), workflowId })
    await leaveCompletionProof(manager, initial.sourceId, workflowId)

    await expect(manager.acquireLock(initial.sourceId, workflowId)).rejects.toThrow(/must be claimed/i)
    await expect(readFile(manager.lockPath(initial.sourceId), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await manager.readReceipt(initial.sourceId)).toMatchObject({ activeWorkflowId: null, completionProof: { workflowId } })
  })

  it('claims a clean completed source for a later workflow and rejects a dirty tree', async () => {
    const root = await tempRoot('autoevo-source-claim-', temporary)
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
    await manager.completeWorkflow(receipt.sourceId, firstId)
    const inspected = await manager.inspectCompletedSource(receipt.sourceId)
    expect(inspected?.activeWorkflowId).toBeNull()
    expect(inspected?.completionProof).toMatchObject({ workflowId: firstId })
    const claimed = await manager.claimCompletedSourceForWorkflow(receipt.sourceId, secondId)
    expect(claimed.activeWorkflowId).toBe(secondId)
    expect(claimed.completionProof).toBeUndefined()
    await manager.completeWorkflow(receipt.sourceId, secondId)
    state.dirty = ' M package.json\n'
    await expect(manager.inspectCompletedSource(receipt.sourceId)).resolves.toBeUndefined()
  })

  it('lets inspection finish a crash after the durable completion proof', async () => {
    const root = await tempRoot('autoevo-source-completion-proof-', temporary)
    const workflowId = `workflow_${'0'.repeat(24)}`
    const manager = new SourceManager(config(root), scriptedGit({ head: 'c'.repeat(40), branch: 'main' }))
    const initial = await manager.materializeReviewedGithub({ review: review(), workflowId })
    const crashed = await leaveCompletionProof(manager, initial.sourceId, workflowId)

    expect(crashed.receipt).toMatchObject({
      activeWorkflowId: null,
      completionProof: { workflowId, lockToken: expect.any(String) },
    })
    await expect(readFile(manager.lockPath(initial.sourceId), 'utf8')).resolves.toBe(crashed.lockRaw)

    const completed = await manager.inspectCompletedSource(initial.sourceId)
    expect(completed?.completionProof).toEqual(crashed.receipt.completionProof)
    await expect(readFile(manager.lockPath(initial.sourceId), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('finishes metadata convergence after the proof commit before rethrowing the exact abort reason', async () => {
    const root = await tempRoot('autoevo-source-completion-abort-after-proof-', temporary)
    const workflowId = `workflow_${'1'.repeat(24)}`
    const manager = new SourceManager(config(root), scriptedGit({ head: 'c'.repeat(40), branch: 'main' }))
    const initial = await manager.materializeReviewedGithub({ review: review(), workflowId })
    const controller = new AbortController()
    const reason = new Error('abort after completion proof commit')
    const writeReceipt = manager.writeReceipt.bind(manager)
    vi.spyOn(manager, 'writeReceipt').mockImplementation(async (receipt) => {
      await writeReceipt(receipt)
      if (receipt.completionProof) controller.abort(reason)
    })

    await expect(manager.completeWorkflow(initial.sourceId, workflowId, controller.signal)).rejects.toBe(reason)
    expect(await manager.readReceipt(initial.sourceId)).toMatchObject({
      activeWorkflowId: null,
      completionProof: { workflowId },
    })
    await expect(readFile(manager.lockPath(initial.sourceId), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('safely takes over a dead workflow-completion owner marker', async () => {
    const root = await tempRoot('autoevo-source-completion-owner-', temporary)
    const workflowId = `workflow_${'a'.repeat(24)}`
    const state = { head: 'c'.repeat(40), branch: 'main' }
    const manager = new SourceManager(config(root), scriptedGit(state))
    const helper = new SourceManager(config(root), scriptedGit(state))
    const initial = await manager.materializeReviewedGithub({ review: review(), workflowId })
    const crashed = await leaveCompletionProof(manager, initial.sourceId, workflowId)
    const proof = crashed.receipt.completionProof!
    await writeFile(`${manager.lockPath(initial.sourceId)}.recovery`, `${JSON.stringify({
      schemaVersion: 1,
      recoveryToken: 'dead-completion-owner',
      workflowId,
      pid: 0,
      observedLock: crashed.lockRaw,
      createdAt: '2026-08-31T00:00:00.000Z',
      purpose: 'workflow_completion',
      completionProofHash: sourceTesting.hashObject(proof),
      ownerLockToken: proof.lockToken,
    }, null, 2)}\n`, 'utf8')

    await expect(helper.inspectCompletedSource(initial.sourceId)).resolves.toMatchObject({ activeWorkflowId: null })
    await expect(readFile(manager.lockPath(initial.sourceId), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(`${manager.lockPath(initial.sourceId)}.recovery`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rebuilds completion ownership after marker removal and retries a failed lock delete', async () => {
    const root = await tempRoot('autoevo-source-completion-delete-retry-', temporary)
    const workflowId = `workflow_${'b'.repeat(24)}`
    const manager = new SourceManager(config(root), scriptedGit({ head: 'c'.repeat(40), branch: 'main' }))
    const initial = await manager.materializeReviewedGithub({ review: review(), workflowId })
    const internal = manager as unknown as {
      removeOwnedLockPath(sourceId: string): Promise<void>
    }
    const removeOwnedLockPath = internal.removeOwnedLockPath
    let attempts = 0
    internal.removeOwnedLockPath = async (sourceId) => {
      attempts += 1
      if (attempts === 1) throw new Error('injected lock delete failure')
      await removeOwnedLockPath.call(manager, sourceId)
    }

    await expect(manager.completeWorkflow(initial.sourceId, workflowId)).rejects.toThrow(/injected lock delete failure/i)
    expect(await manager.readReceipt(initial.sourceId)).toMatchObject({
      activeWorkflowId: null,
      completionProof: { workflowId },
    })
    await expect(readFile(`${manager.lockPath(initial.sourceId)}.recovery`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(manager.lockPath(initial.sourceId), 'utf8')).resolves.toContain(workflowId)

    await manager.completeWorkflow(initial.sourceId, workflowId)
    expect(attempts).toBe(2)
    await expect(readFile(manager.lockPath(initial.sourceId), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('treats an unlink error as committed when the exact lock path is already missing', async () => {
    const root = await tempRoot('autoevo-source-completion-delete-landed-', temporary)
    const workflowId = `workflow_${'2'.repeat(24)}`
    const manager = new SourceManager(config(root), scriptedGit({ head: 'c'.repeat(40), branch: 'main' }))
    const initial = await manager.materializeReviewedGithub({ review: review(), workflowId })
    const internal = manager as unknown as { removeOwnedLockPath(sourceId: string): Promise<void> }
    const removeOwnedLockPath = internal.removeOwnedLockPath
    internal.removeOwnedLockPath = async (sourceId) => {
      await removeOwnedLockPath.call(manager, sourceId)
      throw new Error('unlink reported failure after commit')
    }

    await expect(manager.completeWorkflow(initial.sourceId, workflowId)).resolves.toBeUndefined()
    await expect(readFile(manager.lockPath(initial.sourceId), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(`${manager.lockPath(initial.sourceId)}.recovery`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retries a token-checked marker removal in finally after the first removal fails', async () => {
    const root = await tempRoot('autoevo-source-completion-marker-retry-', temporary)
    const workflowId = `workflow_${'7'.repeat(24)}`
    const nextId = `workflow_${'8'.repeat(24)}`
    const manager = new SourceManager(config(root), scriptedGit({ head: 'c'.repeat(40), branch: 'main' }))
    const initial = await manager.materializeReviewedGithub({ review: review(), workflowId })
    const internal = manager as unknown as {
      releaseRecoveryOwner(sourceId: string, recoveryToken: string): Promise<void>
    }
    const releaseRecoveryOwner = internal.releaseRecoveryOwner
    const firstFailure = new Error('first completion marker removal failed')
    let attempts = 0
    internal.releaseRecoveryOwner = async (sourceId, recoveryToken) => {
      attempts += 1
      if (attempts === 1) throw firstFailure
      await releaseRecoveryOwner.call(manager, sourceId, recoveryToken)
    }

    await expect(manager.completeWorkflow(initial.sourceId, workflowId)).rejects.toBe(firstFailure)
    expect(attempts).toBe(2)
    await expect(readFile(`${manager.lockPath(initial.sourceId)}.recovery`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(manager.lockPath(initial.sourceId), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(manager.inspectCompletedSource(initial.sourceId)).resolves.toMatchObject({ activeWorkflowId: null })
    await expect(manager.claimCompletedSourceForWorkflow(initial.sourceId, nextId)).resolves.toMatchObject({
      activeWorkflowId: nextId,
    })
  })

  it('preserves the first marker-removal error and leaves the marker sealed when both attempts fail', async () => {
    const root = await tempRoot('autoevo-source-completion-marker-double-failure-', temporary)
    const workflowId = `workflow_${'9'.repeat(24)}`
    const manager = new SourceManager(config(root), scriptedGit({ head: 'c'.repeat(40), branch: 'main' }))
    const initial = await manager.materializeReviewedGithub({ review: review(), workflowId })
    const internal = manager as unknown as {
      releaseRecoveryOwner(sourceId: string, recoveryToken: string): Promise<void>
    }
    const firstFailure = new Error('completion marker removal remains unavailable')
    let attempts = 0
    internal.releaseRecoveryOwner = async () => {
      attempts += 1
      throw attempts === 1 ? firstFailure : new Error('finally marker cleanup also failed')
    }

    await expect(manager.completeWorkflow(initial.sourceId, workflowId)).rejects.toBe(firstFailure)
    expect(attempts).toBe(2)
    await expect(readFile(`${manager.lockPath(initial.sourceId)}.recovery`, 'utf8')).resolves.toContain('workflow_completion')
    await expect(readFile(manager.lockPath(initial.sourceId), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(manager.inspectCompletedSource(initial.sourceId)).resolves.toBeUndefined()
    await expect(manager.claimCompletedSourceForWorkflow(initial.sourceId, `workflow_${'a'.repeat(24)}`))
      .rejects.toThrow(/missing|locked|recovery/iu)
  })

  it('keeps its completion marker when a delete error reveals a replacement lock', async () => {
    const root = await tempRoot('autoevo-source-completion-delete-replacement-', temporary)
    const workflowId = `workflow_${'3'.repeat(24)}`
    const replacementId = `workflow_${'4'.repeat(24)}`
    const manager = new SourceManager(config(root), scriptedGit({ head: 'c'.repeat(40), branch: 'main' }))
    const initial = await manager.materializeReviewedGithub({ review: review(), workflowId })
    const internal = manager as unknown as { removeOwnedLockPath(sourceId: string): Promise<void> }
    const removeOwnedLockPath = internal.removeOwnedLockPath
    const replacement = {
      workflowId: replacementId,
      createdAt: '2026-08-31T00:00:00.000Z',
      pid: process.pid,
      lockToken: 'replacement-lock-token',
      headCommit: initial.headCommit,
      branch: initial.branch,
      gitConfigHash: initial.gitConfigHash,
    }
    internal.removeOwnedLockPath = async (sourceId) => {
      await removeOwnedLockPath.call(manager, sourceId)
      await writeFile(manager.lockPath(sourceId), `${JSON.stringify(replacement, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
      throw new Error('unlink raced with replacement')
    }

    await expect(manager.completeWorkflow(initial.sourceId, workflowId)).rejects.toThrow(/recovery remains sealed/i)
    await expect(readFile(`${manager.lockPath(initial.sourceId)}.recovery`, 'utf8')).resolves.toContain('workflow_completion')
    await expect(readFile(manager.lockPath(initial.sourceId), 'utf8').then((body) => JSON.parse(body))).resolves.toEqual(replacement)
  })

  it('recovers a valid fixed completion-takeover barrier when the owner marker is missing', async () => {
    const root = await tempRoot('autoevo-source-completion-takeover-orphan-', temporary)
    const workflowId = `workflow_${'5'.repeat(24)}`
    const manager = new SourceManager(config(root), scriptedGit({ head: 'c'.repeat(40), branch: 'main' }))
    const initial = await manager.materializeReviewedGithub({ review: review(), workflowId })
    const crashed = await leaveCompletionProof(manager, initial.sourceId, workflowId)
    const proof = crashed.receipt.completionProof!
    const takeover = `${manager.lockPath(initial.sourceId)}.recovery.workflow-completion-takeover`
    await writeFile(takeover, `${JSON.stringify({
      schemaVersion: 1,
      recoveryToken: 'dead-takeover-owner',
      workflowId,
      pid: 0,
      observedLock: crashed.lockRaw,
      createdAt: '2026-08-31T00:00:00.000Z',
      purpose: 'workflow_completion',
      completionProofHash: sourceTesting.hashObject(proof),
      ownerLockToken: proof.lockToken,
    }, null, 2)}\n`, 'utf8')

    await expect(manager.inspectCompletedSource(initial.sourceId)).resolves.toMatchObject({ activeWorkflowId: null })
    await expect(readFile(takeover, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(manager.lockPath(initial.sourceId), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('makes no write for a mismatched fixed completion-takeover barrier', async () => {
    const root = await tempRoot('autoevo-source-completion-takeover-mismatch-', temporary)
    const workflowId = `workflow_${'6'.repeat(24)}`
    const manager = new SourceManager(config(root), scriptedGit({ head: 'c'.repeat(40), branch: 'main' }))
    const initial = await manager.materializeReviewedGithub({ review: review(), workflowId })
    const crashed = await leaveCompletionProof(manager, initial.sourceId, workflowId)
    const takeover = `${manager.lockPath(initial.sourceId)}.recovery.workflow-completion-takeover`
    const mismatch = `${JSON.stringify({
      schemaVersion: 1,
      recoveryToken: 'mismatched-takeover-owner',
      workflowId,
      pid: 0,
      observedLock: crashed.lockRaw,
      createdAt: '2026-08-31T00:00:00.000Z',
      purpose: 'workflow_completion',
      completionProofHash: '0'.repeat(64),
      ownerLockToken: crashed.receipt.completionProof!.lockToken,
    }, null, 2)}\n`
    await writeFile(takeover, mismatch, 'utf8')

    await expect(manager.inspectCompletedSource(initial.sourceId)).resolves.toBeUndefined()
    await expect(readFile(takeover, 'utf8')).resolves.toBe(mismatch)
    await expect(readFile(manager.lockPath(initial.sourceId), 'utf8')).resolves.toBe(crashed.lockRaw)
    expect(await manager.readReceipt(initial.sourceId)).toEqual(crashed.receipt)
    await expect(readFile(`${manager.lockPath(initial.sourceId)}.recovery`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('allows only one live completion helper while the loser makes no durable change', async () => {
    const root = await tempRoot('autoevo-source-completion-helper-race-', temporary)
    const workflowId = `workflow_${'c'.repeat(24)}`
    const state = { head: 'c'.repeat(40), branch: 'main' }
    const first = new SourceManager(config(root), scriptedGit(state))
    const second = new SourceManager(config(root), scriptedGit(state))
    const initial = await first.materializeReviewedGithub({ review: review(), workflowId })
    const crashed = await leaveCompletionProof(first, initial.sourceId, workflowId)
    const internal = first as unknown as {
      repositoryMatchesReceipt(receipt: SourceReceipt, signal?: AbortSignal): Promise<boolean>
    }
    const repositoryMatchesReceipt = internal.repositoryMatchesReceipt
    let entered!: () => void
    let resume!: () => void
    const arrived = new Promise<void>((resolve) => { entered = resolve })
    const barrier = new Promise<void>((resolve) => { resume = resolve })
    internal.repositoryMatchesReceipt = async (receipt, signal) => {
      entered()
      await barrier
      return await repositoryMatchesReceipt.call(first, receipt, signal)
    }

    const winner = first.inspectCompletedSource(initial.sourceId)
    await arrived
    await expect(second.inspectCompletedSource(initial.sourceId)).resolves.toBeUndefined()
    await expect(readFile(first.lockPath(initial.sourceId), 'utf8')).resolves.toBe(crashed.lockRaw)
    expect(await first.readReceipt(initial.sourceId)).toEqual(crashed.receipt)
    resume()
    await expect(winner).resolves.toMatchObject({ activeWorkflowId: null })
  })

  it('keeps the completion marker through the exact lock unlink so a claimant cannot publish a replacement early', async () => {
    const root = await tempRoot('autoevo-source-completion-replacement-', temporary)
    const firstId = `workflow_${'d'.repeat(24)}`
    const nextId = `workflow_${'e'.repeat(24)}`
    const state = { head: 'c'.repeat(40), branch: 'main' }
    const first = new SourceManager(config(root), scriptedGit(state))
    const second = new SourceManager(config(root), scriptedGit(state))
    const initial = await first.materializeReviewedGithub({ review: review(), workflowId: firstId })
    const crashed = await leaveCompletionProof(first, initial.sourceId, firstId)
    const oldToken = crashed.receipt.completionProof!.lockToken
    const internal = first as unknown as {
      removeOwnedLockPath(sourceId: string): Promise<void>
    }
    const removeOwnedLockPath = internal.removeOwnedLockPath
    let paused!: () => void
    let resume!: () => void
    const arrived = new Promise<void>((resolve) => { paused = resolve })
    const barrier = new Promise<void>((resolve) => { resume = resolve })
    internal.removeOwnedLockPath = async (sourceId) => {
      paused()
      await barrier
      await removeOwnedLockPath.call(first, sourceId)
    }

    const oldHelper = first.inspectCompletedSource(initial.sourceId)
    await arrived
    await expect(second.claimCompletedSourceForWorkflow(initial.sourceId, nextId)).rejects.toThrow(/missing|locked|recovery/iu)
    await expect(readFile(`${first.lockPath(initial.sourceId)}.recovery`, 'utf8')).resolves.toContain('workflow_completion')
    await expect(readFile(first.lockPath(initial.sourceId), 'utf8')).resolves.toBe(crashed.lockRaw)
    resume()
    await expect(oldHelper).resolves.toMatchObject({ activeWorkflowId: null })
    await expect(readFile(`${first.lockPath(initial.sourceId)}.recovery`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    const claimed = await second.claimCompletedSourceForWorkflow(initial.sourceId, nextId)
    expect(claimed.activeWorkflowId).toBe(nextId)
    const replacement = JSON.parse(await readFile(first.lockPath(initial.sourceId), 'utf8')) as {
      workflowId: string
      lockToken: string
    }
    expect(replacement.workflowId).toBe(nextId)
    expect(replacement.lockToken).not.toBe(oldToken)
    expect(await first.readReceipt(initial.sourceId)).toMatchObject({ activeWorkflowId: nextId })
  })

  it('makes no recovery write for a mismatched completion proof', async () => {
    const root = await tempRoot('autoevo-source-completion-mismatch-', temporary)
    const workflowId = `workflow_${'f'.repeat(24)}`
    const manager = new SourceManager(config(root), scriptedGit({ head: 'c'.repeat(40), branch: 'main' }))
    const initial = await manager.materializeReviewedGithub({ review: review(), workflowId })
    const crashed = await leaveCompletionProof(manager, initial.sourceId, workflowId)
    const corrupted: SourceReceipt = {
      ...crashed.receipt,
      completionProof: { ...crashed.receipt.completionProof!, activeReceiptHash: '0'.repeat(64) },
    }
    await manager.writeReceipt(corrupted)

    await expect(manager.inspectCompletedSource(initial.sourceId)).resolves.toBeUndefined()
    expect(await manager.readReceipt(initial.sourceId)).toEqual(corrupted)
    await expect(readFile(manager.lockPath(initial.sourceId), 'utf8')).resolves.toBe(crashed.lockRaw)
    await expect(readFile(`${manager.lockPath(initial.sourceId)}.recovery`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps a dead pre-claim lock fail-closed even when the completed source is clean', async () => {
    const root = await tempRoot('autoevo-source-preclaim-recover-', temporary)
    const commit = 'c'.repeat(40)
    const firstId = `workflow_${'1'.repeat(24)}`
    const nextId = `workflow_${'2'.repeat(24)}`
    const state = { head: commit, branch: `autoevo/${firstId}`, dirty: '' }
    const manager = new SourceManager(config(root), scriptedGit(state))
    const receipt = await manager.materializeReviewedGithub({ review: review(commit), workflowId: firstId })
    await manager.completeWorkflow(receipt.sourceId, firstId)
    await writeFile(manager.lockPath(receipt.sourceId), `${JSON.stringify({
      workflowId: nextId,
      createdAt: '2026-08-31T00:00:00.000Z',
      pid: 0,
    }, null, 2)}\n`, 'utf8')

    await expect(manager.claimCompletedSourceForWorkflow(receipt.sourceId, nextId)).rejects.toThrow(
      /missing, locked, dirty, or drifted/u,
    )
    expect(await manager.readReceipt(receipt.sourceId)).toMatchObject({ activeWorkflowId: null })
    await expect(readFile(manager.lockPath(receipt.sourceId), 'utf8').then((body) => JSON.parse(body))).resolves
      .toMatchObject({ workflowId: nextId, pid: 0 })
  })

  it('keeps a dead pre-claim lock fail-closed when the completed source is dirty', async () => {
    const root = await tempRoot('autoevo-source-preclaim-dirty-', temporary)
    const commit = 'c'.repeat(40)
    const firstId = `workflow_${'3'.repeat(24)}`
    const nextId = `workflow_${'4'.repeat(24)}`
    const state = { head: commit, branch: `autoevo/${firstId}`, dirty: '' }
    const manager = new SourceManager(config(root), scriptedGit(state))
    const receipt = await manager.materializeReviewedGithub({ review: review(commit), workflowId: firstId })
    await manager.completeWorkflow(receipt.sourceId, firstId)
    const crashedLock = {
      workflowId: nextId,
      createdAt: '2026-08-31T00:00:00.000Z',
      pid: 0,
    }
    await writeFile(manager.lockPath(receipt.sourceId), `${JSON.stringify(crashedLock, null, 2)}\n`, 'utf8')
    state.dirty = ' M package.json\n'

    await expect(manager.claimCompletedSourceForWorkflow(receipt.sourceId, nextId)).rejects.toThrow(
      /missing, locked, dirty, or drifted/u,
    )

    expect(await manager.readReceipt(receipt.sourceId)).toMatchObject({ activeWorkflowId: null })
    await expect(readFile(manager.lockPath(receipt.sourceId), 'utf8').then((body) => JSON.parse(body))).resolves.toEqual(
      crashedLock,
    )
  })

  it('publishes one fully bound lock before exactly one of three completed-source claims activates its receipt', async () => {
    const root = await tempRoot('autoevo-source-preclaim-race-', temporary)
    const commit = 'c'.repeat(40)
    const firstId = `workflow_${'5'.repeat(24)}`
    const state = { head: commit, branch: `autoevo/${firstId}`, dirty: '' }
    const firstManager = new SourceManager(config(root), scriptedGit(state))
    const secondManager = new SourceManager(config(root), scriptedGit(state))
    const thirdManager = new SourceManager(config(root), scriptedGit(state))
    const receipt = await firstManager.materializeReviewedGithub({ review: review(commit), workflowId: firstId })
    await firstManager.completeWorkflow(receipt.sourceId, firstId)

    const managers = [firstManager, secondManager, thirdManager]
    let arrived = 0
    let release!: () => void
    const barrier = new Promise<void>((resolve) => { release = resolve })
    for (const manager of managers) {
      const inspect = manager.inspectCompletedSource.bind(manager)
      manager.inspectCompletedSource = async (...args) => {
        const inspected = await inspect(...args)
        arrived += 1
        if (arrived === managers.length) release()
        await barrier
        return inspected
      }
      const persist = manager.writeReceipt.bind(manager)
      manager.writeReceipt = async (next) => {
        if (next.activeWorkflowId) {
          const lock = JSON.parse(await readFile(manager.lockPath(next.sourceId), 'utf8')) as {
            workflowId: string
            lockToken?: string
            headCommit?: string
            branch?: string
            gitConfigHash?: string
          }
          expect(lock).toMatchObject({
            workflowId: next.activeWorkflowId,
            lockToken: expect.stringMatching(/^[a-f0-9-]{36}$/u),
            headCommit: next.headCommit,
            branch: next.branch,
            gitConfigHash: next.gitConfigHash,
          })
        }
        await persist(next)
      }
    }
    const contenders = [
      `workflow_${'6'.repeat(24)}`,
      `workflow_${'7'.repeat(24)}`,
      `workflow_${'8'.repeat(24)}`,
    ]

    const results = await Promise.allSettled(managers.map((manager, index) =>
      manager.claimCompletedSourceForWorkflow(receipt.sourceId, contenders[index]!)))

    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected', 'rejected'])
    const winner = results.find((result) => result.status === 'fulfilled')
    if (!winner || winner.status !== 'fulfilled') throw new Error('expected one completed-source claim winner')
    expect(winner.value.activeWorkflowId).toBeTruthy()
    const stored = await firstManager.readReceipt(receipt.sourceId)
    expect(stored?.activeWorkflowId).toBe(winner.value.activeWorkflowId)
    const lock = JSON.parse(await readFile(firstManager.lockPath(receipt.sourceId), 'utf8')) as {
      workflowId: string
      pid: number
      lockToken?: string
    }
    expect(lock).toMatchObject({
      workflowId: winner.value.activeWorkflowId,
      pid: process.pid,
      lockToken: expect.stringMatching(/^[a-f0-9-]{36}$/u),
    })
  })

  it('preserves cancellation before a completed-source claim publishes its lock', async () => {
    const root = await tempRoot('autoevo-source-claim-cancel-before-', temporary)
    const commit = 'c'.repeat(40)
    const firstId = `workflow_${'9'.repeat(24)}`
    const manager = new SourceManager(config(root), scriptedGit({ head: commit, branch: `autoevo/${firstId}` }))
    const receipt = await manager.materializeReviewedGithub({ review: review(commit), workflowId: firstId })
    await manager.completeWorkflow(receipt.sourceId, firstId)
    const controller = new AbortController()
    controller.abort(new Error('cancel before lock'))

    await expect(manager.claimCompletedSourceForWorkflow(
      receipt.sourceId,
      `workflow_${'a'.repeat(24)}`,
      controller.signal,
    )).rejects.toThrow(/cancel before lock/u)
    expect(await manager.readReceipt(receipt.sourceId)).toMatchObject({ activeWorkflowId: null })
    await expect(readFile(manager.lockPath(receipt.sourceId), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rolls back only its tokenized lock when cancellation starts between lock publication and receipt activation', async () => {
    const root = await tempRoot('autoevo-source-claim-cancel-between-', temporary)
    const commit = 'c'.repeat(40)
    const firstId = `workflow_${'b'.repeat(24)}`
    const nextId = `workflow_${'c'.repeat(24)}`
    const manager = new SourceManager(config(root), scriptedGit({ head: commit, branch: `autoevo/${firstId}` }))
    const receipt = await manager.materializeReviewedGithub({ review: review(commit), workflowId: firstId })
    await manager.completeWorkflow(receipt.sourceId, firstId)
    const controller = new AbortController()
    const persist = manager.writeReceipt.bind(manager)
    manager.writeReceipt = async (next) => {
      if (next.activeWorkflowId === nextId) {
        const lock = JSON.parse(await readFile(manager.lockPath(next.sourceId), 'utf8')) as { lockToken?: string }
        expect(lock.lockToken).toMatch(/^[a-f0-9-]{36}$/u)
        controller.abort(new Error('cancel between lock and receipt'))
        controller.signal.throwIfAborted()
      }
      await persist(next)
    }

    await expect(manager.claimCompletedSourceForWorkflow(receipt.sourceId, nextId, controller.signal))
      .rejects.toThrow(/cancel between lock and receipt/u)
    expect(await manager.readReceipt(receipt.sourceId)).toMatchObject({ activeWorkflowId: null })
    await expect(readFile(manager.lockPath(receipt.sourceId), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('adopts an inactive legacy receipt only after clean repository revalidation', async () => {
    const root = await tempRoot('autoevo-source-legacy-', temporary)
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
    const root = await tempRoot('autoevo-source-legacy-active-', temporary)
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
    const root = await tempRoot('autoevo-source-dirty-', temporary)
    const git = scriptedGit({ head: 'c'.repeat(40), branch: 'main', dirty: ' M package.json\n' })
    const manager = new SourceManager(config(root), git)
    await expect(manager.materializeReviewedGithub({
      review: review(),
      workflowId: `workflow_${'e'.repeat(24)}`,
    })).rejects.toThrow(/dirty/i)
  })

  it('rejects concurrent locks and keeps cross-workflow stale takeover fail-closed', async () => {
    const root = await tempRoot('autoevo-source-lock-', temporary)
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

    // A dead lock still cannot authorize a different workflow to replace the receipt owner.
    await writeFile(manager.lockPath(first.sourceId), `${JSON.stringify({
      workflowId: `workflow_${'f'.repeat(24)}`,
      createdAt: '2026-08-01T00:00:00.000Z',
      pid: 0,
      headCommit: commit,
      branch: `autoevo/workflow_${'f'.repeat(24)}`,
    }, null, 2)}\n`)
    await expect(manager.materializeReviewedGithub({
      review: review(commit),
      workflowId: `workflow_${'b'.repeat(24)}`,
    })).rejects.toThrow(/failed revalidation/u)
    expect(await manager.readReceipt(first.sourceId)).toMatchObject({ activeWorkflowId: `workflow_${'f'.repeat(24)}` })
  })

  it('defends against path escape and symlink roots', async () => {
    const root = await tempRoot('autoevo-source-escape-', temporary)
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
    const root = await tempRoot('autoevo-source-finalize-', temporary)
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
    const root = await tempRoot('autoevo-source-resume-', temporary)
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

  it('resumes the same clean managed workflow after a Host restart', async () => {
    const root = await tempRoot('autoevo-source-restart-', temporary)
    const commit = 'c'.repeat(40)
    const workflowId = `workflow_${'6'.repeat(24)}`
    const branch = `autoevo/${workflowId}`
    const manager = new SourceManager(config(root), scriptedGit({ head: commit, branch }))
    const receipt = await manager.materializeReviewedGithub({ review: review(commit), workflowId })

    await writeFile(manager.lockPath(receipt.sourceId), `${JSON.stringify({
      workflowId,
      createdAt: '2026-08-01T00:00:00.000Z',
      pid: 0,
      headCommit: commit,
      branch,
    }, null, 2)}\n`)

    await expect(manager.resumeWorkflowSource(receipt.sourceId, workflowId)).resolves.toMatchObject({
      activeWorkflowId: workflowId,
      headCommit: commit,
    })
    const reclaimed = JSON.parse(await readFile(manager.lockPath(receipt.sourceId), 'utf8')) as { pid: number }
    expect(reclaimed.pid).toBe(process.pid)
  })

  it('returns a non-cleanup verified handle for an active same-process workflow reentry', async () => {
    const root = await tempRoot('autoevo-source-verified-reentry-', temporary)
    const workflowId = `workflow_${'b'.repeat(24)}`
    const manager = new SourceManager(config(root), scriptedGit({ head: 'c'.repeat(40), branch: `autoevo/${workflowId}` }))
    const receipt = await manager.materializeReviewedGithub({ review: review(), workflowId })
    const internal = manager as unknown as {
      acquireLockInternal(sourceId: string, workflowId: string, signal: AbortSignal | undefined, workspaceCwd: string | undefined, allowVerifiedReentry: boolean): Promise<{ lockToken: string; acquiredHere: boolean }>
    }
    const handle = await internal.acquireLockInternal(receipt.sourceId, workflowId, undefined, undefined, true)
    const lock = JSON.parse(await readFile(manager.lockPath(receipt.sourceId), 'utf8')) as { lockToken: string }
    expect(handle).toMatchObject({ lockToken: lock.lockToken, acquiredHere: false })
    await expect(manager.resumeWorkflowSource(receipt.sourceId, workflowId)).resolves.toMatchObject({ activeWorkflowId: workflowId })
  })

  it('removes its recovery marker when cancellation starts during post-marker revalidation', async () => {
    const root = await tempRoot('autoevo-source-recovery-marker-cancel-', temporary)
    const commit = 'c'.repeat(40)
    const workflowId = `workflow_${'1'.repeat(24)}`
    const branch = `autoevo/${workflowId}`
    const state = { head: commit, branch }
    const base = scriptedGit(state)
    const controller = new AbortController()
    let recovering = false
    let statusCalls = 0
    const runner: CommandRunner = {
      async run(request) {
        const result = await base.run(request)
        if (recovering && request.argv.at(-2) === 'status' && request.argv.at(-1) === '--porcelain') {
          statusCalls += 1
          if (statusCalls === 2) controller.abort(new Error('cancel after recovery marker'))
        }
        return result
      },
    }
    const manager = new SourceManager(config(root), runner)
    const receipt = await manager.materializeReviewedGithub({ review: review(commit), workflowId })
    const staleLock = `${JSON.stringify({
      workflowId,
      createdAt: '2026-08-01T00:00:00.000Z',
      pid: 0,
      headCommit: commit,
      branch,
    }, null, 2)}\n`
    await writeFile(manager.lockPath(receipt.sourceId), staleLock)
    const originalReceipt = await manager.readReceipt(receipt.sourceId)
    recovering = true

    await expect(manager.resumeWorkflowSource(receipt.sourceId, workflowId, controller.signal))
      .rejects.toThrow(/cancel after recovery marker/u)

    await expect(readFile(manager.lockPath(receipt.sourceId), 'utf8')).resolves.toBe(staleLock)
    await expect(manager.readReceipt(receipt.sourceId)).resolves.toEqual(originalReceipt)
    await expect(readFile(`${manager.lockPath(receipt.sourceId)}.recovery`, 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
    recovering = false
    await expect(manager.resumeWorkflowSource(receipt.sourceId, workflowId)).resolves.toMatchObject({
      activeWorkflowId: workflowId,
    })
  })

  it('removes its recovery marker when second-round repository revalidation throws', async () => {
    const root = await tempRoot('autoevo-source-recovery-marker-error-', temporary)
    const commit = 'c'.repeat(40)
    const workflowId = `workflow_${'2'.repeat(24)}`
    const branch = `autoevo/${workflowId}`
    const state = { head: commit, branch }
    const base = scriptedGit(state)
    let recovering = false
    let statusCalls = 0
    const runner: CommandRunner = {
      async run(request) {
        if (recovering && request.argv.at(-2) === 'status' && request.argv.at(-1) === '--porcelain') {
          statusCalls += 1
          if (statusCalls === 2) throw new Error('second recovery revalidation failed')
        }
        return await base.run(request)
      },
    }
    const manager = new SourceManager(config(root), runner)
    const receipt = await manager.materializeReviewedGithub({ review: review(commit), workflowId })
    const staleLock = `${JSON.stringify({
      workflowId,
      createdAt: '2026-08-01T00:00:00.000Z',
      pid: 0,
      headCommit: commit,
      branch,
    }, null, 2)}\n`
    await writeFile(manager.lockPath(receipt.sourceId), staleLock)
    const originalReceipt = await manager.readReceipt(receipt.sourceId)
    recovering = true

    await expect(manager.resumeWorkflowSource(receipt.sourceId, workflowId))
      .rejects.toThrow(/second recovery revalidation failed/u)

    await expect(readFile(manager.lockPath(receipt.sourceId), 'utf8')).resolves.toBe(staleLock)
    await expect(manager.readReceipt(receipt.sourceId)).resolves.toEqual(originalReceipt)
    await expect(readFile(`${manager.lockPath(receipt.sourceId)}.recovery`, 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
    recovering = false
    await expect(manager.resumeWorkflowSource(receipt.sourceId, workflowId)).resolves.toMatchObject({
      activeWorkflowId: workflowId,
    })
  })

  it('commits when node_modules exists but is excluded via .git/info/exclude', async () => {
    const root = await tempRoot('autoevo-source-exclude-', temporary)
    const state: { head: string; branch: string; dirty: string; commits?: string[] } = {
      head: 'c'.repeat(40), branch: 'main', dirty: '',
    }
    const manager = new SourceManager(config(root), scriptedGit(state))
    const workflowId = `workflow_${'a'.repeat(24)}`
    const receipt = await manager.materializeReviewedGithub({ review: review(), workflowId })
    const exclude = await readFile(path.join(receipt.path, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude).toContain('node_modules/')
    expect(exclude).toContain('.pnpm-store/')
    await mkdir(path.join(receipt.path, 'node_modules', 'left-pad'), { recursive: true })
    await writeFile(path.join(receipt.path, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n', 'utf8')
    await writeFile(path.join(receipt.path, 'lib.js'), 'export const ready = true\n', 'utf8')
    // Git status omits excluded install trees; the Host still commits honest source/lockfile edits.
    state.dirty = '?? lib.js\n?? pnpm-lock.yaml\n'
    const committed = await manager.finalizeChildCommit({
      sourceId: receipt.sourceId,
      workflowId,
      reviewId: review().id,
      message: 'feat: child change with materialized deps',
    })
    expect(committed.headCommit).not.toBe(receipt.headCommit)
    expect(state.commits).toHaveLength(1)
  })

  it('writes Host install excludes when scaffolding a create source', async () => {
    const root = await tempRoot('autoevo-source-scaffold-exclude-', temporary)
    const state: { head: string; branch: string; dirty: string; commits?: string[] } = {
      head: '0'.repeat(40), branch: 'main', dirty: '?? package.json\n',
    }
    const manager = new SourceManager(config(root), scriptedGit(state))
    const receipt = await manager.initializeCreateSource({
      resolutionId: `resolution_${'c'.repeat(24)}`,
      workflowId: `workflow_${'d'.repeat(24)}`,
    })
    const exclude = await readFile(path.join(receipt.path, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude).toContain('node_modules/')
    expect(exclude).toContain('.pnpm-store/')
  })

  it('rejects untracked dependency stores before Host git add', async () => {
    expect(sourceTesting.forbiddenUntrackedPath('?? .pnpm-store/v10/files/cache\n')).toBe('.pnpm-store/v10/files/cache')
    expect(sourceTesting.forbiddenUntrackedPath('?? node_modules/\n')).toBe('node_modules/')
    const root = await tempRoot('autoevo-source-cache-', temporary)
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
    const root = await tempRoot('autoevo-source-git-config-', temporary)
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
    const root = await tempRoot('autoevo-source-git-hooks-', temporary)
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
    const root = await tempRoot('autoevo-source-survive-', temporary)
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

  it('accepts a symlink-aliased stateDir for the disabled-hooks containment check', async () => {
    const root = await tempRoot('autoevo-source-alias-state-', temporary)
    const realState = path.join(root, 'real-state')
    await mkdir(realState, { recursive: true })
    const aliasState = path.join(root, 'alias-state')
    await symlink(realState, aliasState, process.platform === 'win32' ? 'junction' : 'dir')
    const commit = 'c'.repeat(40)
    const manager = new SourceManager(
      config(root, path.join(root, 'sources'), aliasState),
      scriptedGit({ head: commit, branch: 'main' }),
    )
    const receipt = await manager.materializeReviewedGithub({
      review: review(commit),
      workflowId: `workflow_${'d'.repeat(24)}`,
    })
    expect(receipt.headCommit).toBe(commit)
  })

  it('still rejects a disabled-hooks directory that genuinely escapes stateDir', async () => {
    const root = await tempRoot('autoevo-source-hooks-escape-', temporary)
    const state = path.join(root, 'state')
    await mkdir(state, { recursive: true })
    const outside = path.join(root, 'outside')
    await mkdir(outside, { recursive: true })
    await symlink(outside, path.join(state, 'source-control'), process.platform === 'win32' ? 'junction' : 'dir')
    const manager = new SourceManager(
      config(root, path.join(root, 'sources'), state),
      scriptedGit({ head: 'c'.repeat(40), branch: 'main' }),
    )
    await expect(manager.materializeReviewedGithub({
      review: review(),
      workflowId: `workflow_${'d'.repeat(24)}`,
    })).rejects.toThrow(/escaped AutoEvo stateDir/i)
  })

  it('accepts a symlink-aliased sourceDir for managed source containment and receipt equality', async () => {
    const root = await tempRoot('autoevo-source-alias-source-', temporary)
    const realSources = path.join(root, 'real-sources')
    await mkdir(realSources, { recursive: true })
    const aliasSources = path.join(root, 'alias-sources')
    await symlink(realSources, aliasSources, process.platform === 'win32' ? 'junction' : 'dir')
    const state = { head: 'c'.repeat(40), branch: 'main', dirty: '' }
    const manager = new SourceManager(config(root, aliasSources), scriptedGit(state))
    const workflowId = `workflow_${'d'.repeat(24)}`
    const receipt = await manager.materializeReviewedGithub({ review: review(), workflowId })
    expect(receipt.path).toBe(await realpath(manager.sourcePath(receipt.sourceId)))
    expect(await manager.pathUnderSourceRoot(receipt.path)).toBe(true)
    await writeFile(path.join(receipt.path, 'lib.js'), 'export const x = 1\n', 'utf8')
    state.dirty = '?? lib.js\n'
    const committed = await manager.finalizeChildCommit({
      sourceId: receipt.sourceId,
      workflowId,
      reviewId: review().id,
      message: 'fix: managed child change',
    })
    expect(committed.headCommit).not.toBe(receipt.headCommit)
    await manager.completeWorkflow(receipt.sourceId, workflowId)
    expect((await manager.readReceipt(receipt.sourceId))?.activeWorkflowId).toBeNull()
  })

  it('still rejects symlink source roots under a symlink-aliased sourceDir', async () => {
    const root = await tempRoot('autoevo-source-alias-escape-', temporary)
    const realSources = path.join(root, 'real-sources')
    await mkdir(realSources, { recursive: true })
    const aliasSources = path.join(root, 'alias-sources')
    await symlink(realSources, aliasSources, process.platform === 'win32' ? 'junction' : 'dir')
    const manager = new SourceManager(config(root, aliasSources), scriptedGit({ head: 'c'.repeat(40), branch: 'main' }))
    const outside = path.join(root, 'outside')
    await mkdir(outside, { recursive: true })
    await symlink(outside, manager.sourcePath('linked'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(manager.assertPathContainment('linked')).rejects.toThrow(/symlink|escaped/i)
  })

  it('relocates into a symlink-aliased workspace when a receipt points elsewhere', async () => {
    const root = await tempRoot('autoevo-source-alias-reloc-', temporary)
    const realWorkspace = path.join(root, 'real-workspace')
    await mkdir(realWorkspace, { recursive: true })
    const aliasWorkspace = path.join(root, 'alias-workspace')
    await symlink(realWorkspace, aliasWorkspace, process.platform === 'win32' ? 'junction' : 'dir')
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
      workspaceCwd: aliasWorkspace,
    })
    expect(receipt.path).toBe(await realpath(manager.sourcePath(sourceId, aliasWorkspace)))
    expect(await manager.pathUnderSourceRoot(receipt.path, aliasWorkspace)).toBe(true)
    expect(await manager.pathUnderSourceRoot(stalePath, aliasWorkspace)).toBe(false)
  })
})
