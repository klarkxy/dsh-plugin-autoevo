import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EVOLUTION_PRESET_ID,
  EVOLUTION_PRESET_KNOWN_MANIFESTS,
  EVOLUTION_PRESET_MANIFEST_FILENAME,
  EVOLUTION_PRESET_TEMPLATE_VERSION,
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
    await rm(temps.pop()!, { recursive: true, force: true }).catch(() => undefined)
  }
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `${prefix}-`))
  temps.push(dir)
  return dir
}

describe('evolution preset Search-first V18', () => {
  it('trusts pristine V13 through V17 as upgrade priors and ships V18 as current', () => {
    expect(EVOLUTION_PRESET_TEMPLATE_VERSION).toBe('18')
    expect(EVOLUTION_PRESET_KNOWN_MANIFESTS[0]).toEqual({
      owner: 'dsh-plugin-autoevo',
      schemaVersion: 1,
      templateVersion: '13',
      files: {
        'agent.cordis.yml': '521d2133694c5642e3e78fcd5ddfa7f2d7af6eab80244fdd2c22030dd586d55c',
        'preset.yml': 'd51f8ab85feeb76c73de0cb091735b7ddbdad4d2b3d8adfc878dd35b6e79bbbd',
      },
    })
    expect(EVOLUTION_PRESET_KNOWN_MANIFESTS[1]?.templateVersion).toBe('14')
    expect(EVOLUTION_PRESET_KNOWN_MANIFESTS[2]?.templateVersion).toBe('15')
    expect(EVOLUTION_PRESET_KNOWN_MANIFESTS[3]?.templateVersion).toBe('16')
    expect(EVOLUTION_PRESET_KNOWN_MANIFESTS[4]?.templateVersion).toBe('17')
  })

  it('upgrades a pristine V13 install to the current Creator-superset template', async () => {
    const root = await tempDir('autoevo-v13-upgrade')
    const dshHome = path.join(root, 'dsh')
    const target = resolveEvolutionPresetPaths(dshHome).targetDir
    await mkdir(target, { recursive: true })
    await writeFile(path.join(target, 'preset.yml'), 'name: v13-body\n', 'utf8')
    await writeFile(path.join(target, 'agent.cordis.yml'), '- id: v13-body\n', 'utf8')
    const matching = buildManifest({
      'preset.yml': sha256('name: v13-body\n'),
      'agent.cordis.yml': sha256('- id: v13-body\n'),
    }, '13')
    await writeFile(path.join(target, EVOLUTION_PRESET_MANIFEST_FILENAME), _testing.serializeManifest(matching), 'utf8')

    const result = await materializeEvolutionPreset({
      dshHome,
      enabled: true,
      templateDir: path.resolve(process.cwd(), 'presets', 'evolution'),
      trustedPriorManifests: [matching],
    })
    expect(result.status).toBe('upgraded')
    expect(result.templateVersion).toBe('18')
    expect(await readFile(path.join(target, 'skills', 'cordis-plugin-development', 'SKILL.md'), 'utf8'))
      .toContain('name: cordis-plugin-development')
  })

  it('installs the current template into a blank home and no-ops the exact current template', async () => {
    const root = await tempDir('autoevo-v16-fresh')
    const dshHome = path.join(root, 'dsh')
    const templateDir = path.resolve(process.cwd(), 'presets', 'evolution')

    const first = await materializeEvolutionPreset({ dshHome, enabled: true, templateDir })
    expect(first).toMatchObject({ status: 'installed', templateVersion: '18' })
    const second = await materializeEvolutionPreset({ dshHome, enabled: true, templateDir })
    expect(second).toMatchObject({ status: 'noop', templateVersion: '18' })

    const manifest = JSON.parse(await readFile(
      path.join(first.targetDir, EVOLUTION_PRESET_MANIFEST_FILENAME),
      'utf8',
    ))
    expect(manifest.templateVersion).toBe('18')
    expect(manifest.files['preset.yml']).toMatch(/^[a-f0-9]{64}$/u)
    expect(manifest.files['skills/cordis-plugin-development/SKILL.md']).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('preserves edited content, unknown manifests, and foreign owners', async () => {
    const root = await tempDir('autoevo-v12-preserve')
    const templateDir = path.resolve(process.cwd(), 'presets', 'evolution')

    const editedHome = path.join(root, 'edited')
    const installed = await materializeEvolutionPreset({ dshHome: editedHome, enabled: true, templateDir })
    await writeFile(path.join(installed.targetDir, 'preset.yml'), 'name: user-edited\n', 'utf8')
    const edited = await materializeEvolutionPreset({ dshHome: editedHome, enabled: true, templateDir })
    expect(edited.status).toBe('preserved')
    expect(await readFile(path.join(installed.targetDir, 'preset.yml'), 'utf8')).toBe('name: user-edited\n')

    for (const [name, owner] of [['unknown', 'dsh-plugin-autoevo'], ['foreign', 'someone-else']] as const) {
      const dshHome = path.join(root, name)
      const target = resolveEvolutionPresetPaths(dshHome).targetDir
      await mkdir(target, { recursive: true })
      await writeFile(path.join(target, 'preset.yml'), `name: ${name}\n`, 'utf8')
      await writeFile(path.join(target, 'agent.cordis.yml'), '- id: custom\n', 'utf8')
      await writeFile(path.join(target, EVOLUTION_PRESET_MANIFEST_FILENAME), `${JSON.stringify({
        owner,
        schemaVersion: 1,
        templateVersion: 'custom',
        files: {
          'preset.yml': 'a'.repeat(64),
          'agent.cordis.yml': 'b'.repeat(64),
        },
      }, null, 2)}\n`, 'utf8')
      const result = await materializeEvolutionPreset({ dshHome, enabled: true, templateDir })
      expect(result.status).toBe('preserved')
      expect(await readFile(path.join(target, 'preset.yml'), 'utf8')).toBe(`name: ${name}\n`)
    }
  })

  it('uses an exclusive materialization lock and recovers interrupted staging', async () => {
    const root = await tempDir('autoevo-v12-lock')
    const dshHome = path.join(root, 'dsh')
    const templateDir = path.resolve(process.cwd(), 'presets', 'evolution')
    await materializeEvolutionPreset({ dshHome, enabled: true, templateDir })
    const paths = resolveEvolutionPresetPaths(dshHome)
    const lock = await _testing.acquireMigrationLock(paths.presetsRoot)
    await expect(_testing.acquireMigrationLock(paths.presetsRoot)).rejects.toThrow(/already running/i)
    await _testing.releaseMigrationLock(lock)

    const staging = path.join(paths.presetsRoot, `.${EVOLUTION_PRESET_ID}.staging-deadbeef`)
    await mkdir(staging, { recursive: true })
    await writeFile(path.join(staging, 'preset.yml'), 'name: orphan\n', 'utf8')
    await writeFile(path.join(staging, 'agent.cordis.yml'), '- id: orphan\n', 'utf8')
    await writeFile(path.join(staging, EVOLUTION_PRESET_MANIFEST_FILENAME), `${JSON.stringify(buildManifest({
      'preset.yml': sha256('name: orphan\n'),
      'agent.cordis.yml': sha256('- id: orphan\n'),
    }, '12'), null, 2)}\n`, 'utf8')

    const backup = path.join(paths.presetsRoot, `.${EVOLUTION_PRESET_ID}.backup-cafebabe`)
    await rename(paths.targetDir, backup)
    await _testing.recoverInterruptedMigration(paths.presetsRoot, paths.targetDir, rename)
    expect(await readFile(path.join(paths.targetDir, 'preset.yml'), 'utf8')).toMatch(/能力进化|Capability|name:/u)
    await expect(readFile(path.join(staging, 'preset.yml'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('produces the same current manifest in independent blank homes', async () => {
    const root = await tempDir('autoevo-v12-stable')
    const templateDir = path.resolve(process.cwd(), 'presets', 'evolution')
    const a = await materializeEvolutionPreset({ dshHome: path.join(root, 'a'), enabled: true, templateDir })
    const b = await materializeEvolutionPreset({ dshHome: path.join(root, 'b'), enabled: true, templateDir })
    const manifestA = JSON.parse(await readFile(path.join(a.targetDir, EVOLUTION_PRESET_MANIFEST_FILENAME), 'utf8'))
    const manifestB = JSON.parse(await readFile(path.join(b.targetDir, EVOLUTION_PRESET_MANIFEST_FILENAME), 'utf8'))
    expect(manifestA).toEqual(manifestB)
    expect(manifestA.templateVersion).toBe('18')
  })
})
