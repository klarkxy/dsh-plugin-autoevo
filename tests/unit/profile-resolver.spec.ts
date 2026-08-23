import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { resolveLocalCapabilities } from '../../src/resolver/local.js'
import {
  activeProfileFromArgv,
  resolveCurrentProfileOwner,
  resolveProfilePluginCapabilities,
} from '../../src/resolver/profile.js'

const temporary: string[] = []
const PACKAGE = '@dsh-external/dsh-conv-export'

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((entry) => rm(entry, { recursive: true, force: true })))
})

async function profileHome(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-profile-'))
  temporary.push(root)
  const profileRoot = path.join(root, 'profiles', 'web')
  await mkdir(path.join(profileRoot, 'node_modules', '@dsh-external', 'dsh-conv-export'), { recursive: true })
  await mkdir(path.join(root, 'profiles', 'headless'), { recursive: true })
  await writeFile(path.join(profileRoot, 'package.json'), JSON.stringify({
    dependencies: { [PACKAGE]: 'file:C:/tmp/private-build/dsh-external-dsh-conv-export-0.1.0.tgz' },
    dsh: { profile: { bundles: [PACKAGE] } },
  }))
  await writeFile(path.join(profileRoot, 'node_modules', '@dsh-external', 'dsh-conv-export', 'package.json'), JSON.stringify({
    name: PACKAGE,
    description: 'Export current DSH conversation as Markdown or a long PNG.',
    keywords: ['conversation', 'export'],
    dsh: { client: './dist' },
  }))
  await writeFile(path.join(root, 'profiles', 'headless', 'package.json'), JSON.stringify({
    dependencies: { 'dsh-plugin-other': '1.0.0' },
    dsh: { profile: { bundles: ['dsh-plugin-other'] } },
  }))
  return root
}

function emptyContext(): Context {
  return {
    get: () => undefined,
    tools: { schemas: () => [] },
    systemPrompt: { assemble: async () => ({ tools: [] }) },
    skills: { list: async () => [] },
  } as unknown as Context
}

describe('activeProfileFromArgv', () => {
  it('accepts only explicit valid profile forms', () => {
    expect(activeProfileFromArgv(['--profile', 'web'])).toBe('web')
    expect(activeProfileFromArgv(['--profile=web-2.0'])).toBe('web-2.0')
    expect(activeProfileFromArgv(['--profile=web', '--profile', 'web'])).toBe('web')
  })

  it('rejects missing, invalid, traversal, and conflicting flags without defaulting', () => {
    expect(activeProfileFromArgv([])).toBeUndefined()
    expect(activeProfileFromArgv(['--profile'])).toBeUndefined()
    expect(activeProfileFromArgv(['--profile', '../web'])).toBeUndefined()
    expect(activeProfileFromArgv(['--profile=web/child'])).toBeUndefined()
    expect(activeProfileFromArgv(['--profile=web', '--profile=headless'])).toBeUndefined()
  })
})

describe('resolveCurrentProfileOwner', () => {
  it('uses the profile that owns the live base URL even when argv has no profile flag', async () => {
    const dshHome = await profileHome()
    await expect(resolveCurrentProfileOwner({
      dshHome,
      baseUrl: path.join(dshHome, 'profiles', 'web'),
      argv: ['web'],
    })).resolves.toBe('web')
  })

  it('fails closed when argv conflicts with the live owner or the base URL is outside profiles', async () => {
    const dshHome = await profileHome()
    await expect(resolveCurrentProfileOwner({
      dshHome,
      baseUrl: path.join(dshHome, 'profiles', 'web'),
      argv: ['--profile', 'headless'],
    })).rejects.toThrow(/conflicts with the profile that owns/i)
    await expect(resolveCurrentProfileOwner({
      dshHome,
      baseUrl: dshHome,
      argv: [],
    })).rejects.toThrow(/outside configured DSH_HOME\/profiles/i)
  })
})

describe('profile capability resolver', () => {
  it('isolates the current profile and records only bounded profile install/configuration evidence', async () => {
    const dshHome = await profileHome()
    const candidates = await resolveProfilePluginCapabilities({
      dshHome,
      profile: 'web',
      requirement: 'export the current conversation',
      match: () => 0.8,
    })
    expect(candidates).toEqual([expect.objectContaining({
      name: PACKAGE,
      availability: 'installed_in_profile',
      profileEvidence: {
        source: 'host_profile_manifest',
        profile: 'web',
        packageName: PACKAGE,
        dependencySpec: 'file:[local-reference]',
        configuredBundle: true,
      },
    })])
    expect(JSON.stringify(candidates)).not.toContain('C:/tmp/private-build')
    const headless = await resolveProfilePluginCapabilities({
      dshHome,
      profile: 'headless',
      requirement: PACKAGE,
      match: () => 0.8,
    })
    expect(headless.map((candidate) => candidate.name)).not.toContain(PACKAGE)
    await expect(resolveProfilePluginCapabilities({
      dshHome,
      profile: '../web',
      requirement: PACKAGE,
      match: () => 0.8,
    })).resolves.toEqual([])
  })

  it('uses an exact profile package mention as a full local match without remote discovery', async () => {
    const dshHome = await profileHome()
    const result = await resolveLocalCapabilities(
      emptyContext(),
      `use ${PACKAGE}`,
      { agent: undefined, signal: undefined } as unknown as Pick<ToolRunContext, 'agent' | 'signal'>,
      { dshHome, activeProfile: 'web' },
    )
    expect(result.shouldDiscoverRemote).toBe(false)
    expect(result.candidates).toEqual([expect.objectContaining({
      name: PACKAGE,
      confidence: 0.99,
      fit: 'full',
      availability: 'installed_in_profile',
      profileEvidence: expect.objectContaining({ configuredBundle: true }),
    })])
  })

  it('does not treat an exact package mention as already-satisfying when evolving the installed plugin', async () => {
    const dshHome = await profileHome()
    const profileRoot = path.join(dshHome, 'profiles', 'web')
    await writeFile(path.join(profileRoot, 'package.json'), JSON.stringify({
      dependencies: { 'dsh-xai': `github:MirDie/dsh-xai#${'a'.repeat(40)}` },
      dsh: { profile: { bundles: ['dsh-xai'] } },
    }))
    const result = await resolveLocalCapabilities(
      emptyContext(),
      '修改当前已安装的 dsh-xai',
      { agent: undefined, signal: undefined } as unknown as Pick<ToolRunContext, 'agent' | 'signal'>,
      {
        dshHome,
        activeProfile: 'web',
        intent: { operation: 'evolve_existing', requiredSurface: 'native_dsh_plugin', targetName: 'dsh-xai' },
      },
    )
    expect(result.shouldDiscoverRemote).toBe(true)
    expect(result.candidates).toEqual([expect.objectContaining({
      name: 'dsh-xai',
      fit: 'partial',
      reuseEligible: true,
      evolutionTarget: expect.objectContaining({
        kind: 'github_exact',
        repository: 'MirDie/dsh-xai',
      }),
    })])
  })
})
