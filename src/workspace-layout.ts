import { AsyncLocalStorage } from 'node:async_hooks'
import { access, constants, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { RuntimeConfig } from './config.js'
import { EvolutionError } from './errors.js'

export const WORKSPACE_AUTOEVO_DIR = '.autoevo'
export const WORKSPACE_SOURCE_DIR = path.join(WORKSPACE_AUTOEVO_DIR, 'sources')
export const WORKSPACE_GIT_CACHE_DIR = path.join(WORKSPACE_AUTOEVO_DIR, 'cache', 'git')

const currentWorkspace = new AsyncLocalStorage<string>()

export function runInWorkspace<T>(cwd: string, fn: () => T): T {
  return currentWorkspace.run(path.resolve(cwd), fn)
}

export function currentWorkspaceCwd(): string | undefined {
  return currentWorkspace.getStore()
}

export function resolveStateRoot(config: Pick<RuntimeConfig, 'dshHome' | 'stateDir'>): string {
  if (config.stateDir) return path.resolve(config.stateDir)
  return path.resolve(config.dshHome, 'autoevo')
}

export function resolveSourceRoot(config: Pick<RuntimeConfig, 'sourceDir'>, cwd?: string): string {
  if (config.sourceDir) return path.resolve(config.sourceDir)
  const workspace = cwd?.trim() || currentWorkspaceCwd()
  if (!workspace) {
    throw new EvolutionError('invalid_input', 'Managed sources require the current session workspace')
  }
  return path.resolve(workspace, WORKSPACE_SOURCE_DIR)
}

/** Rebuildable transport cache. Reviewed artifacts remain under stateDir. */
export function resolveGitCacheRoot(cwd?: string): string {
  const workspace = cwd?.trim() || currentWorkspaceCwd()
  if (!workspace) {
    throw new EvolutionError('invalid_input', 'GitHub repository caching requires the current session workspace')
  }
  return path.resolve(workspace, WORKSPACE_GIT_CACHE_DIR)
}

export async function ensureAutoEvoGitignore(autoevoRoot: string): Promise<void> {
  await mkdir(autoevoRoot, { recursive: true })
  const ignore = path.join(autoevoRoot, '.gitignore')
  try {
    await access(ignore, constants.F_OK)
  } catch {
    await writeFile(
      ignore,
      '# AutoEvo workspace state. Installed DSH plugins do not depend on these files.\n*\n',
      'utf8',
    )
  }
}
