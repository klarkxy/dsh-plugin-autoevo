import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import path from 'node:path'
import { create as createTar } from 'tar'
import { describe, expect, it } from 'vitest'
import { testRuntimeConfig } from '../helpers/runtime-config.js'
import { tempRoot, trackTempDirs } from '../helpers/temp-dirs.js'
import type { CommandRunner } from '../../src/process/runner.js'
import { _testing, freezeGithubPackage, freezeLocalPackage } from '../../src/lifecycle/package-artifact.js'

const temporary = trackTempDirs()

function localRunner(): CommandRunner {
  return {
    async run(request) {
      const [command, ...args] = request.argv
      return await new Promise((resolve, reject) => {
        const child = spawn(command, args, {
          cwd: request.cwd,
          env: { ...process.env, ...request.env },
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
        child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
        child.once('error', reject)
        child.once('close', (exitCode, signal) => resolve({ exitCode, signal, stdout, stderr }))
      })
    },
  }
}

async function source(root: string, name: string, files: Record<string, string | Buffer>, packageJson: Record<string, unknown>): Promise<string> {
  const directory = path.join(root, name)
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...packageJson }))
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(directory, ...relative.split('/'))
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, content)
  }
  return directory
}

function tarHeader(name: string, type: string, linkpath = ''): Buffer {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write('0000644\0', 100, 8, 'ascii')
  header.write('0000000\0', 108, 8, 'ascii')
  header.write('0000000\0', 116, 8, 'ascii')
  header.write('00000000000\0', 124, 12, 'ascii')
  header.write('00000000000\0', 136, 12, 'ascii')
  header.fill(0x20, 148, 156)
  header.write(type, 156, 1, 'ascii')
  header.write(linkpath, 157, 100, 'utf8')
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  const checksum = header.reduce((total, value) => total + value, 0)
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return header
}

describe('frozen npm package artifacts', () => {
  it('uses npm publication semantics for literal files, globs, and no-files packages', async () => {
    const root = await tempRoot('autoevo-package-artifact-', temporary)
    const runner = localRunner()
    const literal = await source(root, 'literal-package', {
      'lib/index.js': 'literal',
      'private.txt': 'must not publish',
    }, { files: ['lib'] })
    const glob = await source(root, 'glob-package', {
      'lib/index.js': 'globbed',
      'lib/skip.txt': 'not globbed',
    }, { files: ['lib/**/*.js'] })
    const noFiles = await source(root, 'no-files-package', {
      'included.js': 'published by default',
      '.npmignore': 'ignored.js\n',
      'ignored.js': 'not published',
    }, {})

    const literalArtifact = await freezeLocalPackage({ sourceRoot: literal, artifactRoot: path.join(root, 'literal-artifact'), config: testRuntimeConfig(root), runner })
    const globArtifact = await freezeLocalPackage({ sourceRoot: glob, artifactRoot: path.join(root, 'glob-artifact'), config: testRuntimeConfig(root), runner })
    const noFilesArtifact = await freezeLocalPackage({ sourceRoot: noFiles, artifactRoot: path.join(root, 'no-files-artifact'), config: testRuntimeConfig(root), runner })

    expect(literalArtifact.files.map((file) => file.path)).toContain('lib/index.js')
    expect(literalArtifact.files.map((file) => file.path)).not.toContain('private.txt')
    expect(globArtifact.files.map((file) => file.path)).toContain('lib/index.js')
    expect(globArtifact.files.map((file) => file.path)).not.toContain('lib/skip.txt')
    expect(noFilesArtifact.files.map((file) => file.path)).toContain('included.js')
    expect(noFilesArtifact.files.map((file) => file.path)).not.toContain('ignored.js')
  }, 60_000)

  it('retains complete file content beyond the review snapshot limit and never runs lifecycle scripts', async () => {
    const root = await tempRoot('autoevo-package-artifact-content-', temporary)
    const sourceRoot = await source(root, 'large-package', {
      'payload.bin': Buffer.alloc(2_097_153, 0x61),
    }, {
      scripts: { prepack: 'node -e "require(\'node:fs\').writeFileSync(\'script-ran\', \'yes\')"' },
    })
    const artifact = await freezeLocalPackage({ sourceRoot, artifactRoot: path.join(root, 'artifact'), config: testRuntimeConfig(root), runner: localRunner() })
    const payload = artifact.files.find((file) => file.path === 'payload.bin')

    expect(payload?.content.byteLength).toBe(2_097_153)
    expect(Buffer.from(payload?.content ?? []).every((value) => value === 0x61)).toBe(true)
    await expect(readFile(path.join(sourceRoot, 'script-ran'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(path.join(artifact.artifactRoot, 'npm-cache'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(path.join(artifact.artifactRoot, 'npm-temp'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await stat(artifact.installSpec.slice('file:'.length))).mode & 0o222).toBe(0)
  }, 20_000)

  it('rejects symlink entries instead of treating them as ordinary files', async () => {
    const root = await tempRoot('autoevo-package-artifact-link-', temporary)
    const sourceRoot = await source(root, 'link-package', {}, {})
    const runner: CommandRunner = {
      async run(request) {
        const destination = request.argv.at(-1)!
        const archive = Buffer.concat([tarHeader('package/linked.txt', '2', 'target.txt'), Buffer.alloc(1024)])
        await writeFile(path.join(destination, 'link-package-1.0.0.tgz'), gzipSync(archive))
        return { exitCode: 0, signal: null, stdout: '', stderr: '' }
      },
    }

    const artifactRoot = path.join(root, 'artifact')
    await expect(freezeLocalPackage({ sourceRoot, artifactRoot, config: testRuntimeConfig(root), runner }))
      .rejects.toThrow(/link or special file/u)
    await expect(stat(path.join(artifactRoot, 'package'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('removes the owned package directory when the packed archive is malformed', async () => {
    const root = await tempRoot('autoevo-package-artifact-malformed-', temporary)
    const sourceRoot = await source(root, 'malformed-package', {}, {})
    const artifactRoot = path.join(root, 'artifact')
    const runner: CommandRunner = {
      async run(request) {
        await writeFile(path.join(request.argv.at(-1)!, 'malformed-package-1.0.0.tgz'), 'not a gzip archive')
        return { exitCode: 0, signal: null, stdout: '', stderr: '' }
      },
    }

    await expect(freezeLocalPackage({ sourceRoot, artifactRoot, config: testRuntimeConfig(root), runner }))
      .rejects.toThrow()
    await expect(stat(path.join(artifactRoot, 'package'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('removes a partial package directory when the pack runner returns success after aborting', async () => {
    const root = await tempRoot('autoevo-package-artifact-pack-cancel-', temporary)
    const sourceRoot = await source(root, 'cancelled-package', {}, {})
    const artifactRoot = path.join(root, 'artifact')
    const controller = new AbortController()
    const reason = new Error('cancel npm pack')
    const runner: CommandRunner = {
      async run(request) {
        const destination = request.argv.at(-1)!
        await writeFile(path.join(destination, 'partial.tgz'), 'partial')
        controller.abort(reason)
        return { exitCode: 0, signal: null, stdout: '', stderr: '' }
      },
    }

    let failure: unknown
    try {
      await freezeLocalPackage({
        sourceRoot,
        artifactRoot,
        config: testRuntimeConfig(root),
        runner,
        signal: controller.signal,
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toBe(reason)
    await expect(stat(path.join(artifactRoot, 'package'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(path.join(artifactRoot, 'npm-cache'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(path.join(artifactRoot, 'npm-temp'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not let temporary-directory cleanup failures replace the exact pack error', async () => {
    const operationError = new Error('exact pack failure')
    const cleanupError = new Error('cleanup failure')
    let cleanupCalls = 0
    let failure: unknown
    try {
      await _testing.runWithBestEffortCleanup(
        async () => { throw operationError },
        [
          async () => { cleanupCalls += 1; throw cleanupError },
          async () => { cleanupCalls += 1 },
        ],
      )
    } catch (error) {
      failure = error
    }
    expect(failure).toBe(operationError)
    expect(cleanupCalls).toBe(2)

    await expect(_testing.runWithBestEffortCleanup(
      async () => 'packed',
      [async () => { throw cleanupError }],
    )).rejects.toBe(cleanupError)
  })

  it('does not create a package directory when already cancelled', async () => {
    const root = await tempRoot('autoevo-package-artifact-pre-cancel-', temporary)
    const sourceRoot = await source(root, 'pre-cancelled-package', {}, {})
    const artifactRoot = path.join(root, 'artifact')
    const controller = new AbortController()
    const reason = new Error('cancel before artifact creation')
    controller.abort(reason)
    let calls = 0
    const runner: CommandRunner = {
      async run() {
        calls += 1
        throw new Error('pack must not start')
      },
    }

    let failure: unknown
    try {
      await freezeLocalPackage({
        sourceRoot,
        artifactRoot,
        config: testRuntimeConfig(root),
        runner,
        signal: controller.signal,
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toBe(reason)
    expect(calls).toBe(0)
    await expect(stat(path.join(artifactRoot, 'package'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('accepts safe long paths carried by tar metadata and reviews their final path', async () => {
    const root = await tempRoot('autoevo-package-artifact-pax-', temporary)
    const staging = path.join(root, 'staging')
    const longName = `${'nested-'.repeat(18)}file.js`
    await mkdir(path.join(staging, 'package'), { recursive: true })
    await writeFile(path.join(staging, 'package', longName), 'export default true\n')
    const tarball = path.join(root, 'long-path.tgz')
    await createTar({ cwd: staging, file: tarball, gzip: true }, ['package'])

    const files = await _testing.readPackedFiles(tarball)
    expect(files.map((file) => file.path)).toContain(longName)
  })

  it('fails explicitly when current Host review capacity is exhausted', async () => {
    const root = await tempRoot('autoevo-package-artifact-capacity-', temporary)
    const staging = path.join(root, 'staging')
    await mkdir(path.join(staging, 'package'), { recursive: true })
    await writeFile(path.join(staging, 'package', 'payload.bin'), Buffer.alloc(1024, 1))
    const tarball = path.join(root, 'capacity.tgz')
    await createTar({ cwd: staging, file: tarball, gzip: true }, ['package'])

    await expect(_testing.readPackedFiles(tarball, { unpackedBudget: 128, entryBudget: 10 }))
      .rejects.toMatchObject({ code: 'command_failed' })
  })

  it('reuses the exact cached commit and packs only the selected repository subpackage', async () => {
    const root = await tempRoot('autoevo-package-artifact-github-', temporary)
    const commit = 'a'.repeat(40)
    const requests: string[][] = []
    const gitEnvironments: Array<NodeJS.ProcessEnv | undefined> = []
    const packCwds: string[] = []
    const staging = path.join(root, 'staging')
    await mkdir(path.join(staging, 'package'), { recursive: true })
    await writeFile(path.join(staging, 'package', 'package.json'), '{"name":"github-package"}')
    let commitPresent = false
    const runner: CommandRunner = {
      async run(request) {
        requests.push([...request.argv])
        if (request.argv[0] === 'git') gitEnvironments.push(request.env)
        const args = request.argv.slice(1)
        if (args.includes('init') && args.includes('--bare')) await mkdir(request.argv.at(-1)!, { recursive: true })
        if (args.includes('rev-parse') && args.includes('--is-bare-repository')) return { exitCode: 0, signal: null, stdout: 'true\n', stderr: '' }
        if (args.includes('get-url')) return { exitCode: 1, signal: null, stdout: '', stderr: 'missing' }
        if (args.includes('cat-file')) {
          if (!commitPresent) return { exitCode: 1, signal: null, stdout: '', stderr: 'missing' }
          return { exitCode: 0, signal: null, stdout: '', stderr: '' }
        }
        if (args.includes('fetch')) commitPresent = true
        if (args.includes('worktree') && args.includes('add')) await mkdir(path.join(request.argv.at(-2)!, 'packages', 'whale'), { recursive: true })
        if (args.includes('rev-parse') && args.includes('HEAD')) return { exitCode: 0, signal: null, stdout: `${commit}\n`, stderr: '' }
        if (args.includes('status') && args.includes('--porcelain')) return { exitCode: 0, signal: null, stdout: '', stderr: '' }
        if (args.includes('pack')) {
          packCwds.push(request.cwd)
          await createTar({ cwd: staging, file: path.join(request.argv.at(-1)!, 'github-package-1.0.0.tgz'), gzip: true }, ['package'])
        }
        return { exitCode: 0, signal: null, stdout: '', stderr: '' }
      },
    }

    const cacheRoot = path.join(root, '.autoevo', 'cache', 'git')
    const artifact = await freezeGithubPackage({
      repository: 'acme/package', commit, packagePath: 'packages/whale', cacheRoot,
      artifactRoot: path.join(root, 'artifact'), config: testRuntimeConfig(root), runner,
    })
    await freezeGithubPackage({
      repository: 'acme/package', commit, packagePath: 'packages/whale', cacheRoot,
      artifactRoot: path.join(root, 'artifact-second'), config: testRuntimeConfig(root), runner,
    })
    expect(requests.some((argv) => argv.includes('--bare'))).toBe(true)
    expect(requests.some((argv) => argv.includes('--filter=blob:none') && argv.includes(commit))).toBe(true)
    expect(requests.some((argv) => argv.includes('worktree') && argv.includes('--no-checkout'))).toBe(true)
    expect(requests.some((argv) => argv.includes('sparse-checkout') && argv.includes('packages/whale'))).toBe(true)
    expect(requests.some((argv) => argv.includes('checkout') && argv.includes(commit))).toBe(true)
    expect(requests.filter((argv) => argv.includes('fetch'))).toHaveLength(1)
    const packRequests = requests.filter((argv) => argv.includes('pack'))
    expect(packRequests).toHaveLength(2)
    expect(packCwds.every((cwd) => cwd.endsWith(path.join('packages', 'whale')))).toBe(true)
    expect(gitEnvironments.filter((env) => env?.GIT_CONFIG_GLOBAL).length).toBeGreaterThan(0)
    expect(gitEnvironments.filter((env) => env?.GIT_CONFIG_GLOBAL).every((env) => (
      env?.GIT_CONFIG_COUNT === '0' && env.GIT_CONFIG_SYSTEM && env.GIT_ATTR_NOSYSTEM === '1'
    ))).toBe(true)
    expect(artifact.files.map((file) => file.path)).toEqual(['package.json'])
    await expect(stat(path.join(artifact.artifactRoot, 'source'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
