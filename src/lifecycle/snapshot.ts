import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import type { RuntimeConfig } from '../config.js'
import type { ReviewRecord } from '../contracts.js'
import { EvolutionError } from '../errors.js'
import type { CommandRunner } from '../process/runner.js'
import { inspectLocalDirectory } from '../review/review.js'
import { isExcludedLocalPackagePath } from '../review/local-path-policy.js'
import { hashObject, sha256 } from '../state/hashes.js'
import { npmPackArgv, shellForwardedFileSpec } from './npm-cli.js'

export interface MaterializedLocalPackage {
  installSpec: string
  artifactRoot: string
  artifactSha256: string
}

function fileFacts(files: ReviewRecord['inspectedFiles']): Array<{ path: string; sha256: string; bytes: number }> {
  return files.map((file) => ({ path: file.path, sha256: file.sha256, bytes: file.bytes }))
    .sort((left, right) => left.path.localeCompare(right.path))
}

function safeReviewedPath(value: string): string | null {
  if (!value || value.includes('\\') || value.includes('\0') || (process.platform === 'win32' && value.includes(':'))
    || path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || isExcludedLocalPackagePath(value)) return null
  if (value.split('/').some((part) => part === '.' || part === '..' || !part)) return null
  return value
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
  await mkdir(snapshotRoot)
  for (const reviewed of fileFacts(options.review.inspectedFiles)) {
    const relative = safeReviewedPath(reviewed.path)
    if (!relative) throw new EvolutionError('unsafe_path', 'The reviewed local package contains an unsafe file path')
    const source = path.join(sourceRoot, ...relative.split('/'))
    const facts = await lstat(source)
    if (!facts.isFile() || facts.isSymbolicLink()) {
      throw new EvolutionError('unsafe_path', 'Local packages with symbolic links or special files cannot be materialized', {
        pathHash: sha256(relative),
      })
    }
    const destination = path.join(snapshotRoot, ...relative.split('/'))
    await mkdir(path.dirname(destination), { recursive: true })
    await copyFile(source, destination)
  }

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
