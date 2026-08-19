import { randomUUID } from 'node:crypto'
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
  activeWorkflowId: string | null
  /** Hash of Host-controlled Git config and hooks metadata. */
  gitConfigHash: string
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

const FORBIDDEN_UNTRACKED_PREFIXES = [
  '.pnpm-store',
  'node_modules',
  'coverage',
  'build-test',
  '.vite',
  '.turbo',
  '.cache',
  '.nyc_output',
] as const

function forbiddenUntrackedPath(status: string): string | undefined {
  for (const line of status.split(/\r?\n/u)) {
    if (!line.startsWith('?? ')) continue
    const candidate = line.slice(3).trim().replaceAll('\\', '/').replace(/^"|"$/gu, '')
    if (FORBIDDEN_UNTRACKED_PREFIXES.some((prefix) => candidate === prefix
      || candidate.startsWith(`${prefix}/`))) return candidate
  }
  return undefined
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
    if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/u.test(sourceId) || sourceId === '.' || sourceId === '..') {
      throw new EvolutionError('unsafe_path', 'Managed source id is not a safe single path segment', { sourceId })
    }
    const root = this.sourceRoot
    const target = path.join(root, sourceId)
    if (!isPathInside(root, target)) {
      throw new EvolutionError('unsafe_path', 'Managed source path escaped sourceDir', { sourceId })
    }
    return target
  }

  receiptPath(sourceId: string): string {
    void this.sourcePath(sourceId)
    return path.join(this.sourceRoot, '.autoevo-control', `${sourceId}.json`)
  }

  lockPath(sourceId: string): string {
    void this.sourcePath(sourceId)
    return path.join(this.sourceRoot, '.autoevo-control', `${sourceId}.lock`)
  }

  async readReceipt(sourceId: string): Promise<SourceReceipt | undefined> {
    try {
      return JSON.parse(await readFile(this.receiptPath(sourceId), 'utf8')) as SourceReceipt
    } catch (error) {
      if (isNotFound(error)) return undefined
      throw error
    }
  }

  async receiptForManagedPath(candidate: string): Promise<SourceReceipt | undefined> {
    const resolved = path.resolve(candidate)
    if (!isPathInside(this.sourceRoot, resolved) || path.dirname(resolved) !== path.resolve(this.sourceRoot)) return undefined
    const sourceId = path.basename(resolved)
    const receipt = await this.readReceipt(sourceId)
    if (!receipt || path.resolve(receipt.path) !== resolved) return undefined
    return receipt
  }

  async writeReceipt(receipt: SourceReceipt): Promise<void> {
    const target = this.receiptPath(receipt.sourceId)
    await mkdir(path.dirname(target), { recursive: true })
    const temporary = `${target}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    await rename(temporary, target)
  }

  private async git(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<string> {
    const hooksDir = await this.disabledHooksPath()
    const result = await this.runner.run({
      argv: [this.config.gitCommand, '-c', `core.hooksPath=${hooksDir}`, '-c', 'commit.gpgSign=false', ...args],
      cwd,
      env: {
        GIT_CONFIG_COUNT: '0',
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_ATTR_NOSYSTEM: '1',
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

  private async gitConfigHash(sourceId: string): Promise<string> {
    const root = await this.assertPathContainment(sourceId)
    const gitDir = path.join(root, '.git')
    const gitInfo = await lstat(gitDir)
    if (!gitInfo.isDirectory() || gitInfo.isSymbolicLink()) {
      throw new EvolutionError('unsafe_path', 'Managed source .git metadata must be a real directory', { sourceId })
    }
    const resolvedGitDir = await realpath(gitDir)
    if (!isPathInside(root, resolvedGitDir)) {
      throw new EvolutionError('unsafe_path', 'Managed source .git metadata escaped the repository', { sourceId })
    }
    const hooksDir = path.join(resolvedGitDir, 'hooks')
    const hooks = await readdir(hooksDir, { withFileTypes: true }).catch((error: unknown) => {
      if (isNotFound(error)) return []
      throw error
    })
    const hookDigests: Array<{ name: string; sha256: string }> = []
    for (const entry of hooks.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new EvolutionError('unsafe_path', 'Managed source Git hooks directory contains a non-file entry', {
          sourceId,
          entry: entry.name,
        })
      }
      hookDigests.push({ name: entry.name, sha256: sha256(await readFile(path.join(hooksDir, entry.name))) })
    }
    return hashObject({
      config: sha256(await readFile(path.join(resolvedGitDir, 'config'))),
      hooks: hookDigests,
    })
  }

  private async disabledHooksPath(): Promise<string> {
    const controlRoot = path.join(this.sourceRoot, '.autoevo-control')
    const hooksDir = path.join(controlRoot, 'empty-hooks')
    await mkdir(hooksDir, { recursive: true })
    const info = await lstat(hooksDir)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new EvolutionError('unsafe_path', 'Host disabled-hooks path is not a real directory')
    }
    const entries = await readdir(hooksDir)
    if (entries.length > 0) {
      throw new EvolutionError('unsafe_path', 'Host disabled-hooks directory is not empty')
    }
    const resolved = await realpath(hooksDir)
    if (!isPathInside(this.sourceRoot, resolved)) {
      throw new EvolutionError('unsafe_path', 'Host disabled-hooks directory escaped sourceDir')
    }
    return resolved
  }

  async acquireLock(sourceId: string, workflowId: string, signal?: AbortSignal): Promise<void> {
    const root = this.sourcePath(sourceId)
    await mkdir(root, { recursive: true })
    await this.assertPathContainment(sourceId)
    const lockFile = this.lockPath(sourceId)
    await mkdir(path.dirname(lockFile), { recursive: true })
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
    if (existing.workflowId === workflowId && existing.pid === process.pid) return

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
    const receipt = await this.readReceipt(sourceId).catch(() => undefined)
    const gitSecurityHash = await this.gitConfigHash(sourceId).catch(() => null)
    const matches = Boolean(receipt
      && receipt.activeWorkflowId === existing.workflowId
      && existing.headCommit && existing.branch
      && head === existing.headCommit
      && branch === existing.branch
      && receipt.headCommit === head
      && receipt.branch === branch
      && gitSecurityHash === receipt.gitConfigHash
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

  async completeWorkflow(sourceId: string, workflowId: string, signal?: AbortSignal): Promise<void> {
    const receipt = await this.readReceipt(sourceId)
    if (!receipt || receipt.activeWorkflowId !== workflowId) return
    const root = await this.assertPathContainment(sourceId)
    const status = await this.git(root, ['status', '--porcelain'], signal)
    const head = await this.git(root, ['rev-parse', 'HEAD'], signal)
    const branch = await this.git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], signal)
    const gitSecurityHash = await this.gitConfigHash(sourceId)
    if (status || head !== receipt.headCommit || branch !== receipt.branch || gitSecurityHash !== receipt.gitConfigHash) {
      throw new EvolutionError('review_rejected', 'Managed source cannot release its workflow lock because final repository state changed')
    }
    await this.writeReceipt({ ...receipt, activeWorkflowId: null })
    await this.releaseLock(sourceId, workflowId)
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
        gitConfigHash: await this.gitConfigHash(sourceId),
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
        gitConfigHash: await this.gitConfigHash(sourceId),
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
    const pending = await this.git(root, ['status', '--porcelain'], input.signal)
    if (!pending) {
      throw new EvolutionError('invalid_input', 'Managed child returned without changing the source repository')
    }
    const forbiddenPath = forbiddenUntrackedPath(pending)
    if (forbiddenPath) {
      throw new EvolutionError('review_rejected', 'Managed child left dependency/cache artifacts in the source repository', {
        path: forbiddenPath,
      })
    }
    await this.git(root, ['add', '-A'], input.signal)
    const hooksDir = await this.disabledHooksPath()
    await this.runner.run({
      argv: [
        this.config.gitCommand,
        '-c', `core.hooksPath=${hooksDir}`,
        '-c', 'commit.gpgSign=false',
        'commit', '--no-verify', '--no-gpg-sign', '-m', input.message,
      ],
      cwd: root,
      env: {
        GIT_CONFIG_COUNT: '0',
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_ATTR_NOSYSTEM: '1',
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

  async finalizeChildCommit(input: {
    sourceId: string
    workflowId: string
    reviewId: string
    message: string
    signal?: AbortSignal
  }): Promise<SourceReceipt> {
    const receipt = await this.readReceipt(input.sourceId)
    if (!receipt || receipt.activeWorkflowId !== input.workflowId) {
      throw new EvolutionError('invalid_input', 'Managed source receipt is absent or belongs to another workflow')
    }
    const lock = JSON.parse(await readFile(this.lockPath(input.sourceId), 'utf8')) as SourceLock
    if (lock.workflowId !== input.workflowId || lock.pid !== process.pid) {
      throw new EvolutionError('invalid_input', 'Managed source lock is not owned by this workflow instance')
    }
    const root = await this.assertPathContainment(input.sourceId)
    const configHash = await this.gitConfigHash(input.sourceId)
    if (configHash !== receipt.gitConfigHash) {
      throw new EvolutionError('review_rejected', 'Managed child changed repository Git configuration')
    }
    const branch = await this.git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], input.signal)
    const head = await this.git(root, ['rev-parse', 'HEAD'], input.signal)
    if (branch !== receipt.branch || head.toLowerCase() !== receipt.headCommit.toLowerCase()) {
      throw new EvolutionError('review_rejected', 'Managed child changed Git branch or HEAD instead of only editing the working tree', {
        expectedBranch: receipt.branch,
        actualBranch: branch,
        expectedHead: receipt.headCommit,
        actualHead: head,
      })
    }
    const headCommit = await this.createHooklessCommit({
      sourceId: input.sourceId,
      message: input.message,
      ...(input.signal ? { signal: input.signal } : {}),
    })
    const next: SourceReceipt = {
      ...receipt,
      headCommit,
      reviewId: input.reviewId,
      artifactHash: null,
    }
    await this.writeReceipt(next)
    await writeFile(this.lockPath(input.sourceId), `${JSON.stringify({
      workflowId: input.workflowId,
      createdAt: lock.createdAt,
      pid: process.pid,
      headCommit,
      branch,
    } satisfies SourceLock, null, 2)}\n`, 'utf8')
    return next
  }

  async recordReviewedArtifact(input: {
    sourceId: string
    workflowId: string
    reviewId: string
    artifactHash: string
  }): Promise<SourceReceipt> {
    if (!/^[a-f0-9]{64}$/u.test(input.artifactHash)) {
      throw new EvolutionError('invalid_input', 'Managed source artifact hash must be sha256')
    }
    const receipt = await this.readReceipt(input.sourceId)
    if (!receipt || receipt.activeWorkflowId !== input.workflowId) {
      throw new EvolutionError('invalid_input', 'Managed source provenance does not match the reviewed artifact')
    }
    const next = { ...receipt, reviewId: input.reviewId, artifactHash: input.artifactHash }
    await this.writeReceipt(next)
    return next
  }

  /** Re-enter an already-owned managed source without resetting its lineage. */
  async resumeWorkflowSource(sourceId: string, workflowId: string, signal?: AbortSignal): Promise<SourceReceipt> {
    const receipt = await this.readReceipt(sourceId)
    if (!receipt || receipt.activeWorkflowId !== workflowId) {
      throw new EvolutionError('invalid_input', 'Managed source is not owned by this workflow')
    }
    const lock = JSON.parse(await readFile(this.lockPath(sourceId), 'utf8')) as SourceLock
    if (lock.workflowId !== workflowId || lock.pid !== process.pid) {
      throw new EvolutionError('invalid_input', 'Managed source lock is not owned by this workflow instance')
    }
    const root = await this.assertPathContainment(sourceId)
    const branch = await this.git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], signal)
    const head = await this.git(root, ['rev-parse', 'HEAD'], signal)
    const gitSecurityHash = await this.gitConfigHash(sourceId)
    if (branch !== receipt.branch
      || head.toLowerCase() !== receipt.headCommit.toLowerCase()
      || gitSecurityHash !== receipt.gitConfigHash) {
      throw new EvolutionError('review_rejected', 'Managed source lineage changed before the next revision')
    }
    await this.assertCleanTree(sourceId, signal)
    return receipt
  }

  /** Preserve a failed child's bounded edits as a local WIP commit for retry. */
  async preserveInterruptedChild(input: {
    sourceId: string
    workflowId: string
    reviewId: string
    signal?: AbortSignal
  }): Promise<SourceReceipt> {
    const root = await this.assertPathContainment(input.sourceId)
    const pending = await this.git(root, ['status', '--porcelain'], input.signal)
    if (!pending) {
      const receipt = await this.readReceipt(input.sourceId)
      if (!receipt || receipt.activeWorkflowId !== input.workflowId) {
        throw new EvolutionError('invalid_input', 'Managed source is not owned by this workflow')
      }
      return receipt
    }
    return await this.finalizeChildCommit({
      sourceId: input.sourceId,
      workflowId: input.workflowId,
      reviewId: input.reviewId,
      message: `chore: preserve interrupted AutoEvo workflow ${input.workflowId}`,
      ...(input.signal ? { signal: input.signal } : {}),
    })
  }
}

export const _testing = {
  isPathInside,
  sourceIdForRepository,
  sourceIdForCreate,
  hashObject,
  forbiddenUntrackedPath,
}
