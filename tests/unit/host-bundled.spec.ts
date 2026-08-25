import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { trackTempDirs } from '../helpers/temp-dirs.js'
import type { ResolutionRecord } from '../../src/contracts.js'
import { POLICY_VERSION } from '../../src/contracts.js'
import {
  listBundledOptInPackages,
  resolveBundledDshRoot,
  resolveHostBundledCapabilities,
} from '../../src/resolver/host-bundled.js'
import { matchConfidence, resolveLocalCapabilities } from '../../src/resolver/local.js'
import { candidateSnapshotFor } from '../../src/workflow/candidates.js'
import { optionsFor } from '../../src/workflow/contracts.js'
import type { WorkflowRecord } from '../../src/workflow/contracts.js'

const temporary = trackTempDirs()

const TIME_REQUIREMENT = '我需要一个能在每一次对话的时候把当前时间带着发送出去的插件，用来给dsh知道时间和耗时。'

async function seedBundledRoot(root: string): Promise<void> {
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.1-rc.2' }))
  const scopeDir = path.join(root, 'node_modules', '@deepseek-ai')
  const seed = async (dir: string, manifest: Record<string, unknown>) => {
    await mkdir(path.join(scopeDir, dir), { recursive: true })
    await writeFile(path.join(scopeDir, dir, 'package.json'), JSON.stringify(manifest))
  }
  await seed('dsh-time-context', {
    name: '@deepseek-ai/dsh-time-context',
    version: '0.1.1-rc.2',
    description: 'Opt-in durable per-step context with the current time and elapsed time',
  })
  await seed('dsh-tmux-context', {
    name: '@deepseek-ai/dsh-tmux-context',
    version: '0.1.1-rc.2',
    description: "Opt-in durable per-step context with this agent's tmux pane and window location",
  })
  await seed('dsh-agent-loop', {
    name: '@deepseek-ai/dsh-agent-loop',
    version: '0.1.1-rc.2',
    description: 'Agent loop internals',
  })
}

async function seedDshHome(root: string, bundledRoot: string): Promise<string> {
  const link = path.join(root, 'profiles', 'node_modules', '@deepseek-ai', 'dsh')
  await mkdir(path.dirname(link), { recursive: true })
  await mkdir(path.join(bundledRoot, 'lib'), { recursive: true })
  // Tests run on Windows where directory symlinks need privileges; copy the
  // manifest anchors instead of linking — resolution only reads package.json.
  await mkdir(link, { recursive: true })
  await writeFile(path.join(link, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.1-rc.2' }))
  return link
}

function emptyContext(): Context {
  return {
    tools: { schemas: () => [] },
    systemPrompt: { assemble: async () => ({ tools: [] }) },
    skills: { list: async () => [] },
  } as unknown as Context
}

const exec = { agent: undefined, signal: undefined } as unknown as Pick<ToolRunContext, 'agent' | 'signal'>

describe('host-bundled opt-in capabilities', () => {
  it('matches the motivating Chinese time requirement against the bundled package', () => {
    const confidence = matchConfidence(
      TIME_REQUIREMENT,
      '@deepseek-ai/dsh-time-context',
      'Opt-in durable per-step context with the current time and elapsed time',
    )
    expect(confidence).toBeGreaterThanOrEqual(0.62)
  })

  it('enumerates only opt-in described packages with a stripped mount id', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-bundled-list-'))
    temporary.push(root)
    await seedBundledRoot(root)

    const packages = await listBundledOptInPackages(root)

    expect(packages.map((entry) => entry.packageName)).toEqual([
      '@deepseek-ai/dsh-time-context',
      '@deepseek-ai/dsh-tmux-context',
    ])
    expect(packages[0]).toMatchObject({ mountId: 'time-context', version: '0.1.1-rc.2' })
  })

  it('locates the dsh package root through the healed profile fallback link', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-bundled-root-'))
    temporary.push(root)
    const bundledRoot = path.join(root, 'cli')
    const dshHome = path.join(root, 'dsh-home')
    await mkdir(bundledRoot, { recursive: true })
    await seedBundledRoot(bundledRoot)
    await seedDshHome(dshHome, bundledRoot)

    const previous = process.env.DSH_PACKAGE_ROOT
    delete process.env.DSH_PACKAGE_ROOT
    try {
      await expect(resolveBundledDshRoot({
        dshHome,
        config: { dshCommand: 'dsh' },
      })).resolves.toBe(path.join(dshHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh'))
      await expect(resolveBundledDshRoot({
        dshHome: path.join(root, 'missing-home'),
        config: { dshCommand: 'dsh' },
      })).resolves.toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.DSH_PACKAGE_ROOT
      else process.env.DSH_PACKAGE_ROOT = previous
    }
  })

  it('offers unmounted opt-in packages as host_bundled candidates and skips mounted ones', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-bundled-candidates-'))
    temporary.push(root)
    const bundledRoot = path.join(root, 'cli')
    const dshHome = path.join(root, 'dsh-home')
    await mkdir(bundledRoot, { recursive: true })
    await seedBundledRoot(bundledRoot)

    const candidates = await resolveHostBundledCapabilities({
      dshPackageRoot: bundledRoot,
      dshHome,
      activeProfile: 'web',
      requirement: TIME_REQUIREMENT,
      match: matchConfidence,
    })
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      kind: 'plugin',
      name: '@deepseek-ai/dsh-time-context',
      availability: 'host_bundled',
      hostBundled: { packageName: '@deepseek-ai/dsh-time-context', version: '0.1.1-rc.2', mountId: 'time-context' },
    })

    const profileRoot = path.join(dshHome, 'profiles', 'web')
    await mkdir(profileRoot, { recursive: true })
    await writeFile(path.join(profileRoot, 'cordis.patch.yml'), "- insert:\n    - id: time-context\n      name: '@deepseek-ai/dsh-time-context'\n")
    const mounted = await resolveHostBundledCapabilities({
      dshPackageRoot: bundledRoot,
      dshHome,
      activeProfile: 'web',
      requirement: TIME_REQUIREMENT,
      match: matchConfidence,
    })
    expect(mounted).toEqual([])
  })

  it('merges into local resolution as a full-fit, non-reusable candidate that suppresses remote discovery', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-bundled-local-'))
    temporary.push(root)
    const bundledRoot = path.join(root, 'cli')
    const dshHome = path.join(root, 'dsh-home')
    await mkdir(bundledRoot, { recursive: true })
    await seedBundledRoot(bundledRoot)
    await mkdir(path.join(dshHome, 'profiles', 'web'), { recursive: true })

    const result = await resolveLocalCapabilities(emptyContext(), TIME_REQUIREMENT, exec, {
      dshHome,
      activeProfile: 'web',
      dshPackageRoot: bundledRoot,
    })

    const candidate = result.candidates.find((item) => item.availability === 'host_bundled')
    expect(candidate).toMatchObject({ fit: 'full', surfaceMatch: true, reuseEligible: false })
    expect(result.shouldDiscoverRemote).toBe(false)
  })

  it('presents enable_builtin at the selection gate for host-bundled snapshot candidates', async () => {
    const id = `resolution_${'c'.repeat(24)}`
    const resolution: ResolutionRecord = {
      schemaVersion: 2,
      id,
      policyVersion: POLICY_VERSION,
      createdAt: '2026-08-25T00:00:00.000Z',
      requirement: TIME_REQUIREMENT,
      cwd: 'C:/workspace',
      decision: 'use_local',
      localCandidates: [{
        kind: 'plugin',
        name: '@deepseek-ai/dsh-time-context',
        description: 'Opt-in durable per-step context with the current time and elapsed time',
        availability: 'host_bundled',
        confidence: 0.92,
        fit: 'full',
        reuseEligible: false,
        hostBundled: { packageName: '@deepseek-ai/dsh-time-context', version: '0.1.1-rc.2', mountId: 'time-context' },
      }],
      remoteCandidates: [],
      remoteDiscoveryComplete: true,
      queries: [],
      reasons: [],
    }
    const snapshot = candidateSnapshotFor(resolution)
    expect(snapshot[0]?.hostBundled).toEqual({
      packageName: '@deepseek-ai/dsh-time-context',
      version: '0.1.1-rc.2',
      mountId: 'time-context',
    })

    const options = optionsFor('await_selection', resolution, [], { candidateSnapshot: snapshot } as WorkflowRecord)
    const enable = options.find((option) => option.id === 'enable_builtin')
    expect(enable?.candidateIds).toEqual([snapshot[0]!.id])
    expect(options.find((option) => option.id === 'reuse_local')).toBeUndefined()
  })
})
