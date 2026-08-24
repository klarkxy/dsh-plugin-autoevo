import { access, mkdtemp, readFile, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { trackTempDirs } from '../helpers/temp-dirs.js'
import {
  appendCreatorRecord,
  assertChildCreatorCatalog,
  assertCreatorReceipt,
  compositionSha256,
  creatorAgentFacts,
  mintCreatorReceipt,
  preflightCreatorFoundation,
  requiredCreatorCatalog,
  requiredToolCatalogDigest,
  testingCreatorPreflight,
  _testing as creatorTesting,
} from '../../src/creator-foundation.js'
import { EVOLUTION_PRESET_ID } from '../../src/evolution-contracts.js'
import { POLICY_VERSION } from '../../src/contracts.js'
import { StateStore } from '../../src/state/store.js'
import { compactAgentView } from '../../src/workflow/agent-view.js'
import type { WorkflowRecord } from '../../src/workflow/contracts.js'

const temporary = trackTempDirs()

function requiredTools(): string[] {
  return [...requiredCreatorCatalog().tools]
}

function foundationCtx(options: {
  roster?: Array<{ id: string; broken?: boolean }> | null
  composition?: string | null
  standing?: unknown
  standingError?: Error
  tools?: string[]
  globalTools?: string[]
  toolsScope?: unknown
  skills?: string[]
  readError?: Error
  missingRuntime?: string
  resolvedTrust?: string
} = {}): Context {
  const tools = new Set(options.tools ?? requiredTools())
  const globalTools = new Set(options.globalTools ?? [])
  const skills = (options.skills ?? [...requiredCreatorCatalog().skills]).map((name) => ({ name }))
  const roster = options.roster === null
    ? undefined
    : options.roster ?? [{ id: EVOLUTION_PRESET_ID }]
  const scopedNames = (scope?: unknown): Set<string> => {
    if (scope === undefined) return globalTools
    if (options.toolsScope !== undefined && scope !== options.toolsScope) return new Set()
    return tools
  }
  return {
    get(name: string) {
      if (options.missingRuntime === name) return undefined
      if (name === 'agentPresets') {
        return {
          ...(roster ? { list: async () => roster } : {}),
          resolve: async (id: string) => {
            if (id !== EVOLUTION_PRESET_ID) throw new Error('missing preset')
            return { id, trust: options.resolvedTrust ?? 'system', path: 'evolution.yml' }
          },
          read: async (id: string) => {
            if (options.readError) throw options.readError
            if (options.composition === null) return ''
            if (id !== EVOLUTION_PRESET_ID) throw new Error('missing preset')
            return options.composition ?? creatorTesting.TESTING_CORDIS_COMPOSITION
          },
          standingKeyFor: async (id: string) => {
            if (options.standingError) throw options.standingError
            if (id !== EVOLUTION_PRESET_ID) throw new Error('unmountable')
            return options.standing === undefined ? 'standing-cordis' : options.standing
          },
        }
      }
      if (name === 'tools') {
        return {
          schemas: (scope?: unknown) => [...scopedNames(scope)].map((item) => ({ name: item })),
          get: (item: string, scope?: unknown) => scopedNames(scope).has(item) ? { name: item } : undefined,
        }
      }
      if (name === 'skills') {
        return { list: async () => skills }
      }
      if (['agents', 'sandbox', 'sandboxPolicy', 'fs'].includes(name)) {
        return options.missingRuntime === name ? undefined : { available: true }
      }
      return undefined
    },
  } as unknown as Context
}

function workflowRecord(overrides: Partial<WorkflowRecord> = {}): WorkflowRecord {
  return {
    schemaVersion: 1,
    id: `workflow_${'c'.repeat(24)}`,
    policyVersion: POLICY_VERSION,
    createdAt: '2026-08-22T00:00:00.000Z',
    updatedAt: '2026-08-22T00:00:00.000Z',
    requirement: 'calculator',
    status: 'running',
    cursor: 'prepare_create',
    generation: 1,
    ...overrides,
  }
}

describe('Creator foundation preflight', () => {
  it('validates the parent construction catalog and never falls back to code', async () => {
    const preflight = await preflightCreatorFoundation(foundationCtx())
    expect(preflight.presetId).toBe(EVOLUTION_PRESET_ID)
    expect(preflight.presetId).not.toBe('code')
    expect(preflight.compositionSha256).toBe(requiredToolCatalogDigest())
    expect(preflight.requiredToolCatalogDigest).toBe(requiredToolCatalogDigest())
    expect(preflight.standingScope).toBe(EVOLUTION_PRESET_ID)
    expect(preflight.catalog.tools).toEqual(expect.arrayContaining(requiredTools()))
  })

  it('is side-effect-free against managed source directories', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-creator-preflight-'))
    temporary.push(root)
    const sourceDir = path.join(root, 'sources')
    await preflightCreatorFoundation(foundationCtx())
    await expect(access(sourceDir)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(root)).toEqual([])
  })

  it('rejects catalog mismatches for inspect tools', async () => {
    await expect(preflightCreatorFoundation(foundationCtx({
      tools: requiredTools().filter((name) => name !== 'cordis_inspect_self'),
    }))).rejects.toThrow(/missing required construction tools/i)
  })

  it('never substitutes global tools for a missing scoped construction capability', async () => {
    await expect(preflightCreatorFoundation(foundationCtx({
      tools: requiredTools().filter((name) => name !== 'cordis_inspect_query'),
      globalTools: requiredTools(),
    }))).rejects.toThrow(/missing required construction tools/i)
  })

  it('reads the parent Agent as the DSH tools scope, not agent.ctx', async () => {
    const parent = { id: 'parent-session' }
    const ctx = foundationCtx({ toolsScope: parent })
    await expect(preflightCreatorFoundation(ctx, { parentCtx: ctx }))
      .rejects.toThrow(/missing required construction tools/i)
    const preflight = await preflightCreatorFoundation(ctx, { parentCtx: ctx, parentScope: parent })
    expect(preflight.catalog.tools).toEqual(expect.arrayContaining(requiredTools()))
  })

  it('rejects missing parent tool or skill services before source work', async () => {
    await expect(preflightCreatorFoundation(foundationCtx({ missingRuntime: 'tools' })))
      .rejects.toThrow(/runtime prerequisites are unavailable/i)
  })
})

describe('Creator child catalog and receipt', () => {
  it('accepts an evolution parent catalog that matches preflight', async () => {
    const preflight = testingCreatorPreflight()
    const catalog = await assertChildCreatorCatalog(
      foundationCtx(),
      { child: true },
      preflight,
      EVOLUTION_PRESET_ID,
      creatorTesting.TESTING_CORDIS_COMPOSITION,
    )
    expect(catalog.tools).toEqual(expect.arrayContaining(requiredTools()))
    const receipt = mintCreatorReceipt(preflight, 'parent-session-1')
    expect(assertCreatorReceipt(receipt, preflight)).toEqual(receipt)
  })

  it('rejects code composition and catalog digest mismatch', async () => {
    const preflight = testingCreatorPreflight()
    await expect(assertChildCreatorCatalog(
      foundationCtx(),
      { child: true },
      preflight,
      'code',
      creatorTesting.TESTING_CORDIS_COMPOSITION,
    ))
      .rejects.toThrow(/code preset is not permitted/i)
    expect(() => assertCreatorReceipt({
      ...mintCreatorReceipt(preflight, 'child-session-1'),
      compositionSha256: '0'.repeat(64),
    }, preflight)).toThrow(/does not match Creator preflight/i)
  })

  it('rejects a parent session that is not Capability Evolution', async () => {
    const preflight = testingCreatorPreflight()
    await expect(assertChildCreatorCatalog(
      foundationCtx(),
      { child: true },
      preflight,
      'code',
      `${creatorTesting.TESTING_CORDIS_COMPOSITION}# changed after preflight\n`,
    )).rejects.toThrow(/code preset is not permitted/i)
  })
})

describe('Creator records and legacy workflow JSON', () => {
  it('keeps schemaVersion 1/2 workflow JSON compatible without migration', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-creator-legacy-'))
    temporary.push(root)
    const store = new StateStore(root)
    const legacy = workflowRecord()
    await store.put('workflows', legacy)
    const loaded = await store.getWorkflow(legacy.id)
    expect(loaded.schemaVersion).toBe(1)
    expect(loaded.creatorRecords).toBeUndefined()
    expect(creatorAgentFacts(loaded.creatorRecords)).toBeUndefined()

    const withCreator = {
      ...loaded,
      schemaVersion: 2 as const,
      creatorRecords: appendCreatorRecord(loaded.creatorRecords, {
        operation: 'create',
        status: 'verified' as const,
        createdAt: '2026-08-22T00:00:01.000Z',
        receipt: mintCreatorReceipt(testingCreatorPreflight(), 'persist-child'),
      }),
    }
    await store.put('workflows', withCreator)
    const roundtrip = await store.getWorkflow(legacy.id)
    expect(roundtrip.schemaVersion).toBe(2)
    expect(roundtrip.creatorRecords?.[0]?.receipt?.childSessionId).toBe('persist-child')

    const card = compactAgentView({
      workflow: roundtrip,
      lifecycleState: 'executing',
    })
    expect(JSON.stringify(card)).not.toContain('persist-child')
    expect(JSON.stringify(card)).not.toContain(roundtrip.creatorRecords![0]!.receipt!.compositionSha256)
  })

  it('bounds persisted Creator records', () => {
    let records = undefined as ReturnType<typeof appendCreatorRecord> | undefined
    for (const operation of ['create', 'modify', 'correct', 'modify', 'correct'] as const) {
      records = appendCreatorRecord(records, {
        operation,
        status: 'verified',
        createdAt: new Date().toISOString(),
      })
    }
    expect(records).toHaveLength(4)
    expect(records!.map((item) => item.operation)).toEqual(['modify', 'correct', 'modify', 'correct'])
  })
})

describe('isolated and installed DSH Creator compositions', () => {
  it('hashes the isolated dev DSH 0.1.0-rc.6 official cordis preset without touching Web', async () => {
    const presetDir = path.join(process.cwd(), 'node_modules', '@deepseek-ai', 'dsh', 'config', 'agent-presets', 'cordis')
    const composition = await readFile(path.join(presetDir, 'agent.cordis.yml'), 'utf8')
    expect(composition).toMatch(/@deepseek-ai\/dsh-tool-cordis/u)
    expect(composition).toMatch(/@deepseek-ai\/dsh-tool-fs/u)
    expect(composition).toMatch(/@deepseek-ai\/dsh-tool-skill/u)
    expect(composition).toMatch(/@deepseek-ai\/dsh-tool-todo/u)
    expect(composition).toContain('customSkillDirs')
    expect(await readFile(path.join(presetDir, 'skills', 'cordis-plugin-development', 'SKILL.md'), 'utf8'))
      .toContain('name: cordis-plugin-development')
    expect(await readFile(path.join(presetDir, 'skills', 'editing-cordis-compositions', 'SKILL.md'), 'utf8'))
      .toContain('name: editing-cordis-compositions')
    expect(compositionSha256(composition)).toMatch(/^[a-f0-9]{64}$/u)
    const pkg = JSON.parse(await readFile(path.join(process.cwd(), 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')) as { version?: string }
    expect(pkg.version).toBe('0.1.0-rc.6')
  })

  it('smokes an installed DSH 0.1.1-rc.1 cordis composition when present, without touching Web', async () => {
    const version = await dshVersionIfPresent()
    if (!version) return
    if (!/0\.1\.1-rc\.1/u.test(version)) return
    const composition = await installedCordisComposition()
    if (!composition) return
    expect(composition).toMatch(/@deepseek-ai\/dsh-tool-cordis/u)
    expect(compositionSha256(composition)).toMatch(/^[a-f0-9]{64}$/u)
  })
})

async function dshVersionIfPresent(): Promise<string | undefined> {
  return await new Promise((resolve) => {
    const child = spawn('dsh', ['--version'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    child.stdout?.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.once('error', () => resolve(undefined))
    child.once('close', (code) => resolve(code === 0 ? stdout.trim() : undefined))
  })
}

async function installedCordisComposition(): Promise<string | undefined> {
  const candidates = [
    process.env.DSH_HOME,
    path.join(os.homedir(), '.dsh'),
  ].filter((item): item is string => Boolean(item))
  for (const home of candidates) {
    const file = path.join(home, 'node_modules', '@deepseek-ai', 'dsh', 'config', 'agent-presets', 'cordis', 'agent.cordis.yml')
    try {
      return await readFile(file, 'utf8')
    } catch {
      // Continue searching other install roots; absence is not a failure.
    }
  }
  return undefined
}
