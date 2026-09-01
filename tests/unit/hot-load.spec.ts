import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { trackTempDirs } from '../helpers/temp-dirs.js'
import { hotLoadInstalledBundle } from '../../src/lifecycle/hot-load.js'

const temporary = trackTempDirs()

async function seedBundle(root: string): Promise<{ dshHome: string; profile: string; profileRoot: string }> {
  const dshHome = root
  const profile = 'web'
  const profileRoot = path.join(dshHome, 'profiles', profile)
  const packageRoot = path.join(profileRoot, 'node_modules', 'dsh-tool-test')
  await mkdir(packageRoot, { recursive: true })
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: 'dsh-tool-test',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }), 'utf8')
  await writeFile(path.join(packageRoot, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: test-tool',
    '      name: dsh-tool-test',
    '      config: {}',
  ].join('\n'), 'utf8')
  return { dshHome, profile, profileRoot }
}

function loaderContext(profileRoot: string, group: unknown, toolVisible = true): Context {
  return {
    baseUrl: pathToFileURL(profileRoot),
    fiber: { entry: { id: 'autoevo', parent: group } },
    tools: { get: (name: string) => toolVisible && name === 'test_tool' ? {} : undefined },
  } as unknown as Context
}

describe('current-profile Loader hot reload', () => {
  it('does not start a Loader update when the signal was already aborted', async () => {
    const controller = new AbortController()
    const reason = new Error('pre-aborted hot-load')
    controller.abort(reason)
    const update = vi.fn()
    const ctx = loaderContext(process.cwd(), { update })

    await expect(hotLoadInstalledBundle({
      ctx,
      dshHome: process.cwd(),
      profile: 'web',
      packageName: 'dsh-tool-test',
      expectedTools: [],
      signal: controller.signal,
    })).rejects.toBe(reason)
    expect(update).not.toHaveBeenCalled()
  })

  it('marks recovery without a second update when update mutates candidate then rejects', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-hot-load-partial-update-'))
    temporary.push(root)
    const { dshHome, profile, profileRoot } = await seedBundle(root)
    const original = [{ id: 'autoevo', name: 'dsh-plugin-autoevo', config: {} }]
    const group = {
      data: structuredClone(original),
      update: vi.fn(async (entries: typeof original) => {
        group.data = structuredClone(entries)
        if (group.update.mock.calls.length === 1) throw new Error('update rejected after mutation')
      }),
      tree: { resolve: () => ({ fiber: { await: async () => undefined } }) },
    }

    const result = await hotLoadInstalledBundle({
      ctx: loaderContext(profileRoot, group), dshHome, profile, packageName: 'dsh-tool-test', expectedTools: ['test_tool'],
    })
    expect(result).toMatchObject({ rollbackFailed: true, evidence: { method: 'failed' } })
    expect(group.data).toContainEqual(expect.objectContaining({ id: 'test-tool', name: 'dsh-tool-test' }))
    expect(group.update).toHaveBeenCalledTimes(1)
  })

  it('marks recovery even when a rejected update restored the previous data', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-hot-load-conflict-'))
    temporary.push(root)
    const { dshHome, profile, profileRoot } = await seedBundle(root)
    const original = [{ id: 'autoevo', name: 'dsh-plugin-autoevo', config: {} }]
    const group = {
      data: structuredClone(original),
      update: vi.fn(async () => {
        group.data = structuredClone(original)
        throw new Error('update rejected after restoring previous data')
      }),
      tree: { resolve: () => ({ fiber: { await: async () => undefined } }) },
    }

    const result = await hotLoadInstalledBundle({
      ctx: loaderContext(profileRoot, group), dshHome, profile, packageName: 'dsh-tool-test', expectedTools: ['test_tool'],
    })
    expect(result).toMatchObject({ rollbackFailed: true, evidence: { method: 'failed' } })
    expect(group.data).toEqual(original)
    expect(group.update).toHaveBeenCalledTimes(1)
  })

  it('never overwrites an external Loader generation after a rejected update', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-hot-load-external-generation-'))
    temporary.push(root)
    const { dshHome, profile, profileRoot } = await seedBundle(root)
    const original = [{ id: 'autoevo', name: 'dsh-plugin-autoevo', config: {} }]
    const external = [{ id: 'external', name: 'user-plugin', config: {} }]
    const group = {
      data: structuredClone(original),
      update: vi.fn(async () => {
        group.data = structuredClone(external)
        throw new Error('update rejected after external generation appeared')
      }),
      tree: { resolve: () => ({ fiber: { await: async () => undefined } }) },
    }

    const result = await hotLoadInstalledBundle({
      ctx: loaderContext(profileRoot, group), dshHome, profile, packageName: 'dsh-tool-test', expectedTools: ['test_tool'],
    })
    expect(result).toMatchObject({ rollbackFailed: true, evidence: { method: 'failed' } })
    expect(group.data).toEqual(external)
    expect(group.update).toHaveBeenCalledTimes(1)
  })

  it('marks recovery for a pending Fiber abort without retaining an abort listener or rolling back', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-hot-load-fiber-abort-'))
    temporary.push(root)
    const { dshHome, profile, profileRoot } = await seedBundle(root)
    const controller = new AbortController()
    const reason = new Error('abort pending Fiber')
    const removeAbortListener = vi.spyOn(controller.signal, 'removeEventListener')
    const original = [{ id: 'autoevo', name: 'dsh-plugin-autoevo', config: {} }]
    let fiberEntered!: () => void
    const fiberPending = new Promise<void>((resolve) => { fiberEntered = resolve })
    const group = {
      data: structuredClone(original),
      update: vi.fn(async (entries: typeof original) => { group.data = structuredClone(entries) }),
      tree: { resolve: () => ({ fiber: { await: async () => {
        fiberEntered()
        await new Promise<void>(() => undefined)
      } } }) },
    }
    const operation = hotLoadInstalledBundle({
      ctx: loaderContext(profileRoot, group), dshHome, profile, packageName: 'dsh-tool-test', expectedTools: ['test_tool'], signal: controller.signal,
    })
    await fiberPending
    controller.abort(reason)

    await expect(operation).resolves.toMatchObject({ rollbackFailed: true, evidence: { method: 'failed', loaded: false } })
    expect(group.data).toContainEqual(expect.objectContaining({ id: 'test-tool', name: 'dsh-tool-test' }))
    expect(group.update).toHaveBeenCalledTimes(1)
    expect(removeAbortListener).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('marks recovery without a second update when a Fiber rejects', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-hot-load-fiber-reject-'))
    temporary.push(root)
    const { dshHome, profile, profileRoot } = await seedBundle(root)
    const original = [{ id: 'autoevo', name: 'dsh-plugin-autoevo', config: {} }]
    const group = {
      data: structuredClone(original),
      update: vi.fn(async (entries: typeof original) => { group.data = structuredClone(entries) }),
      tree: { resolve: () => ({ fiber: { await: async () => { throw new Error('Fiber rejected') } } }) },
    }
    const result = await hotLoadInstalledBundle({
      ctx: loaderContext(profileRoot, group), dshHome, profile, packageName: 'dsh-tool-test', expectedTools: ['test_tool'],
    })
    expect(result).toMatchObject({ rollbackFailed: true, evidence: { method: 'failed' } })
    expect(group.update).toHaveBeenCalledTimes(1)
  })

  it('applies the reviewed bundle patch without exposing a stale rollback closure', async () => {
    const dshHome = await mkdtemp(path.join(os.tmpdir(), 'autoevo-hot-load-'))
    temporary.push(dshHome)
    const profile = 'web'
    const profileRoot = path.join(dshHome, 'profiles', profile)
    const packageRoot = path.join(profileRoot, 'node_modules', 'dsh-tool-test')
    await mkdir(packageRoot, { recursive: true })
    await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
      name: 'dsh-tool-test',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }), 'utf8')
    await writeFile(path.join(packageRoot, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: test-tool',
      '      name: dsh-tool-test',
      '      config: {}',
    ].join('\n'), 'utf8')

    const original = [{ id: 'autoevo', name: 'dsh-plugin-autoevo', config: {} }]
    const group = {
      data: structuredClone(original),
      update: vi.fn(async (entries: typeof original) => { group.data = structuredClone(entries) }),
      tree: {
        resolve: () => ({ fiber: { await: async () => undefined } }),
      },
    }
    const ctx = {
      baseUrl: pathToFileURL(profileRoot),
      fiber: { entry: { id: 'autoevo', parent: group } },
      tools: { get: (name: string) => name === 'test_tool' ? {} : undefined },
    } as unknown as Context

    const result = await hotLoadInstalledBundle({
      ctx,
      dshHome,
      profile,
      packageName: 'dsh-tool-test',
      expectedTools: ['test_tool'],
    })

    expect(result.evidence).toMatchObject({ attempted: true, loaded: true, method: 'loader' })
    expect(group.data).toContainEqual(expect.objectContaining({ id: 'test-tool', name: 'dsh-tool-test' }))
    expect('rollback' in result).toBe(false)
  })

  it('hot-loads a carrier patch that inserts another package Fiber', async () => {
    const dshHome = await mkdtemp(path.join(os.tmpdir(), 'autoevo-hot-load-carrier-'))
    temporary.push(dshHome)
    const profile = 'web'
    const profileRoot = path.join(dshHome, 'profiles', profile)
    const packageRoot = path.join(profileRoot, 'node_modules', 'dsh-plugin-beta')
    await mkdir(packageRoot, { recursive: true })
    await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
      name: 'dsh-plugin-beta',
      dsh: { bundle: { patch: './dsh-plugin/cordis.patch.yml' } },
    }), 'utf8')
    await mkdir(path.join(packageRoot, 'dsh-plugin'), { recursive: true })
    await writeFile(path.join(packageRoot, 'dsh-plugin', 'cordis.patch.yml'), [
      '- insert:',
      '    - id: record-sync-tool',
      '      name: \'@deepseek-ai/dsh-mcp-client\'',
      '      config: {}',
    ].join('\n'), 'utf8')

    const original = [{ id: 'autoevo', name: 'dsh-plugin-autoevo', config: {} }]
    const group = {
      data: structuredClone(original),
      update: vi.fn(async (entries: typeof original) => { group.data = structuredClone(entries) }),
      tree: {
        resolve: (id: string) => {
          if (id !== 'record-sync-tool') throw new Error(`unexpected id ${id}`)
          return { fiber: { await: async () => undefined } }
        },
      },
    }
    const ctx = {
      baseUrl: pathToFileURL(profileRoot),
      fiber: { entry: { id: 'autoevo', parent: group } },
      tools: { get: () => undefined },
    } as unknown as Context

    const result = await hotLoadInstalledBundle({
      ctx,
      dshHome,
      profile,
      packageName: 'dsh-plugin-beta',
      expectedTools: [],
    })

    expect(result.evidence).toMatchObject({ attempted: true, loaded: true, method: 'loader' })
    expect(group.data).toContainEqual(expect.objectContaining({
      id: 'record-sync-tool',
      name: '@deepseek-ai/dsh-mcp-client',
    }))
  })

  it('does not ask the current process to hot-load a different profile', async () => {
    const dshHome = await mkdtemp(path.join(os.tmpdir(), 'autoevo-hot-load-profile-'))
    temporary.push(dshHome)
    const active = path.join(dshHome, 'profiles', 'active')
    const target = path.join(dshHome, 'profiles', 'target')
    await mkdir(active, { recursive: true })
    await mkdir(target, { recursive: true })
    const ctx = { baseUrl: pathToFileURL(active) } as unknown as Context

    await expect(hotLoadInstalledBundle({
      ctx,
      dshHome,
      profile: 'target',
      packageName: 'dsh-tool-test',
      expectedTools: [],
    })).resolves.toMatchObject({
      evidence: { attempted: true, loaded: false, method: 'unsupported' },
    })
  })
})
