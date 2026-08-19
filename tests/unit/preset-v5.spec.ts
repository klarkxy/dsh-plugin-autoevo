import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EVOLUTION_PRESET_ID,
  EVOLUTION_PRESET_KNOWN_MANIFESTS,
  EVOLUTION_PRESET_MANIFEST_FILENAME,
  EVOLUTION_PRESET_TEMPLATE_VERSION,
  type EvolutionPresetManifest,
} from '../../src/evolution-contracts.js'
import {
  buildManifest,
  materializeEvolutionPreset,
  resolveEvolutionPresetPaths,
  _testing,
} from '../../src/preset-manager.js'
import { sha256 } from '../../src/state/hashes.js'

const temps: string[] = []

afterEach(async () => {
  while (temps.length > 0) {
    const dir = temps.pop()!
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `${prefix}-`))
  temps.push(dir)
  return dir
}

async function writeTemplate(root: string, files: Record<string, string>): Promise<string> {
  const templateDir = path.join(root, 'template')
  await mkdir(templateDir, { recursive: true })
  for (const [name, body] of Object.entries(files)) {
    await writeFile(path.join(templateDir, name), body, 'utf8')
  }
  return templateDir
}

function bodyForDigest(digest: string, label: string): string {
  // Content bytes are not recovered from the digest; tests install via trustedPriorManifests
  // by first materializing arbitrary pristine content then treating that install as the prior.
  return `${label}:${digest.slice(0, 12)}\n`
}

describe('evolution preset V9 migration', () => {
  it('encodes every known pristine v1–v7 shape including compatibility releases', () => {
    expect(EVOLUTION_PRESET_TEMPLATE_VERSION).toBe('9')
    const versions = EVOLUTION_PRESET_KNOWN_MANIFESTS.map((item) => item.templateVersion).sort()
    expect(versions).toEqual(['1', '1', '2', '3', '4', '5', '5', '6', '7', '7'])
    expect(EVOLUTION_PRESET_KNOWN_MANIFESTS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          templateVersion: '1',
          files: {
            'agent.cordis.yml': '1998d90fcb17ab3ca0a43e831ade6fe1f4e9513fe9efbe6777e00c417963edb5',
            'preset.yml': '6a571f49983f3c3bdde1b70c4500a0594ecea5f67dad7a893895d2952dbda751',
          },
        }),
        expect.objectContaining({
          templateVersion: '1',
          files: {
            'agent.cordis.yml': '9dfcbafa4f20267473c88c8a854f6ff0d400bf7a7a55f9cac3f5e35faa136f0f',
            'preset.yml': '4e7c85c66dd5b22a46023b85f0f8d730ab9bb2933c31cee4b60246537488fc82',
          },
        }),
        expect.objectContaining({
          templateVersion: '2',
          files: {
            'agent.cordis.yml': '50815c246fb23c6dedee57069541771b5d9b8934a49d5b3b5a043a7af278add9',
            'preset.yml': 'bad59239f10692dbe91baac3e8eae13ba0492726c52d4420e6cc5e9f492c9334',
          },
        }),
        expect.objectContaining({
          templateVersion: '3',
          files: {
            'agent.cordis.yml': '488bf1f349435b969967fc4c78c56d0951082ba8519027039fabe570fdf25a3a',
            'preset.yml': 'bad59239f10692dbe91baac3e8eae13ba0492726c52d4420e6cc5e9f492c9334',
          },
        }),
        expect.objectContaining({
          templateVersion: '4',
          files: {
            'agent.cordis.yml': '3e6f27a853b5c062f584214b6e4c322bdc3d3e1176e90c22a6f2c4ae9ac3596a',
            'preset.yml': '4e7c85c66dd5b22a46023b85f0f8d730ab9bb2933c31cee4b60246537488fc82',
          },
        }),
        expect.objectContaining({
          templateVersion: '5',
          files: {
            'agent.cordis.yml': 'fbe6d39d435a072e31fdcd2985481cf4dcca517f68f80e6fabf10c5ec59876a1',
            'preset.yml': 'daac55dc543b3ab749486292240ebd8a838b177e3b2048a7ef7dfdc542a822bd',
          },
        }),
        expect.objectContaining({
          templateVersion: '5',
          files: {
            'agent.cordis.yml': '56af4a141e74042b05bb10e4d0066b7d1cbb7ed701c7b845500014f2f6135f83',
            'preset.yml': '48ddb7f319f9f93705a901c2f6f95e8d303a153fc23517f2353529a4316d601e',
          },
        }),
        expect.objectContaining({
          templateVersion: '6',
          files: {
            'agent.cordis.yml': '219a29aa7c65432e722b505ef72c835cd455782c871d62fd71194259fb1dbd9d',
            'preset.yml': 'daac55dc543b3ab749486292240ebd8a838b177e3b2048a7ef7dfdc542a822bd',
          },
        }),
        expect.objectContaining({
          templateVersion: '7',
          files: {
            'agent.cordis.yml': '8b0d426d5d1e0203625087f3f0b3f3d41f01b552259129622fa207c2cf5951c3',
            'preset.yml': 'daac55dc543b3ab749486292240ebd8a838b177e3b2048a7ef7dfdc542a822bd',
          },
        }),
        expect.objectContaining({
          templateVersion: '7',
          files: {
            'agent.cordis.yml': '431053523105e7af9539d9944f486f8d239a8b752d4d748461167fc3795a2441',
            'preset.yml': '48ddb7f319f9f93705a901c2f6f95e8d303a153fc23517f2353529a4316d601e',
          },
        }),
      ]),
    )
  })

  it.each(EVOLUTION_PRESET_KNOWN_MANIFESTS.map((manifest, index) => [manifest.templateVersion, index, manifest] as const))(
    'upgrades known pristine templateVersion=%s index=%s to V9',
    async (_version, _index, prior) => {
      const root = await tempDir(`autoevo-v5-from-${prior.templateVersion}`)
      const dshHome = path.join(root, 'dsh')
      const packageTemplate = path.resolve(process.cwd(), 'presets', 'evolution')
      const seedFiles = {
        'preset.yml': bodyForDigest(prior.files['preset.yml']!, 'preset'),
        'agent.cordis.yml': bodyForDigest(prior.files['agent.cordis.yml']!, 'agent'),
      }
      const seed = await writeTemplate(root, seedFiles)
      await materializeEvolutionPreset({
        dshHome,
        enabled: true,
        templateDir: seed,
        templateVersion: prior.templateVersion,
        trustedPriorManifests: [],
      })
      const target = resolveEvolutionPresetPaths(dshHome).targetDir
      const installed = JSON.parse(await readFile(path.join(target, EVOLUTION_PRESET_MANIFEST_FILENAME), 'utf8')) as EvolutionPresetManifest
      const upgraded = await materializeEvolutionPreset({
        dshHome,
        enabled: true,
        templateDir: packageTemplate,
        trustedPriorManifests: [installed],
      })
      expect(upgraded.status).toBe('upgraded')
      expect(upgraded.templateVersion).toBe('9')
      const finalManifest = JSON.parse(await readFile(path.join(target, EVOLUTION_PRESET_MANIFEST_FILENAME), 'utf8')) as EvolutionPresetManifest
      expect(finalManifest.templateVersion).toBe('9')
    },
  )

  it('no-ops exact V9 and preserves unknown or edited content', async () => {
    const root = await tempDir('autoevo-v5-noop-preserve')
    const dshHome = path.join(root, 'dsh')
    const packageTemplate = path.resolve(process.cwd(), 'presets', 'evolution')
    const first = await materializeEvolutionPreset({ dshHome, enabled: true, templateDir: packageTemplate })
    expect(first.status).toBe('installed')
    const second = await materializeEvolutionPreset({ dshHome, enabled: true, templateDir: packageTemplate })
    expect(second.status).toBe('noop')

    const target = resolveEvolutionPresetPaths(dshHome).targetDir
    await writeFile(path.join(target, 'preset.yml'), 'name: user-edited\n', 'utf8')
    const edited = await materializeEvolutionPreset({ dshHome, enabled: true, templateDir: packageTemplate })
    expect(edited.status).toBe('preserved')
    expect(await readFile(path.join(target, 'preset.yml'), 'utf8')).toBe('name: user-edited\n')

    const foreignHome = path.join(root, 'foreign-dsh')
    const foreignTarget = resolveEvolutionPresetPaths(foreignHome).targetDir
    await mkdir(foreignTarget, { recursive: true })
    await writeFile(path.join(foreignTarget, 'preset.yml'), 'name: foreign\n', 'utf8')
    await writeFile(path.join(foreignTarget, 'agent.cordis.yml'), '- id: x\n', 'utf8')
    await writeFile(path.join(foreignTarget, EVOLUTION_PRESET_MANIFEST_FILENAME), `${JSON.stringify({
      owner: 'someone-else',
      schemaVersion: 1,
      templateVersion: '9',
      files: {
        'preset.yml': 'a'.repeat(64),
        'agent.cordis.yml': 'b'.repeat(64),
      },
    }, null, 2)}\n`)
    const unknown = await materializeEvolutionPreset({ dshHome: foreignHome, enabled: true, templateDir: packageTemplate })
    expect(unknown.status).toBe('preserved')
  })

  it('uses an exclusive migration lock and recovers interrupted staging/backup', async () => {
    const root = await tempDir('autoevo-v5-lock-recover')
    const dshHome = path.join(root, 'dsh')
    const packageTemplate = path.resolve(process.cwd(), 'presets', 'evolution')
    await materializeEvolutionPreset({ dshHome, enabled: true, templateDir: packageTemplate })
    const presetsRoot = resolveEvolutionPresetPaths(dshHome).presetsRoot
    const lock = await _testing.acquireMigrationLock(presetsRoot)
    await expect(_testing.acquireMigrationLock(presetsRoot)).rejects.toThrow(/already running/i)
    await _testing.releaseMigrationLock(lock)

    const target = resolveEvolutionPresetPaths(dshHome).targetDir
    const staging = path.join(presetsRoot, `.${EVOLUTION_PRESET_ID}.staging-deadbeef`)
    await mkdir(staging, { recursive: true })
    await writeFile(path.join(staging, 'preset.yml'), 'name: orphan\n', 'utf8')
    await writeFile(path.join(staging, 'agent.cordis.yml'), '- id: orphan\n', 'utf8')
    await writeFile(path.join(staging, EVOLUTION_PRESET_MANIFEST_FILENAME), `${JSON.stringify(buildManifest({
      'preset.yml': sha256('name: orphan\n'),
      'agent.cordis.yml': sha256('- id: orphan\n'),
    }, '7'), null, 2)}\n`)

    const backup = path.join(presetsRoot, `.${EVOLUTION_PRESET_ID}.backup-cafebabe`)
    await rename(target, backup)
    await _testing.recoverInterruptedMigration(presetsRoot, target, rename)
    expect(await readFile(path.join(target, 'preset.yml'), 'utf8')).toMatch(/能力进化|Capability|name:/u)
    await expect(readFile(path.join(staging, 'preset.yml'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps normalized preset manifests stable across blank homes', async () => {
    const root = await tempDir('autoevo-v5-hash')
    const packageTemplate = path.resolve(process.cwd(), 'presets', 'evolution')
    const first = await materializeEvolutionPreset({
      dshHome: path.join(root, 'dsh-a'),
      enabled: true,
      templateDir: packageTemplate,
    })
    const second = await materializeEvolutionPreset({
      dshHome: path.join(root, 'dsh-b'),
      enabled: true,
      templateDir: packageTemplate,
    })
    expect(first.status).toBe('installed')
    expect(second.status).toBe('installed')
    const manifestA = JSON.parse(await readFile(path.join(first.targetDir, EVOLUTION_PRESET_MANIFEST_FILENAME), 'utf8'))
    const manifestB = JSON.parse(await readFile(path.join(second.targetDir, EVOLUTION_PRESET_MANIFEST_FILENAME), 'utf8'))
    expect(manifestA).toEqual(manifestB)
    expect(manifestA.templateVersion).toBe('9')

  })
})
