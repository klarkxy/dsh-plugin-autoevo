import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeConfig } from '../../src/config.js'
import { EvolutionError } from '../../src/errors.js'
import type { DshLauncher } from '../../src/lifecycle/launcher.js'
import {
  FIND_PLUGIN_INSTALL_SPEC,
  FIND_PLUGIN_PACKAGE,
  installMarketplace,
  marketplaceApprovalReason,
  profilesWithAutoEvo,
} from '../../src/lifecycle/marketplace.js'

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((entry) => rm(entry, { recursive: true, force: true })))
})

const config = {
  dshHome: '',
  stateDir: '',
  ghCommand: 'gh',
  gitCommand: 'git',
  dshCommand: 'dsh',
  dshCommandArgs: [],
  maxCandidates: 5,
  maxFiles: 80,
  maxRepositoryBytes: 1_048_576,
  commandTimeoutMs: 30_000,
  forwardedCredentialEnv: [],
  verificationPatchPaths: [],
  evolutionPreset: true,
} as RuntimeConfig

const exec = {
  callId: 'call-resolve',
  signal: new AbortController().signal,
  agent: {},
} as unknown as ToolRunContext

async function profileHome(deps: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-market-'))
  temporary.push(root)
  const profile = path.join(root, 'profiles', 'web')
  await mkdir(profile, { recursive: true })
  await writeFile(path.join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dependencies: deps }), 'utf8')
  return root
}

describe('marketplace bootstrap', () => {
  it('writes the approval prompt in Chinese when the requirement is Chinese', () => {
    expect(marketplaceApprovalReason('我需要一个能在dsh里调用codex的能力。', ['web'])).toContain('插件市场')
    expect(marketplaceApprovalReason('I need Codex in DSH', ['web'])).toContain('Install the DSH plugin marketplace')
  })

  it('finds profiles that already have AutoEvo', async () => {
    const dshHome = await profileHome({ 'dsh-plugin-autoevo': 'link:.' })
    const launcher = {
      hasProfileDependency: vi.fn(async (_home: string, profile: string, name: string) => profile === 'web' && name === 'dsh-plugin-autoevo'),
    } as unknown as DshLauncher
    await expect(profilesWithAutoEvo(launcher, dshHome)).resolves.toEqual(['web'])
  })

  it('installs dsh-find-plugin by script after approval and hot-loads it', async () => {
    const dshHome = await profileHome({ 'dsh-plugin-autoevo': 'link:.' })
    const pluginDir = path.join(dshHome, 'profiles', 'web', 'node_modules', FIND_PLUGIN_PACKAGE)
    await mkdir(path.join(pluginDir, 'lib'), { recursive: true })
    await writeFile(path.join(pluginDir, 'package.json'), JSON.stringify({ name: FIND_PLUGIN_PACKAGE, type: 'module', main: './lib/index.js' }), 'utf8')
    await writeFile(path.join(pluginDir, 'lib', 'index.js'), 'export function apply(ctx) { ctx.tools.register({ name: "find_dsh_plugin" }) }\n', 'utf8')

    const request = vi.fn(async () => 'allowed-once')
    const registered = new Set<string>()
    const tools = {
      get: vi.fn((name: string) => registered.has(name) ? { name } : undefined),
      register: vi.fn((tool: { name: string }) => { registered.add(tool.name) }),
    }
    const ctx = {
      get: vi.fn(() => ({ request })),
      plugin: vi.fn((plugin: { apply?(input: { tools: typeof tools }): void }) => plugin.apply?.({ tools })),
      tools,
    } as unknown as Context
    const launcher = {
      hasProfileDependency: vi.fn(async (_home: string, _profile: string, name: string) => name === 'dsh-plugin-autoevo'),
      install: vi.fn(async () => {
        await writeFile(path.join(dshHome, 'profiles', 'web', 'package.json'), JSON.stringify({
          name: 'dsh-profile-web',
          dependencies: { 'dsh-plugin-autoevo': 'link:.', [FIND_PLUGIN_PACKAGE]: '1.0.0' },
        }), 'utf8')
        return { exitCode: 0, signal: null, stdout: '', stderr: '' }
      }),
    } as unknown as DshLauncher

    const result = await installMarketplace({
      ctx,
      config: { ...config, dshHome },
      launcher,
      cwd: dshHome,
      exec,
      requirement: '我需要一个能在dsh里调用codex的能力。',
    })

    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'capability_workflow',
      reason: expect.stringContaining('插件市场'),
    }))
    expect(launcher.install).toHaveBeenCalledWith(dshHome, 'web', FIND_PLUGIN_INSTALL_SPEC, dshHome, exec.signal)
    expect(ctx.plugin).toHaveBeenCalled()
    expect(result.status).toBe('loaded')
    expect(result.reason).toContain('热加载')
  })

  it('does not install when approval is denied', async () => {
    const dshHome = await profileHome({ 'dsh-plugin-autoevo': 'link:.' })
    const ctx = { get: vi.fn(() => ({ request: vi.fn(async () => 'denied') })) } as unknown as Context
    const launcher = {
      hasProfileDependency: vi.fn(async (_home: string, _profile: string, name: string) => name === 'dsh-plugin-autoevo'),
      install: vi.fn(async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' })),
    } as unknown as DshLauncher

    const result = await installMarketplace({
      ctx,
      config: { ...config, dshHome },
      launcher,
      cwd: dshHome,
      exec,
      requirement: '我需要一个能在dsh里调用codex的能力。',
    })

    expect(launcher.install).not.toHaveBeenCalled()
    expect(result.status).toBe('denied')
    expect(result.reason).toContain('不要自建插件')
  })

  it('surfaces the install diagnostic instead of a silent failure', async () => {
    const dshHome = await profileHome({ 'dsh-plugin-autoevo': 'link:.' })
    const ctx = { get: vi.fn(() => ({ request: vi.fn(async () => 'allowed-once') })) } as unknown as Context
    const launcher = {
      hasProfileDependency: vi.fn(async (_home: string, _profile: string, name: string) => name === 'dsh-plugin-autoevo'),
      install: vi.fn(async () => {
        throw new EvolutionError('command_failed', 'Failed to start dsh', { cause: 'spawn EINVAL' })
      }),
    } as unknown as DshLauncher

    const result = await installMarketplace({
      ctx,
      config: { ...config, dshHome },
      launcher,
      cwd: dshHome,
      exec,
      requirement: '我需要一个能在dsh里调用codex的能力。',
    })

    expect(result.status).toBe('failed')
    expect(result.reason).toContain('Failed to start dsh')
    expect(result.reason).toContain('spawn EINVAL')
    expect(result.reason).toContain('不要自建插件')
  })

  it('awaits Cordis plugin startup before deciding whether hot-load succeeded', async () => {
    const dshHome = await profileHome({
      'dsh-plugin-autoevo': 'link:.',
      [FIND_PLUGIN_PACKAGE]: '1.0.0',
    })
    const pluginDir = path.join(dshHome, 'profiles', 'web', 'node_modules', FIND_PLUGIN_PACKAGE)
    await mkdir(path.join(pluginDir, 'lib'), { recursive: true })
    await writeFile(path.join(pluginDir, 'package.json'), JSON.stringify({ name: FIND_PLUGIN_PACKAGE, type: 'module', main: './lib/index.js' }), 'utf8')
    await writeFile(path.join(pluginDir, 'lib', 'index.js'), 'export function apply() {}\n', 'utf8')

    let loaded = false
    const tools = { get: vi.fn(() => loaded ? { name: 'find_dsh_plugin' } : undefined) }
    const ctx = {
      tools,
      plugin: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        loaded = true
      }),
    } as unknown as Context
    const launcher = {
      hasProfileDependency: vi.fn(async () => true),
    } as unknown as DshLauncher

    const result = await installMarketplace({
      ctx,
      config: { ...config, dshHome },
      launcher,
      cwd: dshHome,
      exec,
      requirement: '我需要一个能在dsh里调用codex的能力。',
    })

    expect(result.status).toBe('loaded')
    expect(loaded).toBe(true)
  })

  it('retains a nonzero install diagnostic hash without exposing raw stderr', async () => {
    const dshHome = await profileHome({ 'dsh-plugin-autoevo': 'link:.' })
    const ctx = { get: vi.fn(() => ({ request: vi.fn(async () => 'allowed-once') })) } as unknown as Context
    const launcher = {
      hasProfileDependency: vi.fn(async (_home: string, _profile: string, name: string) => name === 'dsh-plugin-autoevo'),
      install: vi.fn(async () => {
        throw new EvolutionError('command_failed', 'dsh exited with code 1', {
          exitCode: 1,
          diagnosticHash: 'a'.repeat(64),
        })
      }),
    } as unknown as DshLauncher

    const result = await installMarketplace({
      ctx,
      config: { ...config, dshHome },
      launcher,
      cwd: dshHome,
      exec,
      requirement: '我需要一个能在dsh里调用codex的能力。',
    })

    expect(result.status).toBe('failed')
    expect(result.reason).toContain('exit=1')
    expect(result.reason).toContain(`diagnostic=${'a'.repeat(64)}`)
  })

  it('hot-loads from a successful profile when another profile install fails', async () => {
    const dshHome = await mkdtemp(path.join(os.tmpdir(), 'autoevo-market-multi-'))
    temporary.push(dshHome)
    for (const profile of ['good', 'stale']) {
      const directory = path.join(dshHome, 'profiles', profile)
      await mkdir(directory, { recursive: true })
      await writeFile(path.join(directory, 'package.json'), JSON.stringify({
        name: `dsh-profile-${profile}`,
        dependencies: { 'dsh-plugin-autoevo': 'link:.' },
      }), 'utf8')
    }
    const pluginDir = path.join(dshHome, 'profiles', 'good', 'node_modules', FIND_PLUGIN_PACKAGE)
    await mkdir(path.join(pluginDir, 'lib'), { recursive: true })
    await writeFile(path.join(pluginDir, 'package.json'), JSON.stringify({
      name: FIND_PLUGIN_PACKAGE,
      type: 'module',
      main: './lib/index.js',
    }), 'utf8')
    await writeFile(path.join(pluginDir, 'lib', 'index.js'), 'export function apply(ctx) { ctx.tools.register({ name: "find_dsh_plugin" }) }\n', 'utf8')

    const installed = new Set<string>()
    const registered = new Set<string>()
    const tools = {
      get: vi.fn((name: string) => registered.has(name) ? { name } : undefined),
      register: vi.fn((tool: { name: string }) => { registered.add(tool.name) }),
    }
    const ctx = {
      get: vi.fn(() => ({ request: vi.fn(async () => 'allowed-once') })),
      plugin: vi.fn((plugin: { apply?(input: { tools: typeof tools }): void }) => plugin.apply?.({ tools })),
      tools,
    } as unknown as Context
    const launcher = {
      hasProfileDependency: vi.fn(async (_home: string, profile: string, name: string) => {
        if (name === 'dsh-plugin-autoevo') return true
        return installed.has(profile)
      }),
      install: vi.fn(async (_home: string, profile: string) => {
        if (profile === 'stale') throw new EvolutionError('command_failed', 'stale profile failed', { exitCode: 1 })
        installed.add(profile)
        return { exitCode: 0, signal: null, stdout: '', stderr: '' }
      }),
    } as unknown as DshLauncher

    const result = await installMarketplace({
      ctx,
      config: { ...config, dshHome },
      launcher,
      cwd: dshHome,
      exec,
      requirement: '在 DSH 会话中调用 xAI Grok Build 的能力',
    })

    expect(result.status).toBe('loaded')
    expect(result.profiles).toContain('good')
    expect(result.reason).toContain('stale')
    expect(result.reason).toContain('安装仍失败')
  })
})
