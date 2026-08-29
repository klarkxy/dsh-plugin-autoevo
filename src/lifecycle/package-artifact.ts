import { createHash } from 'node:crypto'
import { chmod, mkdir, readdir, realpath, rm } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { once } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import { getHeapStatistics } from 'node:v8'
import { Parser } from 'tar'
import type { RuntimeConfig } from '../config.js'
import { EvolutionError } from '../errors.js'
import { validateGithubRepository } from '../github/discovery.js'
import type { CommandRunner } from '../process/runner.js'
import type { ContentFile } from '../review/review.js'
import { npmPackArgv, shellForwardedFileSpec } from './npm-cli.js'

export interface FrozenPackageArtifact {
  installSpec: string
  artifactRoot: string
  artifactSha256: string
  artifactBytes: number
  files: ContentFile[]
}

interface FreezeOptions {
  artifactRoot: string
  config: RuntimeConfig
  runner: CommandRunner
  signal?: AbortSignal
}

function safeArchivePath(value: string): string | undefined {
  if (!value.startsWith('package/') || value.includes('\\') || value.includes('\0')
    || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new EvolutionError('unsafe_path', 'Packed archive contains an unsafe entry path')
  }
  const relative = value.slice('package/'.length).replace(/\/+$/u, '')
  // npm's archives normally begin with the package/ directory entry.
  if (!relative) return undefined
  if (relative.includes(':') || relative.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new EvolutionError('unsafe_path', 'Packed archive contains an unsafe entry path')
  }
  return relative
}

async function runChecked(runner: CommandRunner, argv: [string, ...string[]], cwd: string, options: Pick<FreezeOptions, 'config' | 'signal'> & { env?: NodeJS.ProcessEnv }): Promise<string> {
  const result = await runner.run({
    argv,
    cwd,
    ...(options.env ? { env: options.env } : {}),
    timeoutMs: Math.max(options.config.commandTimeoutMs, 120_000),
    ...(options.signal ? { signal: options.signal } : {}),
  })
  if (result.exitCode !== 0) throw new EvolutionError('command_failed', `${argv[0]} exited with code ${result.exitCode ?? 'null'}`)
  return result.stdout
}

interface ReviewCapacity {
  unpackedBudget: number
  entryBudget: number
}

function hostReviewCapacity(): ReviewCapacity {
  // This is a live process-capacity guard, not package eligibility policy.
  // Formal review has no configured file/byte cutoff; exhausting available
  // review capacity fails explicitly so the workflow remains retryable.
  const unpackedBudget = Math.max(
    64 * 1024 * 1024,
    Math.floor(Math.min(os.freemem(), getHeapStatistics().heap_size_limit) / 8),
  )
  return { unpackedBudget, entryBudget: Math.max(10_000, Math.floor(unpackedBudget / 8_192)) }
}

/** Stream a packed npm artifact without extracting it onto the filesystem. */
async function readPackedFiles(tarball: string, capacity: ReviewCapacity = hostReviewCapacity()): Promise<ContentFile[]> {
  const files: ContentFile[] = []
  const seen = new Set<string>()
  let declaredBytes = 0
  let entryCount = 0
  const parser = new Parser({ strict: true, gzip: true })
  let failure: Error | undefined
  const fail = (error: Error): void => {
    if (failure) return
    failure = error
  }

  parser.on('error', (error: Error) => {
    if (!failure) failure = error
  })
  parser.on('entry', (entry) => {
    try {
      if (entry.invalid || entry.unsupported || entry.absolute || (entry.type !== 'File' && entry.type !== 'OldFile' && entry.type !== 'Directory')) {
        throw new EvolutionError('unsafe_path', 'Packed archive contains a link or special file')
      }
      // Header path protects the literal archive spelling; ReadEntry.path is
      // the final path after bounded PAX/GNU metadata has been applied.
      if (typeof entry.header.path !== 'string') throw new EvolutionError('unsafe_path', 'Packed archive contains an unsafe entry path')
      safeArchivePath(entry.header.path)
      const relative = safeArchivePath(entry.path)
      if (relative === undefined) {
        if (entry.type !== 'Directory') throw new EvolutionError('unsafe_path', 'Packed archive contains an unsafe entry path')
        entry.resume()
        return
      }
      entryCount += 1
      if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
        throw new EvolutionError('unsafe_path', 'Packed archive contains an invalid entry size')
      }
      declaredBytes += entry.size
      if (!Number.isSafeInteger(declaredBytes) || entryCount > capacity.entryBudget || declaredBytes > capacity.unpackedBudget) {
        throw new EvolutionError('command_failed', 'Packed archive exhausted the current Host review capacity', {
          entryCount,
          entryBudget: capacity.entryBudget,
          declaredBytes,
          unpackedBudget: capacity.unpackedBudget,
        })
      }
      if (seen.has(relative)) throw new EvolutionError('unsafe_path', 'Packed archive contains a duplicate entry path')
      seen.add(relative)
      if (entry.type === 'Directory') {
        entry.resume()
        return
      }
      const chunks: Buffer[] = []
      entry.on('data', (chunk: Buffer) => chunks.push(chunk))
      entry.on('end', () => files.push({ path: relative, content: Buffer.concat(chunks) }))
      entry.resume()
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)))
      entry.resume()
    }
  })

  const complete = once(parser, 'end')
  // `once()` rejects if Parser emits error before `end`; consume that rejection
  // immediately so a malformed archive cannot become an unhandled rejection.
  void complete.catch(() => undefined)
  const input = createReadStream(tarball)
  try {
    for await (const chunk of input) {
      if (failure) throw failure
      if (!parser.write(chunk)) await once(parser, 'drain')
    }
    parser.end()
    await complete
    if (failure) throw failure
  } catch (error) {
    input.destroy()
    throw failure ?? error
  }
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

async function packedTarball(packageRoot: string): Promise<string> {
  const entries = (await readdir(packageRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.tgz'))
  if (entries.length !== 1) {
    throw new EvolutionError('command_failed', 'Package freezing did not produce exactly one tarball')
  }
  const root = await realpath(packageRoot)
  const tarball = await realpath(path.join(packageRoot, entries[0]!.name))
  const relative = path.relative(root, tarball)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new EvolutionError('unsafe_path', 'Packed artifact escaped its owned directory')
  }
  return tarball
}

async function hashPackedArtifact(tarball: string): Promise<{ sha256: string; bytes: number }> {
  const digest = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(tarball)) {
    bytes += chunk.length
    digest.update(chunk)
  }
  return { sha256: digest.digest('hex'), bytes }
}

async function ownedChild(root: string, name: string): Promise<string> {
  const child = path.join(root, name)
  await mkdir(child, { recursive: true })
  const resolvedRoot = await realpath(root)
  const resolvedChild = await realpath(child)
  const relative = path.relative(resolvedRoot, resolvedChild)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new EvolutionError('unsafe_path', 'Artifact directory escaped its owned root')
  }
  return resolvedChild
}

async function freezePackedSource(sourceRoot: string, options: FreezeOptions): Promise<FrozenPackageArtifact> {
  await mkdir(path.resolve(options.artifactRoot), { recursive: true })
  const artifactRoot = await realpath(options.artifactRoot)
  const packageRoot = await ownedChild(artifactRoot, 'package')
  const npmCache = await ownedChild(artifactRoot, 'npm-cache')
  const npmTemp = await ownedChild(artifactRoot, 'npm-temp')
  try {
    const [npmCommand, ...npmPrefix] = await npmPackArgv(options.runner, options.signal)
    await runChecked(options.runner, [npmCommand, ...npmPrefix, 'pack', '--ignore-scripts', '--pack-destination', packageRoot], sourceRoot, {
      ...options,
      env: {
        NPM_CONFIG_CACHE: npmCache,
        NPM_CONFIG_IGNORE_SCRIPTS: 'true',
        NO_UPDATE_NOTIFIER: '1',
        TEMP: npmTemp,
        TMP: npmTemp,
      },
    })
  } finally {
    await Promise.all([
      rm(npmCache, { recursive: true, force: true }),
      rm(npmTemp, { recursive: true, force: true }),
    ])
  }
  const tarball = await packedTarball(packageRoot)
  const artifact = await hashPackedArtifact(tarball)
  const files = await readPackedFiles(tarball)
  await chmod(tarball, 0o444)
  return {
    installSpec: shellForwardedFileSpec(tarball),
    artifactRoot,
    artifactSha256: artifact.sha256,
    artifactBytes: artifact.bytes,
    files,
  }
}

export async function freezeLocalPackage(options: FreezeOptions & { sourceRoot: string }): Promise<FrozenPackageArtifact> {
  return freezePackedSource(await realpath(options.sourceRoot), options)
}

export async function freezeGithubPackage(options: FreezeOptions & { repository: string; commit: string }): Promise<FrozenPackageArtifact> {
  const repository = validateGithubRepository(options.repository)
  if (!/^[a-f0-9]{40}$/iu.test(options.commit)) {
    throw new EvolutionError('invalid_input', 'GitHub package freezing requires an exact 40-character commit')
  }
  await mkdir(path.resolve(options.artifactRoot), { recursive: true })
  const artifactRoot = await realpath(options.artifactRoot)
  const sourceRoot = await ownedChild(artifactRoot, 'source')
  if ((await readdir(sourceRoot)).length > 0) {
    throw new EvolutionError('unsafe_path', 'Frozen GitHub source directory must be empty before initialization')
  }
  try {
    const git = options.config.gitCommand
    await runChecked(options.runner, [git, 'init'], sourceRoot, options)
    await runChecked(options.runner, [git, 'remote', 'add', 'origin', `https://github.com/${repository}.git`], sourceRoot, options)
    await runChecked(options.runner, [git, 'fetch', '--depth=1', 'origin', options.commit], sourceRoot, options)
    await runChecked(options.runner, [git, 'checkout', '--detach', options.commit], sourceRoot, options)
    const head = (await runChecked(options.runner, [git, 'rev-parse', 'HEAD'], sourceRoot, options)).trim()
    if (head.toLowerCase() !== options.commit.toLowerCase()) {
      throw new EvolutionError('review_rejected', 'Frozen GitHub source HEAD does not match the requested commit')
    }
    const status = await runChecked(options.runner, [git, 'status', '--porcelain'], sourceRoot, options)
    if (status.trim()) throw new EvolutionError('review_rejected', 'Frozen GitHub source is not clean after checkout')
    return await freezePackedSource(sourceRoot, options)
  } finally {
    // The immutable tgz is the review/install authority. Retaining the
    // checkout would only duplicate source bytes inside long-lived state.
    await rm(sourceRoot, { recursive: true, force: true })
  }
}

export const _testing = { readPackedFiles, safeArchivePath, shellForwardedFileSpec }
