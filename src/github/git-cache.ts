import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { RuntimeConfig } from '../config.js'
import { EvolutionError } from '../errors.js'
import { commandResultFailure, type CommandRunner } from '../process/runner.js'
import { ensureAutoEvoGitignore, WORKSPACE_GIT_CACHE_DIR } from '../workspace-layout.js'
import { validateGithubRepository } from './discovery.js'

interface CacheOptions {
  runner: CommandRunner
  config: Pick<RuntimeConfig, 'gitCommand' | 'commandTimeoutMs'>
  cacheRoot: string
  /** Canonical authority boundary for workspace-owned cache writes. */
  workspaceRoot?: string
  repository: string
  commit: string
  signal?: AbortSignal
}

export interface CachedGithubRepository {
  repository: string
  commit: string
  gitDir: string
  git(args: readonly string[], cwd?: string): Promise<string>
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
}

function cacheKey(repository: string): string {
  return createHash('sha256').update(repository.toLowerCase()).digest('hex')
}

export function gitTransportArgs(platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'win32' ? ['-c', 'http.sslBackend=openssl'] : []
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EPERM')
  }
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason)
    }, { once: true })
  })
}

interface LockOwner {
  pid?: number
  createdAt?: string
  lockToken?: string
}

interface RecoveryOwner {
  recoveryToken: string
  observedOwner: string | null
  observedPublisher: string | null
  createdAt: string
}

interface LockTesting {
  token?: () => string
  processAlive?: (pid: number) => boolean
  beforeOwnerWrite?: () => Promise<void>
  afterOwnerFileWrite?: () => Promise<void>
  afterOwnerWrite?: () => Promise<void>
  beforeRecoveryMarker?: () => Promise<void>
  afterQuarantineRename?: (quarantine: string) => Promise<void>
}

class LockBusyError extends Error {}

function lockRecoveryPath(lockPath: string): string {
  return `${lockPath}.recovery`
}

function lockQuarantinePath(lockPath: string, token: string): string {
  return `${lockPath}.${token}.stale`
}

function publisherPath(lockPath: string): string {
  return path.join(lockPath, 'publisher.json')
}

function retryableBusy(): EvolutionError {
  return new EvolutionError('command_failed', 'Workspace Git cache is busy; retry the review', { retryable: true })
}

async function readText(target: string): Promise<string | undefined> {
  return await readFile(target, 'utf8').catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  })
}

async function readRecovery(lockPath: string): Promise<RecoveryOwner | undefined> {
  const body = await readText(lockRecoveryPath(lockPath))
  if (body === undefined) return undefined
  try {
    const marker = JSON.parse(body) as RecoveryOwner
    if (typeof marker.recoveryToken !== 'string'
      || (marker.observedOwner !== null && typeof marker.observedOwner !== 'string')
      || (marker.observedPublisher !== null && typeof marker.observedPublisher !== 'string')) throw new Error('invalid')
    return marker
  } catch {
    throw new EvolutionError('command_failed', 'Workspace Git cache recovery marker is ambiguous; refusing cache takeover', { retryable: true })
  }
}

async function assertRecovery(lockPath: string, expectedToken?: string): Promise<void> {
  const marker = await readRecovery(lockPath)
  if (!expectedToken && !marker) return
  if (expectedToken && marker?.recoveryToken === expectedToken) return
  if (marker) throw new LockBusyError()
  throw new EvolutionError('command_failed', 'Workspace Git cache recovery marker changed during publication', { retryable: true })
}

async function releaseRecovery(lockPath: string, token: string): Promise<void> {
  const marker = await readRecovery(lockPath)
  if (marker?.recoveryToken === token) await rm(lockRecoveryPath(lockPath), { force: true })
}

async function releaseLockToken(lockPath: string, token: string): Promise<void> {
  const body = await readText(path.join(lockPath, 'owner.json'))
  if (body === undefined) return
  try {
    if ((JSON.parse(body) as LockOwner).lockToken !== token) return
    if ((JSON.parse(await readFile(publisherPath(lockPath), 'utf8')) as LockOwner).lockToken !== token) return
  } catch {
    return
  }
  await rm(lockPath, { recursive: true, force: true })
}

async function removeNakedLock(lockPath: string, token: string): Promise<void> {
  try {
    if ((JSON.parse(await readFile(publisherPath(lockPath), 'utf8')) as LockOwner).lockToken !== token) return
    const owner = await readText(path.join(lockPath, 'owner.json'))
    if (owner !== undefined && (JSON.parse(owner) as LockOwner).lockToken !== token) return
  } catch {
    return
  }
  await rm(lockPath, { recursive: true, force: true })
}

async function publishLock(lockPath: string, recoveryToken: string | undefined, testing: LockTesting): Promise<() => Promise<void>> {
  await assertRecovery(lockPath, recoveryToken)
  await mkdir(lockPath)
  const token = (testing.token ?? randomUUID)()
  let published = false
  try {
    await writeFile(publisherPath(lockPath), `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), lockToken: token })}\n`, { encoding: 'utf8', flag: 'wx' })
    await testing.beforeOwnerWrite?.()
    await assertRecovery(lockPath, recoveryToken)
    if ((JSON.parse(await readFile(publisherPath(lockPath), 'utf8')) as LockOwner).lockToken !== token) {
      throw new EvolutionError('command_failed', 'Workspace Git cache publisher generation changed before owner publication', { retryable: true })
    }
    await writeFile(path.join(lockPath, 'owner.json'), `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), lockToken: token })}\n`, { encoding: 'utf8', flag: 'wx' })
    await testing.afterOwnerFileWrite?.()
    published = true
    await testing.afterOwnerWrite?.()
    await assertRecovery(lockPath, recoveryToken)
    return async () => await releaseLockToken(lockPath, token)
  } catch (error) {
    if (published) await releaseLockToken(lockPath, token).catch(() => undefined)
    else await removeNakedLock(lockPath, token).catch(() => undefined)
    throw error
  }
}

async function observeLock(lockPath: string): Promise<{ owner: string | null; publisher: string | null }> {
  return {
    owner: (await readText(path.join(lockPath, 'owner.json'))) ?? null,
    publisher: (await readText(publisherPath(lockPath))) ?? null,
  }
}

async function recoverStaleLock(lockPath: string, observed: { owner: string | null; publisher: string | null }, testing: LockTesting, signal?: AbortSignal): Promise<() => Promise<void>> {
  signal?.throwIfAborted()
  await testing.beforeRecoveryMarker?.()
  signal?.throwIfAborted()
  const recoveryToken = (testing.token ?? randomUUID)()
  const recoveryPath = lockRecoveryPath(lockPath)
  const recovery: RecoveryOwner = { recoveryToken, observedOwner: observed.owner, observedPublisher: observed.publisher, createdAt: new Date().toISOString() }
  try {
    await writeFile(recoveryPath, `${JSON.stringify(recovery)}\n`, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') throw new LockBusyError()
    throw error
  }
  let quarantined = false
  const quarantine = lockQuarantinePath(lockPath, (testing.token ?? randomUUID)())
  try {
    if (await lstat(quarantine).then(() => true).catch((error: unknown) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false
      throw error
    })) {
      throw new EvolutionError('command_failed', 'Workspace Git cache stale-lock quarantine collision; refusing takeover', { retryable: true })
    }
    const latest = await observeLock(lockPath)
    if (latest.owner !== observed.owner || latest.publisher !== observed.publisher) {
      throw new EvolutionError('command_failed', 'Workspace Git cache lock changed during stale recovery', { retryable: true })
    }
    signal?.throwIfAborted()
    await rename(lockPath, quarantine)
    quarantined = true
    await testing.afterQuarantineRename?.(quarantine)
    const quarantinedObservation = await observeLock(quarantine)
    if (quarantinedObservation.owner !== observed.owner || quarantinedObservation.publisher !== observed.publisher) {
      throw new EvolutionError('command_failed', 'Workspace Git cache quarantine mismatch; refusing takeover', { retryable: true })
    }
    signal?.throwIfAborted()
    const release = await publishLock(lockPath, recoveryToken, testing)
    await rm(quarantine, { recursive: true, force: true })
    quarantined = false
    await releaseRecovery(lockPath, recoveryToken)
    return release
  } catch (error) {
    if (!quarantined) await releaseRecovery(lockPath, recoveryToken).catch(() => undefined)
    throw error
  }
}

async function acquireLock(lockPath: string, timeoutMs: number, signal?: AbortSignal, testing: LockTesting = {}): Promise<() => Promise<void>> {
  const started = Date.now()
  while (true) {
    signal?.throwIfAborted()
    try {
      return await publishLock(lockPath, undefined, testing)
    } catch (error) {
      if (error instanceof LockBusyError) {
        // A recovery owner is publishing or quarantining the stale lock.
      } else if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error
    }
    const observed = await observeLock(lockPath)
    const holderBody = observed.owner ?? observed.publisher
    const owner = holderBody === null ? undefined : (() => {
      try { return JSON.parse(holderBody) as LockOwner } catch { return undefined }
    })()
    const age = await stat(lockPath).then((item) => Date.now() - item.mtimeMs).catch(() => 0)
    if ((!owner?.pid || !(testing.processAlive ?? processAlive)(owner.pid)) && age > Math.max(5_000, timeoutMs)) {
      try {
        return await recoverStaleLock(lockPath, observed, testing, signal)
      } catch (error) {
        if (!(error instanceof LockBusyError)) throw error
      }
    }
    if (Date.now() - started >= timeoutMs) {
      throw retryableBusy()
    }
    await delay(50, signal)
  }
}

export const _testing = {
  acquireLock,
  runWithRelease,
  gitCacheDirectoryExists,
  ensureGitCacheDirectory,
}

async function runWithRelease<T>(
  operation: () => Promise<T>,
  release: () => Promise<void>,
): Promise<T> {
  let result: T
  try {
    result = await operation()
  } catch (error) {
    await release().catch(() => undefined)
    throw error
  }
  await release()
  return result
}

type DirectoryProbe = (candidate: string) => Promise<{ isDirectory(): boolean }>

async function gitCacheDirectoryExists(
  candidate: string,
  signal?: AbortSignal,
  probe: DirectoryProbe = async (target) => await stat(target),
): Promise<boolean> {
  signal?.throwIfAborted()
  try {
    const info = await probe(candidate)
    signal?.throwIfAborted()
    if (!info.isDirectory()) {
      throw new EvolutionError('review_rejected', 'Workspace Git cache repository path is not a directory')
    }
    return true
  } catch (error) {
    if (signal?.aborted) throw signal.reason
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

async function ensureGitCacheDirectory(
  candidate: string,
  initialize: () => Promise<void>,
  signal?: AbortSignal,
  probe?: DirectoryProbe,
): Promise<void> {
  const exists = await gitCacheDirectoryExists(candidate, signal, probe)
  signal?.throwIfAborted()
  if (exists) return
  signal?.throwIfAborted()
  await initialize()
  signal?.throwIfAborted()
}

async function runChecked(
  runner: CommandRunner,
  argv: [string, ...string[]],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const result = await runner.run({
    argv,
    cwd,
    env: {
      GIT_CONFIG_COUNT: '0',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_ATTR_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'Never',
    },
    timeoutMs: Math.max(timeoutMs, 120_000),
    ...(signal ? { signal } : {}),
  })
  if (result.exitCode !== 0) {
    throw commandResultFailure(argv[0], result)
  }
  return result.stdout
}

export function normalizePackagePath(value: string | undefined): string {
  if (!value) return ''
  if (value.includes('\\') || value.includes('\0') || value.includes(':')
    || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new EvolutionError('unsafe_path', 'GitHub package path must be a safe repository-relative path')
  }
  const parts = value.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new EvolutionError('unsafe_path', 'GitHub package path must be a safe repository-relative path')
  }
  return parts.join('/')
}

/** Hold the repository lock while reading or materializing one exact cached commit. */
export async function withCachedGithubRepository<T>(
  options: CacheOptions,
  use: (repository: CachedGithubRepository) => Promise<T>,
): Promise<T> {
  const repository = validateGithubRepository(options.repository)
  if (!/^[a-f0-9]{40}$/iu.test(options.commit)) {
    throw new EvolutionError('invalid_input', 'GitHub cache requires an exact 40-character commit')
  }
  const cacheRoot = path.resolve(options.cacheRoot)
  let resolvedRoot: string
  if (options.workspaceRoot) {
    const workspaceRoot = await realpath(options.workspaceRoot)
    const lexicalWorkspace = path.resolve(options.workspaceRoot)
    const expectedRoot = path.join(lexicalWorkspace, WORKSPACE_GIT_CACHE_DIR)
    if (expectedRoot !== cacheRoot) {
      throw new EvolutionError('unsafe_path', 'Workspace Git cache escaped the current workspace')
    }
    let component = lexicalWorkspace
    for (const segment of WORKSPACE_GIT_CACHE_DIR.split(path.sep)) {
      component = path.join(component, segment)
      const info = await lstat(component).catch((error: unknown) => {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined
        throw error
      })
      if (!info) await mkdir(component)
      const current = info ?? await lstat(component)
      const resolvedComponent = await realpath(component)
      if (!current.isDirectory() || current.isSymbolicLink() || !inside(workspaceRoot, resolvedComponent)) {
        throw new EvolutionError('unsafe_path', 'Workspace Git cache contains a redirected path component')
      }
    }
    resolvedRoot = await realpath(cacheRoot)
  } else {
    await mkdir(cacheRoot, { recursive: true })
    resolvedRoot = await realpath(cacheRoot)
  }
  await ensureAutoEvoGitignore(path.resolve(resolvedRoot, '..', '..'))
  const gitDir = path.join(resolvedRoot, `${cacheKey(repository)}.git`)
  const lockPath = path.join(resolvedRoot, `${cacheKey(repository)}.lock`)
  if (!inside(resolvedRoot, gitDir) || !inside(resolvedRoot, lockPath)) {
    throw new EvolutionError('unsafe_path', 'Git cache path escaped the workspace cache root')
  }
  const release = await acquireLock(lockPath, Math.max(options.config.commandTimeoutMs, 30_000), options.signal)
  return await runWithRelease(async () => {
    const git = options.config.gitCommand
    const hooks = path.join(resolvedRoot, 'empty-hooks')
    await mkdir(hooks, { recursive: true })
    const hooksInfo = await lstat(hooks)
    const resolvedHooks = await realpath(hooks)
    if (!hooksInfo.isDirectory() || hooksInfo.isSymbolicLink() || !inside(resolvedRoot, resolvedHooks)
      || (await readdir(resolvedHooks)).length > 0) {
      throw new EvolutionError('review_rejected', 'Workspace Git cache hooks guard was modified')
    }
    // Git for Windows defaults to Schannel when its system config is disabled.
    // In non-interactive Desktop processes that can fail even for public HTTPS
    // remotes with SEC_E_NO_CREDENTIALS. Select Git's bundled OpenSSL backend
    // explicitly while keeping global/system config and credentials isolated.
    const transport = gitTransportArgs()
    const base = [git, ...transport, '-c', `core.hooksPath=${hooks}`, '--git-dir', gitDir] as [string, ...string[]]
    const call = async (args: readonly string[], cwd = resolvedRoot): Promise<string> => await runChecked(
      options.runner,
      [...base, ...args] as [string, ...string[]],
      cwd,
      options.config.commandTimeoutMs,
      options.signal,
    )
    await ensureGitCacheDirectory(
      gitDir,
      async () => {
        await runChecked(options.runner, [git, 'init', '--bare', gitDir], resolvedRoot, options.config.commandTimeoutMs, options.signal)
      },
      options.signal,
    )
    const resolvedGitDir = await realpath(gitDir)
    if (!inside(resolvedRoot, resolvedGitDir)) throw new EvolutionError('unsafe_path', 'Git cache repository escaped the workspace cache root')
    if ((await call(['rev-parse', '--is-bare-repository'])).trim() !== 'true') {
      throw new EvolutionError('review_rejected', 'Workspace Git cache is not a bare repository')
    }
    const expectedOrigin = `https://github.com/${repository}.git`
    const origin = await call(['remote', 'get-url', 'origin']).then((value) => value.trim()).catch(() => '')
    if (!origin) await call(['remote', 'add', 'origin', expectedOrigin])
    else if (origin.toLowerCase() !== expectedOrigin.toLowerCase()) throw new EvolutionError('review_rejected', 'Workspace Git cache origin does not match the candidate repository')
    const localConfig = (await call(['config', '--local', '--list'])).split(/\r?\n/gu).map((line) => line.toLowerCase())
    const dangerous = localConfig.find((line) => /^(?:filter\.|credential\.|url\.|diff\.external|core\.(?:hookspath|fsmonitor|sshcommand)|remote\.origin\.(?:uploadpack|receivepack)|http\..*extraheader)/u.test(line))
    if (dangerous) throw new EvolutionError('review_rejected', 'Workspace Git cache contains unsafe executable Git configuration')
    const hasCommit = await call(['cat-file', '-e', `${options.commit}^{commit}`]).then(() => true).catch(() => false)
    if (!hasCommit) {
      await call(['fetch', '--depth=1', '--filter=blob:none', '--no-tags', 'origin', options.commit])
    }
    await call(['cat-file', '-e', `${options.commit}^{commit}`])
    return await use({ repository, commit: options.commit, gitDir: resolvedGitDir, git: call })
  }, release)
}
