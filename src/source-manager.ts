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
import { isAlreadyExists, isNotFound, isPathInside, isProcessAlive } from './internal-utils.js'
import type { ReviewRecord } from './contracts.js'
import { EvolutionError } from './errors.js'
import { normalizePackagePath } from './github/git-cache.js'
import type { CommandRunner } from './process/runner.js'
import { hashObject, sha256 } from './state/hashes.js'
import {
  currentWorkspaceCwd,
  ensureAutoEvoGitignore,
  resolveSourceRoot,
  resolveStateRoot,
  WORKSPACE_SOURCE_DIR,
} from './workspace-layout.js'

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
  /** Normalized package root inside the managed repository. */
  packagePath?: string
  /** Durable authority to finish a workflow-release transaction after a crash. */
  completionProof?: {
    schemaVersion: 1
    workflowId: string
    lockToken: string
    activeReceiptHash: string
  }
}

export interface FinalizedChildCommit extends SourceReceipt {
  changedFiles: string[]
  changedFilesTruncated: boolean
}

interface SourceLock {
  workflowId: string
  createdAt: string
  pid: number
  lockToken?: string
  headCommit?: string
  branch?: string
  gitConfigHash?: string
}

interface SourceLockHandle {
  sourceId: string
  workflowId: string
  lockToken: string
  acquiredHere: boolean
}

interface SourceLockRecoveryOwner {
  schemaVersion?: 1
  recoveryToken: string
  workflowId: string
  pid: number
  observedLock: string
  createdAt: string
  purpose?: 'workflow_completion'
  completionProofHash?: string
  ownerLockToken?: string
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

const HOST_SOURCE_EXCLUDES = ['node_modules/', '.pnpm-store/'] as const

/**
 * Detects untracked dependency/cache artifacts from `git status --porcelain`.
 * Host writes `node_modules/` and `.pnpm-store/` into `.git/info/exclude` when
 * creating a managed source, so a legitimate child `pnpm install --ignore-scripts`
 * does not appear here. This scan is defense-in-depth if exclude is missing:
 * npm pack (see lifecycle/package-artifact.ts freezePackedSource) excludes
 * node_modules by default, so a stray tree cannot enter the frozen artifact.
 */
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
 * Canonicalize a path for security comparisons: realpath when it exists,
 * path.resolve when it does not yet (e.g. a base dir not yet created).
 * Windows temp dirs may use 8.3 short-name aliases (CI runners) and base
 * roots may themselves be symlinks, so both sides of a containment or
 * equality check must be canonicalized the same way.
 */
async function canonicalPath(candidate: string): Promise<string> {
  try {
    return await realpath(candidate)
  } catch (error) {
    if (!isNotFound(error)) throw error
    return path.resolve(candidate)
  }
}

type SourceCompletionProof = NonNullable<SourceReceipt['completionProof']>

function validatedCompletionProof(receipt: SourceReceipt): {
  proof: SourceCompletionProof
  activeReceipt: SourceReceipt
  proofHash: string
} | undefined {
  const proof = receipt.completionProof
  if (!proof
    || proof.schemaVersion !== 1
    || receipt.activeWorkflowId !== null
    || !proof.workflowId
    || !proof.lockToken
    || !/^[a-f0-9]{64}$/u.test(proof.activeReceiptHash)) return undefined
  const { completionProof: _proof, ...withoutProof } = receipt
  const activeReceipt: SourceReceipt = { ...withoutProof, activeWorkflowId: proof.workflowId }
  if (hashObject(activeReceipt) !== proof.activeReceiptHash) return undefined
  return { proof, activeReceipt, proofHash: hashObject(proof) }
}

function lockMatchesCompletion(
  lock: SourceLock,
  proof: SourceCompletionProof,
  receipt: SourceReceipt,
): boolean {
  return lock.workflowId === proof.workflowId
    && lock.lockToken === proof.lockToken
    && lock.headCommit === receipt.headCommit
    && lock.branch === receipt.branch
    && lock.gitConfigHash === receipt.gitConfigHash
}

export function sourceIdForRepository(repository: string, packagePath?: string): string {
  const base = repository.toLowerCase().replace(/[^\w.-]+/gu, '_')
  const normalized = normalizePackagePath(packagePath)
  return normalized ? `${base}_${hashObject(normalized).slice(0, 12)}` : base
}

export function sourceIdForCreate(resolutionId: string): string {
  return `create_${resolutionId.slice(-16)}`
}

export { WORKSPACE_SOURCE_DIR }

export class SourceManager {
  constructor(
    private readonly config: RuntimeConfig,
    private readonly runner: CommandRunner,
  ) {}

  private get controlRoot(): string {
    return path.join(resolveStateRoot(this.config), 'source-control')
  }

  private get legacySourceRoot(): string {
    return path.resolve(this.config.sourceDir || path.join(resolveStateRoot(this.config), 'sources'))
  }

  private legacyReceiptPath(sourceId: string): string {
    return path.join(this.legacySourceRoot, '.autoevo-control', `${sourceId}.json`)
  }

  private legacyLockPath(sourceId: string): string {
    return path.join(this.legacySourceRoot, '.autoevo-control', `${sourceId}.lock`)
  }

  /** Explicit `sourceDir` override, or `<workspace>/.autoevo/sources`; Host control remains under stateDir. */
  sourceRootFor(workspaceCwd?: string): string {
    return resolveSourceRoot(this.config, workspaceCwd || currentWorkspaceCwd())
  }

  /** @deprecated Use sourceRootFor(workspaceCwd). Kept for explicit sourceDir unit and integration tests. */
  get sourceRoot(): string {
    return this.sourceRootFor()
  }

  sourcePath(sourceId: string, workspaceCwd?: string): string {
    if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/u.test(sourceId) || sourceId === '.' || sourceId === '..') {
      throw new EvolutionError('unsafe_path', 'Managed source id is not a safe single path segment', { sourceId })
    }
    const root = this.sourceRootFor(workspaceCwd)
    const target = path.join(root, sourceId)
    if (!isPathInside(root, target)) {
      throw new EvolutionError('unsafe_path', 'Managed source path escaped sourceDir', { sourceId })
    }
    return target
  }

  private async hasGitDirectory(candidate: string, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted()
    try {
      await this.accessGitDirectory(candidate)
      signal?.throwIfAborted()
      return true
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      if (isNotFound(error)) return false
      throw error
    }
  }

  private async accessGitDirectory(candidate: string): Promise<void> {
    await access(candidate, constants.F_OK)
  }

  /** True when `candidate` is inside the managed sources root for this session. */
  async pathUnderSourceRoot(candidate: string, workspaceCwd?: string): Promise<boolean> {
    return isPathInside(
      await canonicalPath(this.sourceRootFor(workspaceCwd)),
      await canonicalPath(candidate),
    )
  }

  /**
   * Resume/finalize follow a Host receipt. Materialize/initialize pass
   * `workspaceCwd` so a new or relocated tree lands in the session workspace.
   */
  private resolveWorkingPath(sourceId: string, workspaceCwd?: string, receipt?: SourceReceipt): string {
    if (workspaceCwd || this.config.sourceDir) {
      return this.sourcePath(sourceId, workspaceCwd)
    }
    if (receipt) return path.resolve(receipt.path)
    return this.sourcePath(sourceId, workspaceCwd)
  }

  receiptPath(sourceId: string): string {
    if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/u.test(sourceId) || sourceId === '.' || sourceId === '..') {
      throw new EvolutionError('unsafe_path', 'Managed source id is not a safe single path segment', { sourceId })
    }
    return path.join(this.controlRoot, `${sourceId}.json`)
  }

  lockPath(sourceId: string): string {
    if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/u.test(sourceId) || sourceId === '.' || sourceId === '..') {
      throw new EvolutionError('unsafe_path', 'Managed source id is not a safe single path segment', { sourceId })
    }
    return path.join(this.controlRoot, `${sourceId}.lock`)
  }

  private lockRecoveryPath(sourceId: string): string {
    return `${this.lockPath(sourceId)}.recovery`
  }

  private completionRecoveryTakeoverPath(sourceId: string): string {
    return `${this.lockRecoveryPath(sourceId)}.workflow-completion-takeover`
  }

  /** Containment of a realpath'd managed source against canonicalized base roots. */
  private async isCanonicalManagedSourceDir(resolved: string, sourceId: string): Promise<boolean> {
    const parent = path.dirname(resolved)
    if (path.basename(resolved) !== sourceId) return false
    if (this.config.sourceDir) return parent === await canonicalPath(this.config.sourceDir)
    if (path.basename(parent) === 'sources' && path.basename(path.dirname(parent)) === '.autoevo') return true
    if (this.config.stateDir) {
      return parent === await canonicalPath(path.join(this.config.stateDir, 'sources'))
    }
    return false
  }

  private async ensureWorkspaceLayout(workspaceCwd?: string): Promise<string> {
    const root = this.sourceRootFor(workspaceCwd)
    await mkdir(root, { recursive: true })
    if (path.basename(path.dirname(root)) === '.autoevo') {
      await ensureAutoEvoGitignore(path.dirname(root))
    }
    return root
  }

  async readReceipt(sourceId: string): Promise<SourceReceipt | undefined> {
    try {
      return JSON.parse(await readFile(this.receiptPath(sourceId), 'utf8')) as SourceReceipt
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
    try {
      const receipt = JSON.parse(await readFile(this.legacyReceiptPath(sourceId), 'utf8')) as SourceReceipt
      if (receipt.sourceId !== sourceId
        || receipt.activeWorkflowId !== null
        || path.resolve(receipt.path) !== path.resolve(this.legacySourceRoot, sourceId)) return undefined
      try {
        const lock = JSON.parse(await readFile(this.legacyLockPath(sourceId), 'utf8')) as SourceLock
        if (isProcessAlive(lock.pid)) return undefined
      } catch (error) {
        if (!isNotFound(error)) return undefined
      }
      return receipt
    } catch (error) {
      if (isNotFound(error)) return undefined
      throw error
    }
  }

  async receiptForManagedPath(candidate: string): Promise<SourceReceipt | undefined> {
    const resolved = await canonicalPath(candidate)
    const sourceId = path.basename(resolved)
    if (!(await this.isCanonicalManagedSourceDir(resolved, sourceId))) return undefined
    const receipt = await this.readReceipt(sourceId)
    if (!receipt || await canonicalPath(receipt.path) !== resolved) return undefined
    return receipt
  }

  /** Read-only proof that a historical local review still has an intact completed Host source. */
  async validateCompletedSnapshot(input: {
    path: string
    reviewId: string
    repository: string | null
    baseCommit: string
    workspaceCwd?: string
    signal?: AbortSignal
  }): Promise<SourceReceipt | undefined> {
    const receipt = await this.receiptForManagedPath(input.path)
    if (!receipt
      || receipt.reviewId !== input.reviewId
      || !receipt.artifactHash
      || receipt.activeWorkflowId !== null
      || (input.repository === null
        ? receipt.repository !== null
        : receipt.repository?.toLowerCase() !== input.repository.toLowerCase())
      || receipt.baseCommit.toLowerCase() !== input.baseCommit.toLowerCase()) return undefined
    const inCurrentWorkspace = await this.pathUnderSourceRoot(receipt.path, input.workspaceCwd)
    const inLegacyRoot = await canonicalPath(receipt.path)
      === await canonicalPath(path.join(this.legacySourceRoot, receipt.sourceId))
    if (!inCurrentWorkspace && !inLegacyRoot) return undefined
    const completed = await this.inspectCompletedSource(receipt.sourceId, input.signal)
    if (!completed
      || completed.reviewId !== receipt.reviewId
      || completed.artifactHash !== receipt.artifactHash
      || path.resolve(completed.path) !== path.resolve(receipt.path)) return undefined
    return completed
  }

  async writeReceipt(receipt: SourceReceipt): Promise<void> {
    const target = this.receiptPath(receipt.sourceId)
    await mkdir(path.dirname(target), { recursive: true })
    const temporary = `${target}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    await rename(temporary, target)
  }

  /**
   * Ignore install trees via Git-native exclude (not a working-tree .gitignore)
   * so later Host commits neither add node_modules nor trip the untracked-entry guard.
   */
  private async ensureHostSourceExcludes(root: string): Promise<void> {
    const infoDir = path.join(root, '.git', 'info')
    await mkdir(infoDir, { recursive: true })
    const excludePath = path.join(infoDir, 'exclude')
    const existing = await readFile(excludePath, 'utf8').catch((error: unknown) => {
      if (isNotFound(error)) return ''
      throw error
    })
    const present = new Set(existing.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean))
    const needed = HOST_SOURCE_EXCLUDES.filter((line) => !present.has(line))
    if (needed.length === 0) return
    const prefix = existing && !existing.endsWith('\n') ? '\n' : ''
    const header = existing.includes('AutoEvo Host')
      ? ''
      : '# AutoEvo Host: install artifacts stay untracked. npm pack excludes node_modules by default.\n'
    await writeFile(excludePath, `${existing}${prefix}${header}${needed.join('\n')}\n`, 'utf8')
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

  private async gitConfigHash(sourceId: string, workspaceCwd?: string): Promise<string> {
    const root = await this.assertPathContainment(sourceId, workspaceCwd)
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
    const hooksDir = path.join(this.controlRoot, 'empty-hooks')
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
    if (!isPathInside(await canonicalPath(resolveStateRoot(this.config)), resolved)) {
      throw new EvolutionError('unsafe_path', 'Host disabled-hooks directory escaped AutoEvo stateDir')
    }
    return resolved
  }

  private async acquireLockInternal(
    sourceId: string,
    workflowId: string,
    signal: AbortSignal | undefined,
    workspaceCwd: string | undefined,
    allowVerifiedReentry = false,
  ): Promise<SourceLockHandle> {
    signal?.throwIfAborted()
    let currentReceipt = await this.readReceipt(sourceId)
    if (currentReceipt?.completionProof) {
      const completed = await this.convergeWorkflowCompletion(currentReceipt)
      if (!completed) {
        throw new EvolutionError('invalid_input', 'Managed source completion proof failed closed validation')
      }
      throw new EvolutionError('invalid_input', 'Completed managed source must be claimed before a new workflow can acquire its lock', {
        sourceId,
      })
    }
    const root = this.resolveWorkingPath(sourceId, workspaceCwd, currentReceipt)
    await mkdir(root, { recursive: true })
    await this.assertPathContainment(sourceId, workspaceCwd)
    const lockFile = this.lockPath(sourceId)
    const recoveryFile = this.lockRecoveryPath(sourceId)
    await mkdir(path.dirname(lockFile), { recursive: true })
    if (await this.lockPublicationBarrierExists(sourceId)) {
      throw new EvolutionError('invalid_input', 'Managed source lock recovery is already owned; refusing concurrent takeover', {
        sourceId,
      })
    }
    signal?.throwIfAborted()
    if (allowVerifiedReentry) {
      if (!currentReceipt
        || currentReceipt.activeWorkflowId !== workflowId
        || currentReceipt.completionProof) {
        throw new EvolutionError('invalid_input', 'Managed source resume requires an active receipt owned by this workflow', {
          sourceId,
        })
      }
      let raw: string
      try {
        raw = await readFile(lockFile, 'utf8')
      } catch (error) {
        if (isNotFound(error)) {
          throw new EvolutionError('invalid_input', 'Managed source resume requires its existing workflow lock', { sourceId })
        }
        throw error
      }
      const existing = JSON.parse(raw) as SourceLock
      if (existing.workflowId === workflowId && existing.pid === process.pid) {
        if (!existing.lockToken
          || existing.headCommit !== currentReceipt.headCommit
          || existing.branch !== currentReceipt.branch
          || existing.gitConfigHash !== currentReceipt.gitConfigHash) {
          throw new EvolutionError('invalid_input', 'Managed source resume lock failed exact receipt validation', { sourceId })
        }
        const head = await this.git(root, ['rev-parse', 'HEAD'], signal)
        signal?.throwIfAborted()
        const branch = await this.git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], signal)
        signal?.throwIfAborted()
        const gitConfigHash = await this.gitConfigHash(sourceId, workspaceCwd)
        signal?.throwIfAborted()
        if (head !== currentReceipt.headCommit || branch !== currentReceipt.branch || gitConfigHash !== currentReceipt.gitConfigHash) {
          throw new EvolutionError('invalid_input', 'Managed source changed before verified workflow reentry', { sourceId })
        }
        return { sourceId, workflowId, lockToken: existing.lockToken, acquiredHere: false }
      }
    }
    const initialLock: SourceLock = {
      workflowId,
      createdAt: new Date().toISOString(),
      pid: process.pid,
      lockToken: randomUUID(),
    }
    const initialBody = `${JSON.stringify(initialLock, null, 2)}\n`
    let initialPublished = false
    try {
      await writeFile(lockFile, initialBody, { encoding: 'utf8', flag: 'wx' })
      initialPublished = true
      signal?.throwIfAborted()
      if (await this.lockPublicationBarrierExists(sourceId)) {
        await this.releaseLockToken(sourceId, initialLock.lockToken!)
        initialPublished = false
        throw new EvolutionError('invalid_input', 'Managed source lock recovery started during publication; refusing takeover', {
          sourceId,
        })
      }
      return { sourceId, workflowId, lockToken: initialLock.lockToken!, acquiredHere: true }
    } catch (error) {
      if (initialPublished) {
        await this.releaseLockToken(sourceId, initialLock.lockToken!).catch(() => undefined)
        throw error
      }
      if (!isAlreadyExists(error)) throw error
    }

    const observedLock = await readFile(lockFile, 'utf8')
    const existing = JSON.parse(observedLock) as SourceLock
    if (existing.workflowId === workflowId && existing.pid === process.pid) {
      throw new EvolutionError('invalid_input', 'Managed source is already locked by this workflow invocation', {
        sourceId,
        activeWorkflowId: workflowId,
      })
    }

    if (isProcessAlive(existing.pid)) {
      throw new EvolutionError('invalid_input', 'Managed source is locked by another active workflow', {
        sourceId,
        activeWorkflowId: existing.workflowId,
      })
    }

    // Automatic recovery is intentionally limited to the same active workflow.
    // Completed/null receipts and cross-workflow takeovers remain fail-closed.
    const status = await this.git(root, ['status', '--porcelain'], signal)
    signal?.throwIfAborted()
    const head = await this.git(root, ['rev-parse', 'HEAD'], signal)
    signal?.throwIfAborted()
    const branch = await this.git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], signal)
    signal?.throwIfAborted()
    const lockedReceipt = await this.readReceipt(sourceId)
    signal?.throwIfAborted()
    const gitSecurityHash = await this.gitConfigHash(sourceId, workspaceCwd)
    signal?.throwIfAborted()
    const matches = Boolean(lockedReceipt
      && existing.workflowId === workflowId
      && lockedReceipt.activeWorkflowId === workflowId
      && existing.headCommit
      && existing.branch
      && head === existing.headCommit
      && branch === existing.branch
      && lockedReceipt.headCommit === head
      && lockedReceipt.branch === branch
      && gitSecurityHash === lockedReceipt.gitConfigHash
      && status === '')
    if (!matches) {
      throw new EvolutionError('invalid_input', 'Managed source has a stale lock that failed revalidation', {
        sourceId,
        activeWorkflowId: existing.workflowId,
      })
    }
    const recoveryOwner: SourceLockRecoveryOwner = {
      recoveryToken: randomUUID(),
      workflowId,
      pid: process.pid,
      observedLock,
      createdAt: new Date().toISOString(),
    }
    if (await this.optionalFile(this.completionRecoveryTakeoverPath(sourceId)) !== undefined) {
      throw new EvolutionError('invalid_input', 'Managed source workflow-completion takeover blocks stale-lock recovery', {
        sourceId,
      })
    }
    try {
      await writeFile(recoveryFile, `${JSON.stringify(recoveryOwner, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      })
    } catch (error) {
      if (isAlreadyExists(error)) {
        throw new EvolutionError('invalid_input', 'Managed source lock recovery is already owned; refusing concurrent takeover', {
          sourceId,
        })
      }
      throw error
    }
    try {
      signal?.throwIfAborted()
      const latestObservedLock = await readFile(lockFile, 'utf8')
      if (latestObservedLock !== observedLock) {
        throw new EvolutionError('invalid_input', 'Managed source lock changed during stale-lock recovery', {
          sourceId,
        })
      }

      // Revalidate under the recovery-owner marker. Every current publisher
      // checks that marker before attempting `wx`, so the observed lock cannot be
      // replaced while this owner performs the handoff.
      const revalidatedStatus = await this.git(root, ['status', '--porcelain'], signal)
      signal?.throwIfAborted()
      const revalidatedHead = await this.git(root, ['rev-parse', 'HEAD'], signal)
      signal?.throwIfAborted()
      const revalidatedBranch = await this.git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], signal)
      signal?.throwIfAborted()
      const revalidatedReceipt = await this.readReceipt(sourceId)
      const revalidatedConfigHash = await this.gitConfigHash(sourceId, workspaceCwd)
      signal?.throwIfAborted()
      if (revalidatedStatus !== ''
        || revalidatedHead !== head
        || revalidatedBranch !== branch
        || revalidatedConfigHash !== gitSecurityHash
        || revalidatedReceipt?.activeWorkflowId !== workflowId
        || revalidatedReceipt.headCommit !== head
        || revalidatedReceipt.branch !== branch
        || revalidatedReceipt.gitConfigHash !== gitSecurityHash) {
        throw new EvolutionError('invalid_input', 'Managed source changed during stale-lock recovery', { sourceId })
      }
    } catch (error) {
      await this.releaseRecoveryOwner(sourceId, recoveryOwner.recoveryToken).catch(() => undefined)
      throw error
    }

    const quarantine = `${lockFile}.${randomUUID()}.stale`
    let published = false
    let quarantined = false
    try {
      if (!(await this.staleRecoveryOwnerStillOwned(sourceId, recoveryOwner.recoveryToken))) {
        throw new EvolutionError('invalid_input', 'Managed source stale-lock recovery ownership changed before publication', {
          sourceId,
        })
      }
      await rename(lockFile, quarantine)
      quarantined = true
      if (await readFile(quarantine, 'utf8') !== observedLock) {
        throw new EvolutionError('invalid_input', 'Managed source lock changed during stale-lock recovery', { sourceId })
      }
      signal?.throwIfAborted()
      const nextLock: SourceLock = {
        workflowId,
        createdAt: new Date().toISOString(),
        pid: process.pid,
        lockToken: randomUUID(),
        headCommit: head,
        branch,
        gitConfigHash: gitSecurityHash,
      }
      if (!(await this.staleRecoveryOwnerStillOwned(sourceId, recoveryOwner.recoveryToken))) {
        throw new EvolutionError('invalid_input', 'Managed source stale-lock recovery ownership changed during publication', {
          sourceId,
        })
      }
      await writeFile(lockFile, `${JSON.stringify(nextLock, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
      published = true
      if (!(await this.staleRecoveryOwnerStillOwned(sourceId, recoveryOwner.recoveryToken))) {
        await this.releaseLockToken(sourceId, nextLock.lockToken!)
        published = false
        throw new EvolutionError('invalid_input', 'Managed source stale-lock recovery ownership changed after publication', {
          sourceId,
        })
      }
      signal?.throwIfAborted()
      await rm(quarantine, { force: true })
      quarantined = false
      await this.releaseRecoveryOwner(sourceId, recoveryOwner.recoveryToken)
      return { sourceId, workflowId, lockToken: nextLock.lockToken!, acquiredHere: true }
    } catch (error) {
      if (published) {
        if (quarantined) await rm(quarantine, { force: true }).catch(() => undefined)
        await this.releaseRecoveryOwner(sourceId, recoveryOwner.recoveryToken).catch(() => undefined)
      } else if (quarantined) {
        const restored = (await this.staleRecoveryOwnerStillOwned(sourceId, recoveryOwner.recoveryToken))
          && await writeFile(lockFile, observedLock, { encoding: 'utf8', flag: 'wx' })
            .then(async () => await this.staleRecoveryOwnerStillOwned(sourceId, recoveryOwner.recoveryToken))
            .catch(() => false)
        // If another publisher filled the handoff gap, retain the marker. That
        // publisher's post-wx marker check will roll back only its own token;
        // the resulting orphan is intentionally fail-closed.
        if (restored) {
          await rm(quarantine, { force: true }).catch(() => undefined)
          await this.releaseRecoveryOwner(sourceId, recoveryOwner.recoveryToken).catch(() => undefined)
        }
      } else {
        await this.releaseRecoveryOwner(sourceId, recoveryOwner.recoveryToken).catch(() => undefined)
      }
      throw error
    }
  }

  private async releaseRecoveryOwner(sourceId: string, recoveryToken: string): Promise<void> {
    const target = this.lockRecoveryPath(sourceId)
    try {
      const owner = JSON.parse(await readFile(target, 'utf8')) as SourceLockRecoveryOwner
      if (owner.recoveryToken !== recoveryToken) return
      await rm(target, { force: true })
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
  }

  private completionOwnerMatches(
    owner: SourceLockRecoveryOwner,
    proofHash: string,
    lockRaw: string,
    lockToken: string,
  ): boolean {
    return owner.schemaVersion === 1
      && owner.purpose === 'workflow_completion'
      && owner.completionProofHash === proofHash
      && owner.ownerLockToken === lockToken
      && owner.observedLock === lockRaw
  }

  private async optionalFile(target: string): Promise<string | undefined> {
    try {
      return await readFile(target, 'utf8')
    } catch (error) {
      if (isNotFound(error)) return undefined
      throw error
    }
  }

  private async lockPublicationBarrierExists(sourceId: string): Promise<boolean> {
    const [recoveryOwner, completionTakeover] = await Promise.all([
      this.optionalFile(this.lockRecoveryPath(sourceId)),
      this.optionalFile(this.completionRecoveryTakeoverPath(sourceId)),
    ])
    return recoveryOwner !== undefined || completionTakeover !== undefined
  }

  private async staleRecoveryOwnerStillOwned(sourceId: string, recoveryToken: string): Promise<boolean> {
    if (await this.optionalFile(this.completionRecoveryTakeoverPath(sourceId)) !== undefined) return false
    const raw = await this.optionalFile(this.lockRecoveryPath(sourceId))
    if (raw === undefined) return false
    const owner = JSON.parse(raw) as SourceLockRecoveryOwner
    return owner.purpose === undefined && owner.recoveryToken === recoveryToken
  }

  private async acquireCompletionRecoveryOwner(
    sourceId: string,
    workflowId: string,
    proofHash: string,
    lockRaw: string,
    lockToken: string,
  ): Promise<SourceLockRecoveryOwner | undefined> {
    const target = this.lockRecoveryPath(sourceId)
    const takeover = this.completionRecoveryTakeoverPath(sourceId)
    const nextOwner = (): SourceLockRecoveryOwner => ({
      schemaVersion: 1,
      recoveryToken: randomUUID(),
      workflowId,
      pid: process.pid,
      observedLock: lockRaw,
      createdAt: new Date().toISOString(),
      purpose: 'workflow_completion',
      completionProofHash: proofHash,
      ownerLockToken: lockToken,
    })
    await mkdir(path.dirname(target), { recursive: true })

    const orphanedTakeover = await this.optionalFile(takeover)
    if (orphanedTakeover !== undefined) {
      const stale = JSON.parse(orphanedTakeover) as SourceLockRecoveryOwner
      if (!this.completionOwnerMatches(stale, proofHash, lockRaw, lockToken)
        || isProcessAlive(stale.pid)) return undefined
      const owner = nextOwner()
      try {
        await writeFile(target, `${JSON.stringify(owner, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
      } catch (error) {
        if (!isAlreadyExists(error)) throw error
        return undefined
      }
      try {
        await rm(takeover, { force: true })
      } catch (error) {
        await this.releaseRecoveryOwner(sourceId, owner.recoveryToken).catch(() => undefined)
        throw error
      }
      return owner
    }

    const owner = nextOwner()
    try {
      await writeFile(target, `${JSON.stringify(owner, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
      return owner
    } catch (error) {
      if (!isAlreadyExists(error)) throw error
    }

    const observedOwnerRaw = await readFile(target, 'utf8')
    const observedOwner = JSON.parse(observedOwnerRaw) as SourceLockRecoveryOwner
    if (!this.completionOwnerMatches(observedOwner, proofHash, lockRaw, lockToken)
      || isProcessAlive(observedOwner.pid)) return undefined

    try {
      await rename(target, takeover)
    } catch (error) {
      if (isNotFound(error)) return undefined
      throw error
    }
    const moved = await readFile(takeover, 'utf8')
    if (moved !== observedOwnerRaw) {
      await writeFile(target, moved, { encoding: 'utf8', flag: 'wx' }).catch(() => undefined)
      return undefined
    }
    const replacement = nextOwner()
    try {
      await writeFile(target, `${JSON.stringify(replacement, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    } catch (error) {
      if (!isAlreadyExists(error)) throw error
      return undefined
    }
    try {
      await rm(takeover, { force: true })
    } catch (error) {
      await this.releaseRecoveryOwner(sourceId, replacement.recoveryToken).catch(() => undefined)
      throw error
    }
    return replacement
  }

  private async repositoryMatchesReceipt(receipt: SourceReceipt, signal?: AbortSignal): Promise<boolean> {
    const root = await this.assertPathContainment(receipt.sourceId)
    const status = await this.git(root, ['status', '--porcelain'], signal)
    signal?.throwIfAborted()
    const head = await this.git(root, ['rev-parse', 'HEAD'], signal)
    signal?.throwIfAborted()
    const branch = await this.git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], signal)
    signal?.throwIfAborted()
    const gitSecurityHash = await this.gitConfigHash(receipt.sourceId)
    signal?.throwIfAborted()
    return status === ''
      && head === receipt.headCommit
      && branch === receipt.branch
      && gitSecurityHash === receipt.gitConfigHash
  }

  private async convergeWorkflowCompletion(
    receipt: SourceReceipt,
  ): Promise<SourceReceipt | undefined> {
    const validated = validatedCompletionProof(receipt)
    if (!validated) return undefined
    const lockFile = this.lockPath(receipt.sourceId)
    const recoveryFile = this.lockRecoveryPath(receipt.sourceId)
    let lockRaw = await this.optionalFile(lockFile)
    if (lockRaw === undefined) {
      const markerRaw = await this.optionalFile(recoveryFile)
        ?? await this.optionalFile(this.completionRecoveryTakeoverPath(receipt.sourceId))
      if (markerRaw === undefined) return receipt
      let marker: SourceLockRecoveryOwner
      try {
        marker = JSON.parse(markerRaw) as SourceLockRecoveryOwner
      } catch {
        return undefined
      }
      if (!marker.observedLock) return undefined
      lockRaw = marker.observedLock
    }
    let lock: SourceLock
    try {
      lock = JSON.parse(lockRaw) as SourceLock
    } catch {
      return undefined
    }
    if (!lockMatchesCompletion(lock, validated.proof, receipt)) return undefined
    const owner = await this.acquireCompletionRecoveryOwner(
      receipt.sourceId,
      validated.proof.workflowId,
      validated.proofHash,
      lockRaw,
      validated.proof.lockToken,
    )
    if (!owner) return undefined
    let markerOwned = true
    let preserveMarker = false
    const releaseMarker = async (): Promise<void> => {
      await this.releaseRecoveryOwner(receipt.sourceId, owner.recoveryToken)
      if (await this.optionalFile(recoveryFile) !== undefined) {
        preserveMarker = true
        throw new EvolutionError('invalid_input', 'Managed source completion recovery ownership changed before marker release')
      }
      markerOwned = false
    }
    try {
      const latestReceipt = await this.readReceipt(receipt.sourceId)
      const latestValidated = latestReceipt ? validatedCompletionProof(latestReceipt) : undefined
      const latestLockRaw = await this.optionalFile(lockFile)
      if (!latestReceipt
        || !latestValidated
        || latestValidated.proofHash !== validated.proofHash) return undefined
      if (latestLockRaw !== undefined && latestLockRaw !== lockRaw) {
        preserveMarker = true
        return undefined
      }
      if (!(await this.repositoryMatchesReceipt(latestReceipt))) return undefined

      try {
        await this.releaseLockToken(receipt.sourceId, validated.proof.lockToken)
      } catch (deleteError) {
        let remainingAfterError: string | undefined
        try {
          remainingAfterError = await readFile(lockFile, 'utf8')
        } catch (readError) {
          if (!isNotFound(readError)) {
            preserveMarker = true
            throw new EvolutionError('invalid_input', 'Managed source completion lock became unreadable after delete failure')
          }
        }
        if (remainingAfterError === undefined) {
          await releaseMarker()
          return latestReceipt
        }
        if (remainingAfterError === lockRaw) {
          await releaseMarker()
          throw deleteError
        }
        preserveMarker = true
        throw new EvolutionError('invalid_input', 'Managed source completion lock changed after delete failure; recovery remains sealed')
      }

      let remainingLock: string | undefined
      try {
        remainingLock = await readFile(lockFile, 'utf8')
      } catch (error) {
        if (!isNotFound(error)) {
          preserveMarker = true
          throw new EvolutionError('invalid_input', 'Managed source completion lock became unreadable after deletion')
        }
      }
      if (remainingLock === lockRaw) {
        await releaseMarker()
        throw new EvolutionError('command_failed', 'Managed source completion could not remove its exact workflow lock')
      }
      if (remainingLock !== undefined) {
        preserveMarker = true
        return undefined
      }
      await releaseMarker()
      return latestReceipt
    } finally {
      if (markerOwned && !preserveMarker) {
        await this.releaseRecoveryOwner(receipt.sourceId, owner.recoveryToken).catch(() => undefined)
      }
    }
  }

  private async releaseLockToken(sourceId: string, lockToken: string): Promise<void> {
    const target = this.lockPath(sourceId)
    try {
      const lock = JSON.parse(await readFile(target, 'utf8')) as SourceLock
      if (lock.lockToken !== lockToken) return
      await this.removeOwnedLockPath(sourceId)
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
  }

  private async removeOwnedLockPath(sourceId: string): Promise<void> {
    await rm(this.lockPath(sourceId), { force: true })
  }

  private async bindOwnedLockLineage(
    sourceId: string,
    workflowId: string,
    lineage: { headCommit: string; branch: string; gitConfigHash: string },
    signal?: AbortSignal,
    expectedLockToken?: string,
  ): Promise<void> {
    signal?.throwIfAborted()
    if (await this.lockPublicationBarrierExists(sourceId)) {
      throw new EvolutionError('invalid_input', 'Managed source lock publication is blocked by recovery ownership')
    }
    const target = this.lockPath(sourceId)
    const current = JSON.parse(await readFile(target, 'utf8')) as SourceLock
    if (current.workflowId !== workflowId || current.pid !== process.pid || !current.lockToken
      || (expectedLockToken !== undefined && current.lockToken !== expectedLockToken)) {
      throw new EvolutionError('invalid_input', 'Managed source lock ownership changed before lineage publication')
    }
    const next: SourceLock = { ...current, ...lineage }
    const temporary = `${target}.${current.lockToken}.tmp`
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    try {
      signal?.throwIfAborted()
      const latest = JSON.parse(await readFile(target, 'utf8')) as SourceLock
      if (latest.lockToken !== current.lockToken
        || (expectedLockToken !== undefined && latest.lockToken !== expectedLockToken)) {
        throw new EvolutionError('invalid_input', 'Managed source lock ownership changed before lineage publication')
      }
      if (await this.lockPublicationBarrierExists(sourceId)) {
        throw new EvolutionError('invalid_input', 'Managed source lock publication is blocked by recovery ownership')
      }
      await rename(temporary, target)
      if (await this.lockPublicationBarrierExists(sourceId)) {
        throw new EvolutionError('invalid_input', 'Managed source lock recovery started during lineage publication')
      }
      signal?.throwIfAborted()
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  async completeWorkflow(sourceId: string, workflowId: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const receipt = await this.readReceipt(sourceId)
    if (!receipt) return
    if (receipt.activeWorkflowId === null) {
      if (!receipt.completionProof) return
      const completed = await this.convergeWorkflowCompletion(receipt)
      if (!completed) {
        throw new EvolutionError('invalid_input', 'Managed source workflow completion proof failed closed validation')
      }
      if (signal?.aborted) throw signal.reason
      return
    }
    if (receipt.activeWorkflowId !== workflowId || receipt.completionProof) return
    const lockFile = this.lockPath(sourceId)
    const lockRaw = await readFile(lockFile, 'utf8')
    const lock = JSON.parse(lockRaw) as SourceLock
    if (!lock.lockToken
      || lock.workflowId !== workflowId
      || lock.headCommit !== receipt.headCommit
      || lock.branch !== receipt.branch
      || lock.gitConfigHash !== receipt.gitConfigHash) {
      throw new EvolutionError('invalid_input', 'Managed source workflow completion lock failed exact lineage validation')
    }
    if (!(await this.repositoryMatchesReceipt(receipt, signal))) {
      throw new EvolutionError('review_rejected', 'Managed source cannot release its workflow lock because final repository state changed')
    }
    signal?.throwIfAborted()
    const latestReceipt = await this.readReceipt(sourceId)
    const latestLockRaw = await readFile(lockFile, 'utf8')
    if (!latestReceipt
      || hashObject(latestReceipt) !== hashObject(receipt)
      || latestLockRaw !== lockRaw
      || await this.optionalFile(this.lockRecoveryPath(sourceId)) !== undefined) {
      throw new EvolutionError('invalid_input', 'Managed source workflow completion authority changed before commit')
    }
    signal?.throwIfAborted()
    const completionProof: SourceCompletionProof = {
      schemaVersion: 1,
      workflowId,
      lockToken: lock.lockToken,
      activeReceiptHash: hashObject(receipt),
    }
    const completedReceipt: SourceReceipt = {
      ...receipt,
      activeWorkflowId: null,
      completionProof,
    }
    await this.writeReceipt(completedReceipt)
    const completed = await this.convergeWorkflowCompletion(completedReceipt)
    if (!completed) {
      throw new EvolutionError('invalid_input', 'Managed source workflow completion did not converge')
    }
    if (signal?.aborted) throw signal.reason
  }

  async assertCleanTree(sourceId: string, signal?: AbortSignal, workspaceCwd?: string): Promise<void> {
    const root = await this.assertPathContainment(sourceId, workspaceCwd)
    const status = await this.git(root, ['status', '--porcelain'], signal)
    if (status) {
      throw new EvolutionError('invalid_input', 'Managed source working tree is dirty; refusing to continue', {
        sourceId,
      })
    }
  }

  async assertPathContainment(sourceId: string, workspaceCwd?: string): Promise<string> {
    const receipt = await this.readReceipt(sourceId)
    const root = this.resolveWorkingPath(sourceId, workspaceCwd, receipt)
    await access(root, constants.F_OK)
    const info = await lstat(root)
    if (info.isSymbolicLink()) {
      throw new EvolutionError('unsafe_path', 'Managed source root must not be a symlink', { sourceId })
    }
    const resolved = await realpath(root)
    if (!(await this.isCanonicalManagedSourceDir(resolved, sourceId))) {
      throw new EvolutionError('unsafe_path', 'Managed source realpath escaped sourceDir', { sourceId, resolved })
    }
    if (receipt && await canonicalPath(receipt.path) !== resolved) {
      const relocating = Boolean(workspaceCwd || this.config.sourceDir)
        && await canonicalPath(this.sourcePath(sourceId, workspaceCwd)) === resolved
      if (!relocating) {
        throw new EvolutionError('unsafe_path', 'Managed source realpath does not match the Host receipt', { sourceId, resolved })
      }
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
      'cordis.patch.yml': `- insert:\n    - id: ${safeName.replace(/^@[^/]+\//u, '').replace(/[^\w-]+/gu, '-')}\n      name: ${safeName}\n`,
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
    workspaceCwd?: string
    signal?: AbortSignal
  }): Promise<SourceReceipt> {
    const sourceId = sourceIdForCreate(input.resolutionId)
    input.signal?.throwIfAborted()
    await this.ensureWorkspaceLayout(input.workspaceCwd)
    input.signal?.throwIfAborted()
    const lock = await this.acquireLockInternal(sourceId, input.workflowId, input.signal, input.workspaceCwd)
    let receiptActivated = false
    try {
      const root = this.sourcePath(sourceId, input.workspaceCwd)
      if (await this.hasGitDirectory(path.join(root, '.git'), input.signal)) {
        throw new EvolutionError('invalid_input', 'Managed create source already exists; refusing to overwrite', {
          sourceId,
        })
      }
      input.signal?.throwIfAborted()
      await mkdir(path.join(root, 'lib'), { recursive: true })
      input.signal?.throwIfAborted()
      await this.git(root, ['init'], input.signal)
      input.signal?.throwIfAborted()
      await this.ensureHostSourceExcludes(root)
      const branch = `autoevo/${input.workflowId}`
      input.signal?.throwIfAborted()
      await this.git(root, ['checkout', '-B', branch], input.signal)
      const files = SourceManager.trustedScaffoldFiles(input.packageName ?? `dsh-plugin-${sourceId.slice(-8)}`)
      for (const [relative, body] of Object.entries(files)) {
        const absolute = path.join(root, relative)
        if (!isPathInside(root, absolute)) {
          throw new EvolutionError('unsafe_path', 'Scaffold path escaped managed source', { relative })
        }
        input.signal?.throwIfAborted()
        await mkdir(path.dirname(absolute), { recursive: true })
        input.signal?.throwIfAborted()
        await writeFile(absolute, body, 'utf8')
      }
      input.signal?.throwIfAborted()
      const headCommit = await this.createHooklessCommit({
        sourceId,
        message: 'chore: trusted AutoEvo plugin scaffold',
        ...(input.workspaceCwd ? { workspaceCwd: input.workspaceCwd } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      })
      const resolved = await this.assertPathContainment(sourceId, input.workspaceCwd)
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
        gitConfigHash: await this.gitConfigHash(sourceId, input.workspaceCwd),
      }
      await this.bindOwnedLockLineage(sourceId, input.workflowId, {
        headCommit,
        branch,
        gitConfigHash: receipt.gitConfigHash,
      }, input.signal, lock.lockToken)
      input.signal?.throwIfAborted()
      await this.writeReceipt(receipt)
      receiptActivated = true
      input.signal?.throwIfAborted()
      return receipt
    } catch (error) {
      if (!receiptActivated && lock.acquiredHere) await this.releaseLockToken(sourceId, lock.lockToken).catch(() => undefined)
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
    workspaceCwd?: string
    signal?: AbortSignal
  }): Promise<SourceReceipt> {
    if (input.review.sourceSnapshot.kind !== 'github') {
      throw new EvolutionError('invalid_input', 'Only GitHub reviews can materialize a managed modify source')
    }
    const repository = input.review.sourceSnapshot.repository
    const commit = input.review.sourceSnapshot.commit
    const packagePath = normalizePackagePath(input.review.sourceSnapshot.packagePath)
    const sourceId = sourceIdForRepository(repository, packagePath)
    input.signal?.throwIfAborted()
    await this.ensureWorkspaceLayout(input.workspaceCwd)
    input.signal?.throwIfAborted()
    const lock = await this.acquireLockInternal(sourceId, input.workflowId, input.signal, input.workspaceCwd)
    let receiptActivated = false
    try {
      const root = this.sourcePath(sourceId, input.workspaceCwd)
      if (!(await this.hasGitDirectory(path.join(root, '.git'), input.signal))) {
        input.signal?.throwIfAborted()
        await mkdir(root, { recursive: true })
        input.signal?.throwIfAborted()
        await this.git(root, ['init'], input.signal)
        input.signal?.throwIfAborted()
        await this.git(root, ['remote', 'add', 'origin', `https://github.com/${repository}.git`], input.signal)
      }
      input.signal?.throwIfAborted()
      await this.ensureHostSourceExcludes(root)
      input.signal?.throwIfAborted()
      await this.git(root, ['fetch', '--depth=1', 'origin', commit], input.signal)
      const branch = `autoevo/${input.workflowId}`
      input.signal?.throwIfAborted()
      await this.git(root, ['checkout', '-B', branch, commit], input.signal)
      input.signal?.throwIfAborted()
      await this.assertCleanTree(sourceId, input.signal, input.workspaceCwd)
      input.signal?.throwIfAborted()
      const headCommit = await this.git(root, ['rev-parse', 'HEAD'], input.signal)
      input.signal?.throwIfAborted()
      if (headCommit.toLowerCase() !== commit.toLowerCase()) {
        throw new EvolutionError('review_rejected', 'Managed source HEAD does not match the reviewed commit', {
          expected: commit,
          actual: headCommit,
        })
      }
      const resolved = await this.assertPathContainment(sourceId, input.workspaceCwd)
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
        gitConfigHash: await this.gitConfigHash(sourceId, input.workspaceCwd),
        ...(packagePath ? { packagePath } : {}),
      }
      await this.bindOwnedLockLineage(sourceId, input.workflowId, {
        headCommit,
        branch,
        gitConfigHash: receipt.gitConfigHash,
      }, input.signal, lock.lockToken)
      input.signal?.throwIfAborted()
      await this.writeReceipt(receipt)
      receiptActivated = true
      input.signal?.throwIfAborted()
      return receipt
    } catch (error) {
      if (!receiptActivated && lock.acquiredHere) await this.releaseLockToken(sourceId, lock.lockToken).catch(() => undefined)
      throw error
    }
  }

  async createHooklessCommit(input: {
    sourceId: string
    message: string
    workspaceCwd?: string
    signal?: AbortSignal
  }): Promise<string> {
    const receipt = await this.readReceipt(input.sourceId)
    const root = receipt
      ? await this.assertPathContainment(input.sourceId)
      : this.sourcePath(input.sourceId, input.workspaceCwd)
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
    await this.assertCleanTree(input.sourceId, input.signal, input.workspaceCwd)
    return this.git(root, ['rev-parse', 'HEAD'], input.signal)
  }

  async finalizeChildCommit(input: {
    sourceId: string
    workflowId: string
    reviewId: string
    message: string
    signal?: AbortSignal
  }): Promise<FinalizedChildCommit> {
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
    const changedOutput = await this.git(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', headCommit], input.signal)
    const allChangedFiles = changedOutput.split('\0').filter(Boolean).sort((left, right) => left.localeCompare(right))
    const next: SourceReceipt = {
      ...receipt,
      headCommit,
      reviewId: input.reviewId,
      artifactHash: null,
    }
    await this.bindOwnedLockLineage(input.sourceId, input.workflowId, {
      headCommit,
      branch,
      gitConfigHash: next.gitConfigHash,
    }, input.signal)
    await this.writeReceipt(next)
    return {
      ...next,
      changedFiles: allChangedFiles,
      changedFilesTruncated: false,
    }
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

  async inspectCompletedSource(sourceId: string, signal?: AbortSignal): Promise<SourceReceipt | undefined> {
    signal?.throwIfAborted()
    let receipt = await this.readReceipt(sourceId)
    if (!receipt || receipt.activeWorkflowId) return undefined
    if (receipt.completionProof) {
      const completed = await this.convergeWorkflowCompletion(receipt)
      if (!completed) return undefined
      receipt = completed
      if (signal?.aborted) throw signal.reason
    }
    const lockFile = this.lockPath(sourceId)
    try {
      await readFile(lockFile, 'utf8')
      // A completed/null receipt plus any surviving lock is an ambiguous
      // pre-claim crash. Automatic takeover cannot prove a safe CAS on the
      // lock pathname, so keep this state fail-closed.
      return undefined
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
    const root = await this.assertPathContainment(sourceId)
    const status = await this.git(root, ['status', '--porcelain'], signal)
    signal?.throwIfAborted()
    const head = await this.git(root, ['rev-parse', 'HEAD'], signal)
    signal?.throwIfAborted()
    const branch = await this.git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], signal)
    signal?.throwIfAborted()
    const gitSecurityHash = await this.gitConfigHash(sourceId)
    signal?.throwIfAborted()
    if (status || head !== receipt.headCommit || branch !== receipt.branch || gitSecurityHash !== receipt.gitConfigHash) {
      return undefined
    }
    return receipt
  }

  async claimCompletedSourceForWorkflow(
    sourceId: string,
    workflowId: string,
    signal?: AbortSignal,
  ): Promise<SourceReceipt> {
    signal?.throwIfAborted()
    const inspected = await this.inspectCompletedSource(sourceId, signal)
    if (!inspected) {
      throw new EvolutionError('invalid_input', 'Completed managed source is missing, locked, dirty, or drifted')
    }
    const root = await this.assertPathContainment(sourceId)
    const status = await this.git(root, ['status', '--porcelain'], signal)
    signal?.throwIfAborted()
    const headCommit = await this.git(root, ['rev-parse', 'HEAD'], signal)
    signal?.throwIfAborted()
    const branch = await this.git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], signal)
    signal?.throwIfAborted()
    const gitConfigHash = await this.gitConfigHash(sourceId)
    signal?.throwIfAborted()
    if (status !== ''
      || headCommit !== inspected.headCommit
      || branch !== inspected.branch
      || gitConfigHash !== inspected.gitConfigHash) {
      throw new EvolutionError('invalid_input', 'Completed managed source changed before lock publication')
    }

    const lock: SourceLock = {
      workflowId,
      createdAt: new Date().toISOString(),
      pid: process.pid,
      lockToken: randomUUID(),
      headCommit,
      branch,
      gitConfigHash,
    }
    const lockFile = this.lockPath(sourceId)
    if (await this.lockPublicationBarrierExists(sourceId)) {
      throw new EvolutionError('invalid_input', 'Managed source lock recovery is already owned; refusing completed-source claim')
    }
    signal?.throwIfAborted()
    try {
      await writeFile(lockFile, `${JSON.stringify(lock, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    } catch (error) {
      if (isAlreadyExists(error)) {
        throw new EvolutionError('invalid_input', 'Completed managed source was claimed concurrently')
      }
      throw error
    }
    if (await this.lockPublicationBarrierExists(sourceId)) {
      await this.releaseLockToken(sourceId, lock.lockToken!)
      throw new EvolutionError('invalid_input', 'Managed source lock recovery started during completed-source claim')
    }

    let receiptActivated = false
    try {
      signal?.throwIfAborted()
      const latestReceipt = await this.readReceipt(sourceId)
      signal?.throwIfAborted()
      if (!latestReceipt
        || latestReceipt.activeWorkflowId !== null
        || JSON.stringify(latestReceipt) !== JSON.stringify(inspected)) {
        throw new EvolutionError('invalid_input', 'Completed managed source receipt changed during claim')
      }
      const lockedStatus = await this.git(root, ['status', '--porcelain'], signal)
      signal?.throwIfAborted()
      const lockedHead = await this.git(root, ['rev-parse', 'HEAD'], signal)
      signal?.throwIfAborted()
      const lockedBranch = await this.git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], signal)
      signal?.throwIfAborted()
      const lockedConfigHash = await this.gitConfigHash(sourceId)
      signal?.throwIfAborted()
      if (lockedStatus !== ''
        || lockedHead !== headCommit
        || lockedBranch !== branch
        || lockedConfigHash !== gitConfigHash) {
        throw new EvolutionError('invalid_input', 'Completed managed source changed while its claim lock was held')
      }
      const persistedLock = JSON.parse(await readFile(lockFile, 'utf8')) as SourceLock
      if (persistedLock.lockToken !== lock.lockToken) {
        throw new EvolutionError('invalid_input', 'Completed managed source claim lock changed before receipt activation')
      }
      signal?.throwIfAborted()
      const next: SourceReceipt = { ...inspected, activeWorkflowId: workflowId }
      delete next.completionProof
      await this.writeReceipt(next)
      receiptActivated = true
      signal?.throwIfAborted()
      return next
    } catch (error) {
      if (!receiptActivated) await this.releaseLockToken(sourceId, lock.lockToken!).catch(() => undefined)
      throw error
    }
  }

  /** Re-enter an already-owned managed source without resetting its lineage. */
  async resumeWorkflowSource(sourceId: string, workflowId: string, signal?: AbortSignal): Promise<SourceReceipt> {
    const receipt = await this.readReceipt(sourceId)
    if (!receipt || receipt.activeWorkflowId !== workflowId) {
      throw new EvolutionError('invalid_input', 'Managed source is not owned by this workflow')
    }
    // A normal Host restart changes the process id while the workflow and its
    // clean managed source remain the same. Reuse the existing lightweight
    // stale-lock revalidation so the same workflow can continue without
    // inventing a second recovery state or asking the user to start over.
    const handle = await this.acquireLockInternal(sourceId, workflowId, signal, undefined, true)
    const lock = JSON.parse(await readFile(this.lockPath(sourceId), 'utf8')) as SourceLock
    if (lock.workflowId !== workflowId || lock.pid !== process.pid || lock.lockToken !== handle.lockToken) {
      throw new EvolutionError('invalid_input', 'Managed source lock is not owned by this workflow instance')
    }
    const root = await this.assertPathContainment(sourceId)
    // Sources created before host-managed excludes existed gain them on resume,
    // so a child install of declared dependencies stays commit-safe.
    await this.ensureHostSourceExcludes(root)
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
  sourceIdForRepository,
  sourceIdForCreate,
  hashObject,
  forbiddenUntrackedPath,
}
