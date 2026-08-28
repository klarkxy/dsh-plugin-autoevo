import { access, chmod, cp, lstat, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import type { RuntimeConfig } from '../config.js'
import type { ReviewRecord } from '../contracts.js'
import { EvolutionError } from '../errors.js'
import type { CommandRunner } from '../process/runner.js'
import { inspectLocalDirectory } from '../review/review.js'
import { isExcludedLocalPackagePath } from '../review/local-path-policy.js'
import { hashObject, sha256 } from '../state/hashes.js'

export interface MaterializedLocalPackage {
  installSpec: string
  artifactRoot: string
  artifactSha256: string
}

function fileFacts(files: ReviewRecord['inspectedFiles']): Array<{ path: string; sha256: string; bytes: number }> {
  return files.map((file) => ({ path: file.path, sha256: file.sha256, bytes: file.bytes }))
    .sort((left, right) => left.path.localeCompare(right.path))
}

function assertReviewedSnapshot(
  review: ReviewRecord,
  snapshot: Awaited<ReturnType<typeof inspectLocalDirectory>>,
): void {
  if (snapshot.truncated || review.findings.some((finding) => finding.code === 'review_truncated')) {
    throw new EvolutionError('review_rejected', 'A truncated local package cannot be materialized for installation')
  }
  const actual = snapshot.files.map((file) => ({
    path: file.path,
    sha256: sha256(file.content),
    bytes: file.content.byteLength,
  })).sort((left, right) => left.path.localeCompare(right.path))
  if (hashObject(actual) !== hashObject(fileFacts(review.inspectedFiles))) {
    throw new EvolutionError('review_expired', 'The materialized local package differs from the reviewed file set')
  }
}

function shellForwardedFileSpec(filename: string): string {
  const absolute = path.resolve(filename)
  // DSH rc.6 forwards plugin arguments to pnpm through cmd.exe on Windows.
  // The artifact path is plugin-owned, but an unsafe configured parent path
  // must still fail closed rather than become shell syntax downstream.
  if (/[\u0000-\u001f"&|<>^()%!]/u.test(absolute)) {
    throw new EvolutionError('unsafe_path', 'The owned package path contains characters unsafe for DSH plugin forwarding')
  }
  return `file:${absolute.replaceAll('\\', '/')}`
}

async function npmPackArgv(runner: CommandRunner, signal?: AbortSignal): Promise<[string, ...string[]]> {
  const adjacent = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  try {
    await access(adjacent)
    return [process.execPath, await realpath(adjacent)]
  } catch {
    // Fall through to the npm shim installed alongside the DSH runtime.
  }
  if (!runner.resolveExecutable) return ['npm']
  const shim = await runner.resolveExecutable('npm', signal)
  if (!/\.(?:cmd|ps1)$/iu.test(shim)) return [shim]
  const directory = path.dirname(shim)
  const candidates = [
    path.resolve(directory, 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(directory, '../../node/node_modules/npm/bin/npm-cli.js'),
  ]
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return [process.execPath, await realpath(candidate)]
    } catch {
      // Try the next standard npm shim layout.
    }
  }
  throw new EvolutionError('command_failed', 'npm resolved to a Windows shim, but its JavaScript CLI could not be located safely')
}

export async function materializeLocalPackage(options: {
  review: ReviewRecord
  artifactRoot: string
  config: RuntimeConfig
  runner: CommandRunner
  signal?: AbortSignal
}): Promise<MaterializedLocalPackage> {
  if (options.review.sourceSnapshot.kind !== 'local') {
    throw new EvolutionError('invalid_input', 'Only a local review can be materialized')
  }
  const sourceRoot = await realpath(options.review.sourceSnapshot.path)
  const artifactRoot = path.resolve(options.artifactRoot)
  const snapshotRoot = path.join(artifactRoot, 'source')
  const packageRoot = path.join(artifactRoot, 'package')
  await mkdir(artifactRoot, { recursive: true })
  await cp(sourceRoot, snapshotRoot, {
    recursive: true,
    force: false,
    errorOnExist: true,
    async filter(source) {
      const relative = path.relative(sourceRoot, source)
      if (!relative) return true
      if (isExcludedLocalPackagePath(relative)) return false
      const facts = await lstat(source)
      if (facts.isSymbolicLink() || (!facts.isDirectory() && !facts.isFile())) {
        throw new EvolutionError('unsafe_path', 'Local packages with symbolic links or special files cannot be materialized', {
          pathHash: sha256(relative),
        })
      }
      return true
    },
  })

  assertReviewedSnapshot(options.review, await inspectLocalDirectory(snapshotRoot, options.config))
  await mkdir(packageRoot, { recursive: true })
  const npmCache = path.join(artifactRoot, 'npm-cache')
  const npmTemp = path.join(artifactRoot, 'npm-temp')
  await mkdir(npmCache, { recursive: true })
  await mkdir(npmTemp, { recursive: true })
  const [npmCommand, ...npmPrefix] = await npmPackArgv(options.runner, options.signal)
  await options.runner.run({
    argv: [npmCommand, ...npmPrefix, 'pack', '--ignore-scripts', '--pack-destination', packageRoot],
    cwd: snapshotRoot,
    env: {
      NPM_CONFIG_CACHE: npmCache,
      NPM_CONFIG_IGNORE_SCRIPTS: 'true',
      NO_UPDATE_NOTIFIER: '1',
      TEMP: npmTemp,
      TMP: npmTemp,
    },
    timeoutMs: Math.max(options.config.commandTimeoutMs, 120_000),
    ...(options.signal ? { signal: options.signal } : {}),
  })
  await rm(npmCache, { recursive: true, force: true })
  await rm(npmTemp, { recursive: true, force: true })
  // Packing must not mutate or generate any installable source bytes.
  assertReviewedSnapshot(options.review, await inspectLocalDirectory(snapshotRoot, options.config))

  const tarballs = (await readdir(packageRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.tgz'))
  if (tarballs.length !== 1) {
    throw new EvolutionError('command_failed', 'Local package materialization did not produce exactly one tarball')
  }
  const tarball = await realpath(path.join(packageRoot, tarballs[0]!.name))
  const relative = path.relative(await realpath(packageRoot), tarball)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new EvolutionError('unsafe_path', 'Packed artifact escaped its owned directory')
  }
  await chmod(tarball, 0o444)
  return {
    installSpec: shellForwardedFileSpec(tarball),
    artifactRoot,
    artifactSha256: sha256(await readFile(tarball)),
  }
}

export const _testing = { assertReviewedSnapshot, npmPackArgv, shellForwardedFileSpec }
