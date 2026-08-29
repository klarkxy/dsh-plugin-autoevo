import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
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

async function acquireLock(lockPath: string, timeoutMs: number, signal?: AbortSignal): Promise<() => Promise<void>> {
  const started = Date.now()
  while (true) {
    try {
      await mkdir(lockPath)
      await writeFile(path.join(lockPath, 'owner.json'), `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, 'utf8')
      return async () => await rm(lockPath, { recursive: true, force: true })
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error
    }
    const owner = await readFile(path.join(lockPath, 'owner.json'), 'utf8')
      .then((value) => JSON.parse(value) as { pid?: number })
      .catch(() => undefined)
    const age = Date.now() - (await stat(lockPath)).mtimeMs
    if ((!owner?.pid || !processAlive(owner.pid)) && age > Math.max(5_000, timeoutMs)) {
      await rm(lockPath, { recursive: true, force: true })
      continue
    }
    if (Date.now() - started >= timeoutMs) {
      throw new EvolutionError('command_failed', 'Workspace Git cache is busy; retry the review', { retryable: true })
    }
    await delay(50, signal)
  }
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
  try {
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
    const exists = await stat(gitDir).then((item) => item.isDirectory()).catch(() => false)
    if (!exists) await runChecked(options.runner, [git, 'init', '--bare', gitDir], resolvedRoot, options.config.commandTimeoutMs, options.signal)
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
  } finally {
    await release()
  }
}
