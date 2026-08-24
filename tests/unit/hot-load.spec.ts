import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { trackTempDirs } from '../helpers/temp-dirs.js'
import { hotLoadInstalledBundle } from '../../src/lifecycle/hot-load.js'

const temporary = trackTempDirs()

describe('current-profile Loader hot reload', () => {
  it('applies the reviewed bundle patch transactionally and exposes rollback', async () => {
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
    expect(result.rollback).toBeTypeOf('function')
    await result.rollback?.()
    expect(group.data).toEqual(original)
  })

  it('hot-loads a carrier patch that inserts another package Fiber', async () => {
    const dshHome = await mkdtemp(path.join(os.tmpdir(), 'autoevo-hot-load-carrier-'))
    temporary.push(dshHome)
    const profile = 'web'
    const profileRoot = path.join(dshHome, 'profiles', profile)
    const packageRoot = path.join(profileRoot, 'node_modules', 'dsh-plugin-zhihu-search')
    await mkdir(packageRoot, { recursive: true })
    await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
      name: 'dsh-plugin-zhihu-search',
      dsh: { bundle: { patch: './dsh-plugin/cordis.patch.yml' } },
    }), 'utf8')
    await mkdir(path.join(packageRoot, 'dsh-plugin'), { recursive: true })
    await writeFile(path.join(packageRoot, 'dsh-plugin', 'cordis.patch.yml'), [
      '- insert:',
      '    - id: zhihu-search-mcp',
      '      name: \'@deepseek-ai/dsh-mcp-client\'',
      '      config: {}',
    ].join('\n'), 'utf8')

    const original = [{ id: 'autoevo', name: 'dsh-plugin-autoevo', config: {} }]
    const group = {
      data: structuredClone(original),
      update: vi.fn(async (entries: typeof original) => { group.data = structuredClone(entries) }),
      tree: {
        resolve: (id: string) => {
          if (id !== 'zhihu-search-mcp') throw new Error(`unexpected id ${id}`)
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
      packageName: 'dsh-plugin-zhihu-search',
      expectedTools: [],
    })

    expect(result.evidence).toMatchObject({ attempted: true, loaded: true, method: 'loader' })
    expect(group.data).toContainEqual(expect.objectContaining({
      id: 'zhihu-search-mcp',
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
