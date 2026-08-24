import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { testRuntimeConfig } from '../helpers/runtime-config.js'
import { tempRoot, trackTempDirs } from '../helpers/temp-dirs.js'
import type { RuntimeConfig } from '../../src/config.js'
import type { CommandRunner } from '../../src/process/runner.js'
import { SourceManager, sourceIdForCreate } from '../../src/source-manager.js'

const temporary = trackTempDirs()

function config(root: string): RuntimeConfig {
  return testRuntimeConfig(root)
}

function scriptedGit(): { runner: CommandRunner; markDirty(): void } {
  const state = { head: '0'.repeat(40), branch: 'main', commits: 0, dirty: true }
  return {
    markDirty() { state.dirty = true },
    runner: {
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
        if (joined.startsWith('checkout -B')) {
          state.branch = args[2]!
          return { exitCode: 0, signal: null, stdout: '', stderr: '' }
        }
        if (joined === 'status --porcelain') return { exitCode: 0, signal: null, stdout: state.dirty ? '?? managed-change\n' : '', stderr: '' }
        if (joined === 'rev-parse HEAD') return { exitCode: 0, signal: null, stdout: `${state.head}\n`, stderr: '' }
        if (joined === 'rev-parse --abbrev-ref HEAD') return { exitCode: 0, signal: null, stdout: `${state.branch}\n`, stderr: '' }
        if (joined === 'add -A') return { exitCode: 0, signal: null, stdout: '', stderr: '' }
        if (joined.startsWith('diff-tree --no-commit-id --name-only -r -z')) {
          return { exitCode: 0, signal: null, stdout: 'managed-change\0', stderr: '' }
        }
        if (args.includes('commit')) {
          state.commits += 1
          state.head = `${state.commits}`.repeat(40)
          state.dirty = false
          return { exitCode: 0, signal: null, stdout: '', stderr: '' }
        }
        return { exitCode: 1, signal: null, stdout: '', stderr: `unexpected ${joined}` }
      },
    },
  }
}

describe('managed Git creation sources', () => {
  it('writes a trusted scaffold commit and Host-only sidecar provenance', async () => {
    const root = await tempRoot('autoevo-create-scaffold-', temporary)
    const git = scriptedGit()
    const manager = new SourceManager(config(root), git.runner)
    const workspace = path.join(root, 'project')
    const resolutionId = `resolution_${'c'.repeat(24)}`
    const workflowId = `workflow_${'d'.repeat(24)}`
    const receipt = await manager.initializeCreateSource({
      resolutionId,
      workflowId,
      packageName: 'dsh-plugin-demo',
      workspaceCwd: workspace,
    })
    expect(receipt).toMatchObject({
      sourceId: sourceIdForCreate(resolutionId),
      repository: null,
      branch: `autoevo/${workflowId}`,
      activeWorkflowId: workflowId,
    })
    expect(receipt.path.startsWith(path.resolve(workspace, '.autoevo', 'sources'))).toBe(true)
    expect(receipt.baseCommit).toBe(receipt.headCommit)
    expect(path.dirname(manager.receiptPath(receipt.sourceId))).not.toBe(receipt.path)
    const pkg = await readFile(path.join(receipt.path, 'package.json'), 'utf8')
    expect(pkg).toContain('"name": "dsh-plugin-demo"')
    expect(pkg).toContain('"patch": "./cordis.patch.yml"')
  })

  it('requires a child worktree change, creates a second unsigned Host commit, and records artifact sha256', async () => {
    const root = await tempRoot('autoevo-create-final-', temporary)
    const git = scriptedGit()
    const manager = new SourceManager(config(root), git.runner)
    const workspace = path.join(root, 'project')
    const resolutionId = `resolution_${'e'.repeat(24)}`
    const workflowId = `workflow_${'f'.repeat(24)}`
    const receipt = await manager.initializeCreateSource({
      resolutionId,
      workflowId,
      workspaceCwd: workspace,
    })
    await expect(manager.finalizeChildCommit({
      sourceId: receipt.sourceId,
      workflowId,
      reviewId: `review_${'a'.repeat(64)}`,
      message: 'feat: child result',
    })).rejects.toThrow(/without changing/i)

    await writeFile(path.join(receipt.path, 'lib', 'index.js'), 'export const implemented = true\n', 'utf8')
    git.markDirty()
    const committed = await manager.finalizeChildCommit({
      sourceId: receipt.sourceId,
      workflowId,
      reviewId: `review_${'a'.repeat(64)}`,
      message: 'feat: child result',
    })
    expect(committed.headCommit).not.toBe(receipt.headCommit)
    expect(committed).toMatchObject({ changedFiles: ['managed-change'], changedFilesTruncated: false })
    const frozen = await manager.recordReviewedArtifact({
      sourceId: receipt.sourceId,
      workflowId,
      reviewId: `review_${'b'.repeat(64)}`,
      artifactHash: 'c'.repeat(64),
    })
    expect(frozen).toMatchObject({ reviewId: `review_${'b'.repeat(64)}`, artifactHash: 'c'.repeat(64) })
  })
})
