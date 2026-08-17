import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { RuntimeConfig } from '../config.js'
import { EvolutionError, errorMessage } from '../errors.js'
import type { DshLauncher } from './launcher.js'

export const FIND_PLUGIN_PACKAGE = 'dsh-find-plugin'
export const FIND_PLUGIN_INSTALL_SPEC = 'dsh-find-plugin'
const FIND_PLUGIN_TOOL = 'find_dsh_plugin'

const PROFILE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

export interface MarketplaceInstallResult {
  status: 'loaded' | 'installed' | 'partial' | 'already_present' | 'denied' | 'failed' | 'no_profile'
  profiles: string[]
  reason: string
}

function prefersChinese(text: string): boolean {
  return /[\p{Script=Han}]/u.test(text)
}

export function marketplaceApprovalReason(requirement: string, profiles: string[]): string {
  if (prefersChinese(requirement)) {
    return `将把 DSH 插件市场 dsh-find-plugin 安装到 profile ${profiles.join('、')}。这是能力搜索用的基础设施，不是你要的那个能力。批准后会立刻安装，并尽量热加载到当前进程。`
  }
  return `Install the DSH plugin marketplace dsh-find-plugin into profile ${profiles.join(', ')}. This is search infrastructure, not the requested capability. After approval AutoEvo installs it and tries to hot-load it into this process.`
}

function copy(
  requirement: string,
  english: string,
  chinese: string,
): string {
  return prefersChinese(requirement) ? chinese : english
}

async function requestApproval(
  ctx: Context,
  exec: ToolRunContext,
  reason: string,
): Promise<void> {
  const approval = ctx.get('approval')
  if (!approval || !exec.agent) {
    throw new EvolutionError('approval_required', 'A live DSH approval service and Agent turn are required')
  }
  const outcome = await approval.request({
    agent: exec.agent,
    toolName: 'capability_workflow',
    callId: exec.callId,
    reason,
    signal: exec.signal,
  })
  if (outcome !== 'allowed-once') {
    throw new EvolutionError('approval_required', `The requested change was not approved (${outcome})`, { outcome })
  }
}

export async function profilesWithAutoEvo(
  launcher: DshLauncher,
  dshHome: string,
): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(path.join(dshHome, 'profiles'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const found: string[] = []
  for (const name of names.sort((left, right) => left.localeCompare(right))) {
    if (!PROFILE_NAME.test(name)) continue
    if (await launcher.hasProfileDependency(dshHome, name, 'dsh-plugin-autoevo')) found.push(name)
  }
  return found
}

function pluginEntry(pkg: { main?: unknown; exports?: unknown }): string {
  const exportsField = pkg.exports
  if (typeof exportsField === 'string') return exportsField
  if (exportsField && typeof exportsField === 'object') {
    const root = (exportsField as Record<string, unknown>)['.']
    if (typeof root === 'string') return root
    if (root && typeof root === 'object') {
      const mapped = root as Record<string, unknown>
      if (typeof mapped.import === 'string') return mapped.import
      if (typeof mapped.default === 'string') return mapped.default
    }
  }
  return typeof pkg.main === 'string' ? pkg.main : 'lib/index.js'
}

export async function hotLoadMarketplace(
  ctx: Context,
  dshHome: string,
  profile: string,
  agent?: ToolRunContext['agent'],
): Promise<boolean> {
  if (ctx.tools.get(FIND_PLUGIN_TOOL, agent)) return true
  const root = path.join(dshHome, 'profiles', profile, 'node_modules', FIND_PLUGIN_PACKAGE)
  try {
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
      main?: unknown
      exports?: unknown
    }
    const href = pathToFileURL(path.resolve(root, pluginEntry(pkg))).href
    const mod = await import(href) as { default?: unknown; apply?: unknown }
    const plugin = mod.default ?? mod
    // Cordis plugin startup is asynchronous. Await the returned Fiber before
    // checking the scoped registry, otherwise a successful load is reported as
    // a restart-only installation.
    await (ctx.plugin as unknown as (value: unknown) => PromiseLike<unknown>)(plugin)
  } catch {
    const loader = (ctx as Context & { loader?: { create?(options: { id: string; name: string }): Promise<unknown> } }).loader
      ?? ctx.get('loader') as { create?(options: { id: string; name: string }): Promise<unknown> } | undefined
    if (!loader?.create) return false
    try {
      await loader.create({ id: 'find-dsh-plugin', name: FIND_PLUGIN_PACKAGE })
    } catch {
      return Boolean(ctx.tools.get(FIND_PLUGIN_TOOL, agent))
    }
  }
  return Boolean(ctx.tools.get(FIND_PLUGIN_TOOL, agent))
}

export async function installMarketplace(options: {
  ctx: Context
  config: RuntimeConfig
  launcher: DshLauncher
  cwd: string
  exec: ToolRunContext
  requirement: string
}): Promise<MarketplaceInstallResult> {
  const requirement = options.requirement
  const profiles = await profilesWithAutoEvo(options.launcher, options.config.dshHome)
  if (profiles.length === 0) {
    return {
      status: 'no_profile',
      profiles,
      reason: copy(
        requirement,
        'Could not find a DSH profile that already has AutoEvo; install dsh-find-plugin into that profile manually, then resolve again.',
        '找不到已经安装 AutoEvo 的 DSH profile。请先手工把 dsh-find-plugin 装进该 profile，然后再解析。',
      ),
    }
  }

  const pending: string[] = []
  for (const profile of profiles) {
    if (!await options.launcher.hasProfileDependency(options.config.dshHome, profile, FIND_PLUGIN_PACKAGE)) {
      pending.push(profile)
    }
  }

  const tryLoad = async (targets: string[]): Promise<boolean> => {
    for (const profile of targets) {
      if (await hotLoadMarketplace(options.ctx, options.config.dshHome, profile, options.exec.agent)) return true
    }
    return false
  }

  const present = profiles.filter((profile) => !pending.includes(profile))
  if (present.length > 0 && await tryLoad(present)) {
    return {
      status: 'loaded',
      profiles: present,
      reason: copy(
        requirement,
        `dsh-find-plugin was already installed in profile ${present.join(', ')} and is now hot-loaded into this process.`,
        `dsh-find-plugin 已经在 profile ${present.join('、')} 中，并已热加载到当前进程。`,
      ),
    }
  }

  if (pending.length === 0) {
    if (await tryLoad(profiles)) {
      return {
        status: 'loaded',
        profiles,
        reason: copy(
          requirement,
          'dsh-find-plugin was already installed and is now hot-loaded into this process.',
          'dsh-find-plugin 已经在 profile 里，并已热加载到当前进程。',
        ),
      }
    }
    return {
      status: 'already_present',
      profiles,
      reason: copy(
        requirement,
        'dsh-find-plugin is already a profile dependency, but this process could not hot-load it. Restart DSH, then call capability_workflow again.',
        'dsh-find-plugin 已经写进 profile，但当前进程热加载失败。请重启 DSH，再调用 capability_workflow。',
      ),
    }
  }

  try {
    await requestApproval(
      options.ctx,
      options.exec,
      marketplaceApprovalReason(requirement, pending),
    )
  } catch (error) {
    if (error instanceof EvolutionError && error.code === 'approval_required') {
      return {
        status: 'denied',
        profiles: pending,
        reason: copy(
          requirement,
          'Marketplace install needs one-time approval. Approve and resolve again; do not create a plugin until the marketplace is installed.',
          '安装插件市场需要一次性批准。请批准后再次解析；在市场装好之前不要自建插件。',
        ),
      }
    }
    throw error
  }

  const installed: string[] = []
  const failed: string[] = []
  const diagnostics: string[] = []
  for (const profile of pending) {
    try {
      const result = await options.launcher.install(
        options.config.dshHome,
        profile,
        FIND_PLUGIN_INSTALL_SPEC,
        options.cwd,
        options.exec.signal,
      )
      if (result.exitCode === 0 || await options.launcher.hasProfileDependency(options.config.dshHome, profile, FIND_PLUGIN_PACKAGE)) {
        installed.push(profile)
      } else {
        failed.push(profile)
        diagnostics.push(installDiagnostic(profile, result.stderr || result.stdout || `exit ${result.exitCode ?? 'null'}`))
      }
    } catch (error) {
      failed.push(profile)
      diagnostics.push(installDiagnostic(profile, describeInstallError(error)))
    }
  }

  const loadable = [...present, ...installed]
  if (loadable.length > 0 && await tryLoad(loadable)) {
    return {
      status: 'loaded',
      profiles: loadable,
      reason: failed.length === 0
        ? copy(
            requirement,
            `Installed ${FIND_PLUGIN_PACKAGE} into profile ${installed.join(', ')} and hot-loaded it into this process.`,
            `已将 ${FIND_PLUGIN_PACKAGE} 安装到 profile ${installed.join('、')}，并已热加载到当前进程。`,
          )
        : copy(
            requirement,
            `Hot-loaded ${FIND_PLUGIN_PACKAGE} from profile ${loadable.join(', ')}. Installation also failed for profile ${failed.join(', ')}.${formatDiagnostics(diagnostics)}`,
            `已从 profile ${loadable.join('、')} 热加载 ${FIND_PLUGIN_PACKAGE}；profile ${failed.join('、')} 的安装仍失败。${formatDiagnostics(diagnostics)}`,
          ),
    }
  }

  if (installed.length > 0 && failed.length === 0) {
    return {
      status: 'installed',
      profiles: installed,
      reason: copy(
        requirement,
        `Installed ${FIND_PLUGIN_PACKAGE} into profile ${installed.join(', ')}. This process could not hot-load it; restart DSH, then call capability_workflow again.`,
        `已将 ${FIND_PLUGIN_PACKAGE} 安装到 profile ${installed.join('、')}，但当前进程热加载失败。请重启 DSH，再调用 capability_workflow。`,
      ),
    }
  }
  if (installed.length > 0) {
    return {
      status: 'partial',
      profiles: installed,
      reason: copy(
        requirement,
        `Installed ${FIND_PLUGIN_PACKAGE} into profile ${installed.join(', ')}, but current-process loading failed and installation also failed for profile ${failed.join(', ')}. Restart may activate the successful profile; do not create a plugin until discovery completes.${formatDiagnostics(diagnostics)}`,
        `已将 ${FIND_PLUGIN_PACKAGE} 安装到 profile ${installed.join('、')}，但当前进程热加载失败，且 profile ${failed.join('、')} 安装失败。重启后可能从成功的 profile 加载；发现完成前不要自建插件。${formatDiagnostics(diagnostics)}`,
      ),
    }
  }
  return {
    status: 'failed',
    profiles: pending,
    reason: copy(
      requirement,
      `Marketplace install did not finish for profile ${failed.join(', ') || pending.join(', ')}. Do not create a plugin until dsh-find-plugin is installed.${formatDiagnostics(diagnostics)}`,
      `profile ${failed.join('、') || pending.join('、')} 的市场安装没有完成。在装好 dsh-find-plugin 之前不要自建插件。${formatDiagnostics(diagnostics)}`,
    ),
  }
}

function describeInstallError(error: unknown): string {
  if (error instanceof EvolutionError) {
    const cause = typeof error.details.cause === 'string' ? error.details.cause : ''
    const exitCode = typeof error.details.exitCode === 'number' ? ` exit=${error.details.exitCode}` : ''
    const diagnosticHash = typeof error.details.diagnosticHash === 'string'
      ? ` diagnostic=${error.details.diagnosticHash}`
      : ''
    return cause ? `${error.message} (${cause})` : `${error.message}${exitCode}${diagnosticHash}`
  }
  return errorMessage(error)
}

function installDiagnostic(profile: string, detail: string): string {
  const compact = detail.replace(/\s+/gu, ' ').trim().slice(0, 400)
  return compact ? `${profile}: ${compact}` : profile
}

function formatDiagnostics(diagnostics: string[]): string {
  return diagnostics.length > 0 ? ` ${diagnostics.join(' ')}` : ''
}
