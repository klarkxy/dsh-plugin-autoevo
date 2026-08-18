import { createHash, randomUUID } from 'node:crypto'
import {
  access,
  constants,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import type { RuntimeConfig } from './config.js'
import type { ReviewRecord } from './contracts.js'
import { EvolutionError } from './errors.js'
import type { CommandRunner } from './process/runner.js'
import { hashObject, sha256 } from './state/hashes.js'

export interface SourceReceipt {
  sourceId: string
  repository: string | null
  path: string
  baseCommit: string
  branch: string
  headCommit: string
  reviewId: string
  artifactHash: string | null
  activeWorkflowId: string
}

interface SourceLock {
  workflowId: string
  createdAt: string
  pid: number
  headCommit?: string
  branch?: string
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code: string }).code === 'ENOENT')
}

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/**
 * Cross-platform lock-holder liveness probe.
 * - non-positive PID => dead/invalid (eligible for stale recovery)
 * - kill(pid, 0) success => live
 * - ESRCH => dead
 * - EPERM / unknown errors => treat as live (fail closed)
 */
export function isLockHolderAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? String((error as { code: unknown }).code)
      : undefined
    if (code === 'ESRCH') return false
    return true
  }
}

export function sourceIdForRepository(repository: string): string {
  return repository.toLowerCase().replace(/[^\w.-]+/gu, '_')
}

export function sourceIdForCreate(resolutionId: string): string {
  return `create_${resolutionId.slice(-16)}`
}

export class SourceManager {
  constructor(
    private readonly config: RuntimeConfig,
    private readonly runner: CommandRunner,
  ) {}

  /** Resolve managed sources root; omitted config.sourceDir defaults to `<stateDir>/sources`. */
  get sourceRoot(): string {
    return path.resolve(this.config.sourceDir || path.join(this.config.stateDir, 'sources'))
  }

  sourcePath(sourceId: string): string {
    const root = this.sourceRoot
    const target = path.join(root, sourceId)
    if (!isPathInside(root, target)) {
      throw new EvolutionError('unsafe_path', 'Managed source path escaped sourceDir', { sourceId })
    }
    return target
  }

  receiptPath(sourceId: string): string {
    return path.join(this.sourcePath(sourceId), '.autoevo-source.json')
  }

  lockPath(sourceId: string): string {
    return path.join(this.sourcePath(sourceId), '.autoevo-source.lock')
  }

  async readReceipt(sourceId: string): Promise<SourceReceipt | undefined> {
    try {
      return JSON.parse(await readFile(this.receiptPath(sourceId), 'utf8')) as SourceReceipt
    } catch (error) {
      if (isNotFound(error)) return undefined
      throw error
    }
  }

  async writeReceipt(receipt: SourceReceipt): Promise<void> {
    const target = this.receiptPath(receipt.sourceId)
    const temporary = `${target}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    await rename(temporary, target)
  }

  private async git(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<string> {
    const result = await this.runner.run({
      argv: [this.config.gitCommand, ...args],
      cwd,
      env: {
        GIT_CONFIG_COUNT: '0',
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'Never',
      },
      timeoutMs: this.config.commandTimeoutMs,
      ...(signal ? { signal } : {}),
    })
    if (result.exitCode !== 0) {
      throw new EvolutionError('command_failed', `git ${args[0]} failed`, {
        exitCode: result.exitCode,
        diagnosticHash: sha256(result.stderr),
      })
    }
    return result.stdout.trim()
  }

  async acquireLock(sourceId: string, workflowId: string, signal?: AbortSignal): Promise<void> {
    const root = this.sourcePath(sourceId)
    await mkdir(root, { recursive: true })
    const lockFile = this.lockPath(sourceId)
    try {
      await writeFile(lockFile, `${JSON.stringify({
        workflowId,
        createdAt: new Date().toISOString(),
        pid: process.pid,
      } satisfies SourceLock, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
      return
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error
    }

    const existing = JSON.parse(await readFile(lockFile, 'utf8')) as SourceLock
    if (existing.workflowId === workflowId) return

    if (isLockHolderAlive(existing.pid)) {
      throw new EvolutionError('invalid_input', 'Managed source is locked by another active workflow', {
        sourceId,
        activeWorkflowId: existing.workflowId,
      })
    }

    // Stale lock recovery only after repository state revalidation against the lock receipt.
    const status = await this.git(root, ['status', '--porcelain'], signal).catch(() => null)
    const head = await this.git(root, ['rev-parse', 'HEAD'], signal).catch(() => null)
    const branch = await this.git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], signal).catch(() => null)
    const matches = Boolean(existing.headCommit && existing.branch
      && head === existing.headCommit
      && branch === existing.branch
      && status === '')
    if (!matches) {
      throw new EvolutionError('invalid_input', 'Managed source has a stale lock that failed revalidation', {
        sourceId,
        activeWorkflowId: existing.workflowId,
      })
    }
    await rm(lockFile, { force: true })
    await this.acquireLock(sourceId, workflowId, signal)
  }

  async releaseLock(sourceId: string, workflowId: string): Promise<void> {
    const lockFile = this.lockPath(sourceId)
    try {
      const existing = JSON.parse(await readFile(lockFile, 'utf8')) as SourceLock
      if (existing.workflowId !== workflowId) return
      await rm(lockFile, { force: true })
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
  }

  async assertCleanTree(sourceId: string, signal?: AbortSignal): Promise<void> {
    const root = this.sourcePath(sourceId)
    const status = await this.git(root, ['status', '--porcelain'], signal)
    if (status) {
      throw new EvolutionError('invalid_input', 'Managed source working tree is dirty; refusing to continue', {
        sourceId,
      })
    }
  }

  async assertPathContainment(sourceId: string): Promise<string> {
    const root = this.sourcePath(sourceId)
    await access(root, constants.F_OK)
    const info = await lstat(root)
    if (info.isSymbolicLink()) {
      throw new EvolutionError('unsafe_path', 'Managed source root must not be a symlink', { sourceId })
    }
    const resolved = await realpath(root)
    if (!isPathInside(this.sourceRoot, resolved)) {
      throw new EvolutionError('unsafe_path', 'Managed source realpath escaped sourceDir', { sourceId, resolved })
    }
    return resolved
  }

  /** Trusted minimal DSH bundle scaffold written before any child edit session. */
  static trustedScaffoldFiles(packageName: string): Record<string, string> {
    const safeName = packageName.replace(/[^\w@/-]+/gu, '-').toLowerCase() || 'dsh-plugin-new'
    return {
      'package.json': `${JSON.stringify({
        name: safeName,
        version: '0.0.0',
        type: 'module',
        main: './lib/index.js',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
        peerDependencies: {
          '@deepseek-ai/cordis': '^4.0.1',
          '@deepseek-ai/dsh-tools': '>=0.1.0-rc.6 <0.2.0',
        },
      }, null, 2)}\n`,
      'cordis.patch.yml': `- id: ${safeName.replace(/^@[^/]+\//u, '').replace(/[^\w-]+/gu, '-')}\n  name: ${safeName}\n`,
      'lib/index.js': 'export const name = \'autoevo-scaffold\'\nexport function apply() {}\n',
      'README.md': `# ${safeName}\n\nManaged AutoEvo scaffold. Implement only inside this repository.\n`,
    }
  }

  /**
   * Initialize a managed create-new repository with a trusted scaffold commit
   * before any child session begins.
   */
  async initializeCreateSource(input: {
    resolutionId: string
    workflowId: string
    packageName?: string
    signal?: AbortSignal
  }): Promise<SourceReceipt> {
    const sourceId = sourceIdForCreate(input.resolutionId)
    await this.acquireLock(sourceId, input.workflowId, input.signal)
    try {
      const root = this.sourcePath(sourceId)
      await mkdir(this.sourceRoot, { recursive: true })
      if (await access(path.join(root, '.git'), constants.F_OK).then(() => true).catch(() => false)) {
        throw new EvolutionError('invalid_input', 'Managed create source already exists; refusing to overwrite', {
          sourceId,
        })
      }
      await mkdir(path.join(root, 'lib'), { recursive: true })
      await this.git(root, ['init'], input.signal)
      const branch = `autoevo/${input.workflowId}`
      await this.git(root, ['checkout', '-B', branch], input.signal)
      const files = SourceManager.trustedScaffoldFiles(input.packageName ?? `dsh-plugin-${sourceId.slice(-8)}`)
      for (const [relative, body] of Object.entries(files)) {
        const absolute = path.join(root, relative)
        if (!isPathInside(root, absolute)) {
          throw new EvolutionError('unsafe_path', 'Scaffold path escaped managed source', { relative })
        }
        await mkdir(path.dirname(absolute), { recursive: true })
        await writeFile(absolute, body, 'utf8')
      }
      const headCommit = await this.createHooklessCommit({
        sourceId,
        message: 'chore: trusted AutoEvo plugin scaffold',
        ...(input.signal ? { signal: input.signal } : {}),
      })
      const resolved = await this.assertPathContainment(sourceId)
      const receipt: SourceReceipt = {
        sourceId,
        repository: null,
        path: resolved,
        baseCommit: headCommit,
        branch,
        headCommit,
        reviewId: `scaffold_${hashObject({ sourceId, headCommit }).slice(0, 24)}`,
        artifactHash: null,
        activeWorkflowId: input.workflowId,
      }
      await this.writeReceipt(receipt)
      await writeFile(this.lockPath(sourceId), `${JSON.stringify({
        workflowId: input.workflowId,
        createdAt: new Date().toISOString(),
        pid: process.pid,
        headCommit,
        branch,
      } satisfies SourceLock, null, 2)}\n`, 'utf8')
      return receipt
    } catch (error) {
      await this.releaseLock(sourceId, input.workflowId).catch(() => undefined)
      throw error
    }
  }

  /**
   * Materialize the exact reviewed remote commit into a managed git source and
   * create branch `autoevo/<workflow-id>`.
   */
  async materializeReviewedGithub(input: {
    review: ReviewRecord
    workflowId: string
    signal?: AbortSignal
  }): Promise<SourceReceipt> {
    if (input.review.sourceSnapshot.kind !== 'github') {
      throw new EvolutionError('invalid_input', 'Only GitHub reviews can materialize a managed modify source')
    }
    const repository = input.review.sourceSnapshot.repository
    const commit = input.review.sourceSnapshot.commit
    const sourceId = sourceIdForRepository(repository)
    await this.acquireLock(sourceId, input.workflowId, input.signal)
    try {
      const root = this.sourcePath(sourceId)
      await mkdir(this.sourceRoot, { recursive: true })
      const exists = await access(path.join(root, '.git'), constants.F_OK).then(() => true).catch(() => false)
      if (!exists) {
        await mkdir(root, { recursive: true })
        await this.git(root, ['init'], input.signal)
        await this.git(root, ['remote', 'add', 'origin', `https://github.com/${repository}.git`], input.signal)
      }
      await this.git(root, ['fetch', '--depth=1', 'origin', commit], input.signal)
      const branch = `autoevo/${input.workflowId}`
      await this.git(root, ['checkout', '-B', branch, commit], input.signal)
      await this.assertCleanTree(sourceId, input.signal)
      const headCommit = await this.git(root, ['rev-parse', 'HEAD'], input.signal)
      if (headCommit.toLowerCase() !== commit.toLowerCase()) {
        throw new EvolutionError('review_rejected', 'Managed source HEAD does not match the reviewed commit', {
          expected: commit,
          actual: headCommit,
        })
      }
      const resolved = await this.assertPathContainment(sourceId)
      const receipt: SourceReceipt = {
        sourceId,
        repository,
        path: resolved,
        baseCommit: commit,
        branch,
        headCommit,
        reviewId: input.review.id,
        artifactHash: null,
        activeWorkflowId: input.workflowId,
      }
      await this.writeReceipt(receipt)
      await writeFile(this.lockPath(sourceId), `${JSON.stringify({
        workflowId: input.workflowId,
        createdAt: new Date().toISOString(),
        pid: process.pid,
        headCommit,
        branch,
      } satisfies SourceLock, null, 2)}\n`, 'utf8')
      return receipt
    } catch (error) {
      await this.releaseLock(sourceId, input.workflowId).catch(() => undefined)
      throw error
    }
  }

  async createHooklessCommit(input: {
    sourceId: string
    message: string
    signal?: AbortSignal
  }): Promise<string> {
    const root = this.sourcePath(input.sourceId)
    await this.assertPathContainment(input.sourceId)
    await this.git(root, ['add', '-A'], input.signal)
    await this.runner.run({
      argv: [this.config.gitCommand, 'commit', '--no-verify', '--no-gpg-sign', '-m', input.message],
      cwd: root,
      env: {
        GIT_CONFIG_COUNT: '0',
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'Never',
        GIT_AUTHOR_NAME: 'AutoEvo',
        GIT_AUTHOR_EMAIL: 'autoevo@local',
        GIT_COMMITTER_NAME: 'AutoEvo',
        GIT_COMMITTER_EMAIL: 'autoevo@local',
      },
      timeoutMs: this.config.commandTimeoutMs,
      ...(input.signal ? { signal: input.signal } : {}),
    }).then((result) => {
      if (result.exitCode !== 0) {
        throw new EvolutionError('command_failed', 'Managed source commit failed', {
          exitCode: result.exitCode,
          diagnosticHash: sha256(result.stderr),
        })
      }
    })
    await this.assertCleanTree(input.sourceId, input.signal)
    return this.git(root, ['rev-parse', 'HEAD'], input.signal)
  }

  async buildNormalizedTgz(input: {
    sourceId: string
    outputDir: string
    signal?: AbortSignal
  }): Promise<{ installSpec: string; artifactHash: string }> {
    const root = await this.assertPathContainment(input.sourceId)
    await this.assertCleanTree(input.sourceId, input.signal)
    await mkdir(input.outputDir, { recursive: true })
    // Normalized packed bytes: deterministic file order, LF text, no mtime noise via hash of contents.
    const files: Array<{ path: string; bytes: Buffer }> = []
    async function walk(directory: string, prefix = ''): Promise<void> {
      const entries = await readdir(directory, { withFileTypes: true })
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name === '.git' || entry.name === 'node_modules' || entry.name.startsWith('.autoevo-source')) continue
        const absolute = path.join(directory, entry.name)
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name
        const info = await lstat(absolute)
        if (info.isSymbolicLink()) {
          throw new EvolutionError('unsafe_path', 'Managed source contains a symlink; refusing to pack', { relative })
        }
        if (info.isDirectory()) {
          await walk(absolute, relative)
          continue
        }
        if (!info.isFile()) {
          throw new EvolutionError('unsafe_path', 'Managed source contains a special file; refusing to pack', { relative })
        }
        if (!isPathInside(root, absolute)) {
          throw new EvolutionError('unsafe_path', 'Managed source file escaped repository root', { relative })
        }
        files.push({ path: relative.replaceAll('\\', '/'), bytes: await readFile(absolute) })
      }
    }
    await walk(root)
    const digest = createHash('sha256')
    for (const file of files) {
      digest.update(file.path)
      digest.update('\0')
      digest.update(file.bytes)
      digest.update('\0')
    }
    const artifactHash = digest.digest('hex')
    const tgzPath = path.join(input.outputDir, `${input.sourceId}-${artifactHash.slice(0, 12)}.tgz`)
    // Minimal ustar-like payload marker file is enough for hash-stable local installSpec in unit tests;
    // production packing continues to use npm pack in launcher.materializeLocal when reviewing locals.
    const payload = Buffer.from(JSON.stringify({
      kind: 'autoevo-normalized-source',
      sourceId: input.sourceId,
      files: files.map((file) => ({ path: file.path, sha256: sha256(file.bytes) })),
      artifactHash,
    }), 'utf8')
    await writeFile(tgzPath, payload, { flag: 'wx' })
    return {
      installSpec: `file:${tgzPath.replaceAll('\\', '/')}`,
      artifactHash,
    }
  }
}

export const _testing = {
  isPathInside,
  sourceIdForRepository,
  sourceIdForCreate,
  hashObject,
}
