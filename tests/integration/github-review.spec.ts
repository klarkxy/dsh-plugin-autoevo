import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RuntimeConfig } from '../../src/config.js'
import type { CommandRunner } from '../../src/process/runner.js'
import { reviewLocalPlugin } from '../../src/review/review.js'

const config: RuntimeConfig = {
  dshHome: 'C:/dsh', stateDir: 'C:/dsh/state', ghCommand: 'gh', gitCommand: 'git', dshCommand: 'dsh', dshCommandArgs: [],
  maxCandidates: 5, maxFiles: 10, maxRepositoryBytes: 100_000, commandTimeoutMs: 1_000, forwardedCredentialEnv: [], verificationPatchPaths: [], evolutionPreset: true,
  communityQualityFilter: false, communityReports: false, communityQualityEndpoint: '', communityQualityTimeoutMs: 2_000,
}

describe('local review binding', () => {
  it('accepts only a workspace-contained Git root and binds commit, status, and content hash', async () => {
    const workspace = await mkdtemp(path.join(process.cwd(), 'tests', '.review-workspace-'))
    const plugin = path.join(workspace, 'plugin')
    await mkdir(path.join(plugin, 'src'), { recursive: true })
    await writeFile(path.join(plugin, 'package.json'), JSON.stringify({ name: 'local-tool', dsh: { bundle: { patch: './cordis.patch.yml', tools: ['local-tool'] } }, peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.1.0-rc.6 <0.2.0' } }))
    await writeFile(path.join(plugin, 'cordis.patch.yml'), '- insert:\n    - id: local-tool\n      name: local-tool\n')
    await writeFile(path.join(plugin, 'src', 'index.ts'), "defineTool('local-tool')")
    await writeFile(path.join(plugin, 'native.wasm'), Buffer.from([0, 97, 115, 109, 1]))
    const runner: CommandRunner = {
      async run(request) {
        const args = request.argv.slice(1)
        const stdout = args.includes('--show-toplevel') ? plugin
          : args.includes('HEAD') ? 'b'.repeat(40)
            : ''
        return { exitCode: 0, signal: null, stdout, stderr: '' }
      },
    }
    try {
      const result = await reviewLocalPlugin({
        runner, config, workspaceRoot: workspace, path: plugin, baseReviewId: 'review_0123456789abcdef',
        resolutionId: 'resolution_0123456789abcdef', requirement: 'local tool',
        runtimeVersion: '0.1.0-rc.6',
      })
      expect(result.record.sourceSnapshot).toEqual({ kind: 'local', path: plugin, baseReviewId: 'review_0123456789abcdef', baseCommit: 'b'.repeat(40), statusHash: expect.any(String) })
      expect(result.record.installSpec).toBeNull()
      expect(result.record.inspectedFiles.map((file) => file.path)).toContain('native.wasm')
      expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/)
      await writeFile(path.join(plugin, 'native.wasm'), Buffer.from([0, 97, 115, 109, 2]))
      const changed = await reviewLocalPlugin({
        runner, config, workspaceRoot: workspace, path: plugin, baseReviewId: 'review_0123456789abcdef',
        resolutionId: 'resolution_0123456789abcdef', requirement: 'local tool',
        runtimeVersion: '0.1.0-rc.6',
      })
      expect(changed.contentHash).not.toBe(result.contentHash)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('marks a local package containing a symbolic link as truncated and non-installable', async () => {
    const workspace = await mkdtemp(path.join(process.cwd(), 'tests', '.review-workspace-'))
    const plugin = path.join(workspace, 'plugin')
    const linked = path.join(workspace, 'linked-content')
    await mkdir(plugin, { recursive: true })
    await mkdir(linked, { recursive: true })
    await writeFile(path.join(plugin, 'package.json'), JSON.stringify({
      name: 'local-tool',
      dsh: { bundle: { patch: './cordis.patch.yml', tools: ['local-tool'] } },
      peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.1.0-rc.6 <0.2.0' },
    }))
    await writeFile(path.join(plugin, 'cordis.patch.yml'), '- insert:\n    - id: local-tool\n      name: local-tool\n')
    await writeFile(path.join(linked, 'runtime.js'), 'export const value = 1')
    await symlink(linked, path.join(plugin, 'linked-runtime'), 'junction')
    const runner: CommandRunner = {
      async run(request) {
        const args = request.argv.slice(1)
        const stdout = args.includes('--show-toplevel') ? plugin
          : args.includes('HEAD') ? 'b'.repeat(40)
            : ''
        return { exitCode: 0, signal: null, stdout, stderr: '' }
      },
    }
    try {
      const result = await reviewLocalPlugin({
        runner, config, workspaceRoot: workspace, path: plugin, baseReviewId: 'review_0123456789abcdef',
        resolutionId: 'resolution_0123456789abcdef', requirement: 'local tool',
        runtimeVersion: '0.1.0-rc.6',
      })
      expect(result.record.recommendation).toBe('skip')
      expect(result.record.installSpec).toBeNull()
      expect(result.record.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'review_truncated' }),
      ]))
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('accepts a descendant HEAD of the lineage root and rejects an unrelated commit', async () => {
    const workspace = await mkdtemp(path.join(process.cwd(), 'tests', '.review-workspace-'))
    const plugin = path.join(workspace, 'plugin')
    await mkdir(plugin, { recursive: true })
    await writeFile(path.join(plugin, 'package.json'), JSON.stringify({
      name: 'local-tool',
      dsh: { bundle: { patch: './cordis.patch.yml', tools: ['local-tool'] } },
      peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.1.0-rc.6 <0.2.0' },
    }))
    await writeFile(path.join(plugin, 'cordis.patch.yml'), '- insert:\n    - id: local-tool\n      name: local-tool\n')
    const root = 'b'.repeat(40)
    const descendant = 'c'.repeat(40)
    const unrelated = 'd'.repeat(40)
    const runnerFor = (head: string, ancestor: boolean): CommandRunner => ({
      async run(request) {
        const args = request.argv.slice(1)
        if (args.includes('--show-toplevel')) return { exitCode: 0, signal: null, stdout: plugin, stderr: '' }
        if (args.includes('--is-ancestor')) {
          return { exitCode: ancestor ? 0 : 1, signal: null, stdout: '', stderr: '' }
        }
        if (args.includes('HEAD')) return { exitCode: 0, signal: null, stdout: head, stderr: '' }
        return { exitCode: 0, signal: null, stdout: '', stderr: '' }
      },
    })
    try {
      const accepted = await reviewLocalPlugin({
        runner: runnerFor(descendant, true),
        config,
        workspaceRoot: workspace,
        path: plugin,
        baseReviewId: 'review_0123456789abcdef',
        lineageRootCommit: root,
        resolutionId: 'resolution_0123456789abcdef',
        requirement: 'local tool',
        runtimeVersion: '0.1.0-rc.6',
      })
      expect(accepted.record.sourceSnapshot).toMatchObject({
        kind: 'local',
        baseReviewId: 'review_0123456789abcdef',
        baseCommit: root,
      })
      await expect(reviewLocalPlugin({
        runner: runnerFor(unrelated, false),
        config,
        workspaceRoot: workspace,
        path: plugin,
        baseReviewId: 'review_0123456789abcdef',
        lineageRootCommit: root,
        resolutionId: 'resolution_0123456789abcdef',
        requirement: 'local tool',
        runtimeVersion: '0.1.0-rc.6',
      })).rejects.toThrow(/descendant/i)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
