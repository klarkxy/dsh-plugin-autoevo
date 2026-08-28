import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { testRuntimeConfig } from '../helpers/runtime-config.js'
import { trackTempDirs } from '../helpers/temp-dirs.js'
import type { RuntimeConfig } from '../../src/config.js'
import type { ReviewRecord } from '../../src/contracts.js'
import { materializeLocalPackage } from '../../src/lifecycle/snapshot.js'
import type { CommandRunner } from '../../src/process/runner.js'
import { inspectLocalDirectory } from '../../src/review/review.js'
import { sha256 } from '../../src/state/hashes.js'

const temporary = trackTempDirs()

function config(root: string): RuntimeConfig {
  return testRuntimeConfig(root, { evolutionPreset: true })
}

describe('immutable local package materialization', () => {
  it('reviews the complete bounded source set while excluding only Host-owned roots', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'capability-evolution-review-bounds-'))
    temporary.push(root)
    const source = path.join(root, 'source-plugin')
    await mkdir(path.join(source, 'src'), { recursive: true })
    await mkdir(path.join(source, '.pnpm-store'), { recursive: true })
    await writeFile(path.join(source, 'package.json'), '{"name":"bounded-source"}\n')
    for (let index = 0; index < 108; index += 1) {
      await writeFile(path.join(source, 'src', `${String(index).padStart(3, '0')}.ts`), 'x'.repeat(10_000))
    }
    await writeFile(path.join(source, '.pnpm-store', 'cache.bin'), 'z'.repeat(2_097_153))

    const snapshot = await inspectLocalDirectory(source, config(root))
    const inspectedBytes = snapshot.files.reduce((total, file) => total + file.content.byteLength, 0)
    expect(snapshot.files).toHaveLength(109)
    expect(snapshot.files.some((file) => file.path.startsWith('.pnpm-store/'))).toBe(false)
    expect(inspectedBytes).toBeGreaterThan(1_048_576)
    expect(inspectedBytes).toBeLessThanOrEqual(2_097_152)
    expect(snapshot.truncated).toBe(false)

    const overLimit = path.join(root, 'over-limit')
    await mkdir(overLimit)
    await writeFile(path.join(overLimit, 'package.json'), '{}')
    await writeFile(path.join(overLimit, 'payload.bin'), 'y'.repeat(2_097_152))
    expect((await inspectLocalDirectory(overLimit, config(root))).truncated).toBe(true)
  })

  it('does not trust arbitrary ignored-looking directories as Host-owned exclusions', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'capability-evolution-review-ignored-'))
    temporary.push(root)
    const source = path.join(root, 'source-plugin')
    await mkdir(path.join(source, '.custom-cache'), { recursive: true })
    await writeFile(path.join(source, 'package.json'), '{}')
    await writeFile(path.join(source, '.custom-cache', 'still-reviewed.txt'), 'review me')
    const snapshot = await inspectLocalDirectory(source, config(root))
    expect(snapshot.files.map((file) => file.path)).toContain('.custom-cache/still-reviewed.txt')
  })

  it('binds the complete reviewed file set and installs from an owned tarball, never the workspace link', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'capability-evolution-snapshot-'))
    temporary.push(root)
    const source = path.join(root, 'source-plugin')
    const artifactRoot = path.join(root, 'artifacts', 'installation_aaaaaaaaaaaaaaaaaaaaaaaa')
    await mkdir(source, { recursive: true })
    await writeFile(path.join(source, 'package.json'), JSON.stringify({
      name: 'local-tool',
      version: '1.0.0',
      dsh: { bundle: { patch: './cordis.patch.yml', tools: ['local-tool'] } },
    }))
    await writeFile(path.join(source, 'cordis.patch.yml'), '- insert: []\n')
    await writeFile(path.join(source, 'runtime.wasm'), Buffer.from([0, 97, 115, 109, 1]))
    await mkdir(path.join(source, '.pnpm-store'), { recursive: true })
    await writeFile(path.join(source, '.pnpm-store', 'cache.bin'), 'not package input')
    const runtimeConfig = config(root)
    const snapshot = await inspectLocalDirectory(source, runtimeConfig)
    expect(snapshot.truncated).toBe(false)
    const review: ReviewRecord = {
      schemaVersion: 1,
      id: `review_${'a'.repeat(64)}`,
      policyVersion: 'v2-2026-08-15',
      createdAt: '2026-08-15T00:00:00.000Z',
      resolutionId: `resolution_${'b'.repeat(24)}`,
      requirement: 'local tool',
      sourceSnapshot: { kind: 'local', path: source, baseReviewId: `review_${'c'.repeat(64)}`, baseCommit: 'd'.repeat(40), statusHash: 'e'.repeat(64) },
      inspectedFiles: snapshot.files.map((file) => ({ path: file.path, sha256: sha256(file.content), bytes: file.content.byteLength })),
      manifest: { kind: 'bundle', packageName: 'local-tool', bundlePatch: './cordis.patch.yml', scripts: [], dependencies: [], peerDependencies: {}, expectedTools: ['local-tool'] },
      fit: 'full',
      confidence: 0.8,
      securityRisk: 'low',
      maintained: true,
      license: 'MIT',
      compatibility: { status: 'compatible', reason: 'test', runtimeVersion: '0.1.0-rc.6' },
      missingCapabilities: [],
      findings: [],
      recommendation: 'use',
      installSpec: null,
    }
    const requests: string[][] = []
    const runner: CommandRunner = {
      async run(request) {
        requests.push([...request.argv])
        await expect(readFile(path.join(request.cwd, '.pnpm-store', 'cache.bin'))).rejects.toThrow()
        const destination = request.argv.at(-1)!
        await writeFile(path.join(destination, 'local-tool-1.0.0.tgz'), Buffer.from('immutable package bytes'))
        return { exitCode: 0, signal: null, stdout: '', stderr: '' }
      },
    }

    const result = await materializeLocalPackage({ review, artifactRoot, config: runtimeConfig, runner })
    expect(requests[0]?.slice(-4)).toEqual(['pack', '--ignore-scripts', '--pack-destination', path.join(artifactRoot, 'package')])
    expect(result.installSpec).toMatch(/^file:/u)
    expect(result.installSpec).not.toContain(source.replaceAll('\\', '/'))
    const before = result.artifactSha256
    await writeFile(path.join(source, 'runtime.wasm'), Buffer.from([0, 97, 115, 109, 2]))
    expect(sha256(await readFile(result.installSpec.slice('file:'.length)))).toBe(before)
  })
})
