import { mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EVOLUTION_PRESET_MANIFEST_FILENAME,
  EVOLUTION_PRESET_TEMPLATE_VERSION,
} from '../../src/evolution-contracts.js'
import {
  buildManifest,
  materializeEvolutionPreset,
  resolveEvolutionPresetPaths,
  verifyPristine,
  _testing,
} from '../../src/preset-manager.js'
import { sha256 } from '../../src/state/hashes.js'

const temps: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises')
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

const baseTemplate = {
  'preset.yml': 'name: 能力进化\ndescription: 先复用，再改进，最后才创建\n',
  'agent.cordis.yml': '- id: tool-cordis\n  name: "@deepseek-ai/dsh-tool-cordis"\n',
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  while (temps.length > 0) {
    const dir = temps.pop()!
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
  vi.restoreAllMocks()
})

describe('materializeEvolutionPreset', () => {
  it('skips when disabled without touching the target', async () => {
    const root = await tempDir('autoevo-preset-skip')
    const dshHome = path.join(root, 'dsh')
    const templateDir = await writeTemplate(root, baseTemplate)
    const result = await materializeEvolutionPreset({
      dshHome,
      enabled: false,
      templateDir,
    })
    expect(result.status).toBe('skipped')
    expect(result.reason).toMatch(/false/i)
    await expect(readFile(path.join(dshHome, '.agent-presets', 'evolution', 'preset.yml'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('performs first install with manifest hashes', async () => {
    const root = await tempDir('autoevo-preset-install')
    const dshHome = path.join(root, 'dsh')
    const templateDir = await writeTemplate(root, baseTemplate)
    const result = await materializeEvolutionPreset({ dshHome, enabled: true, templateDir })
    expect(result.status).toBe('installed')
    const target = resolveEvolutionPresetPaths(dshHome).targetDir
    const preset = await readFile(path.join(target, 'preset.yml'), 'utf8')
    expect(preset).toBe(baseTemplate['preset.yml'])
    const manifest = JSON.parse(await readFile(path.join(target, EVOLUTION_PRESET_MANIFEST_FILENAME), 'utf8'))
    expect(manifest.owner).toBe('dsh-plugin-autoevo')
    expect(manifest.templateVersion).toBe(EVOLUTION_PRESET_TEMPLATE_VERSION)
    expect(manifest.files['preset.yml']).toBe(sha256(Buffer.from(baseTemplate['preset.yml'])))
    expect(manifest.files['agent.cordis.yml']).toBe(sha256(Buffer.from(baseTemplate['agent.cordis.yml'])))
  })

  it('no-ops when template version and hashes already match', async () => {
    const root = await tempDir('autoevo-preset-noop')
    const dshHome = path.join(root, 'dsh')
    const templateDir = await writeTemplate(root, baseTemplate)
    await materializeEvolutionPreset({ dshHome, enabled: true, templateDir })
    const second = await materializeEvolutionPreset({ dshHome, enabled: true, templateDir })
    expect(second.status).toBe('noop')
  })

  it('upgrades a pristine managed preset', async () => {
    const root = await tempDir('autoevo-preset-upgrade')
    const dshHome = path.join(root, 'dsh')
    const templateDir = await writeTemplate(root, baseTemplate)
    await materializeEvolutionPreset({ dshHome, enabled: true, templateDir })

    const nextTemplate = await writeTemplate(path.join(root, 'next'), {
      ...baseTemplate,
      'preset.yml': 'name: 能力进化\ndescription: upgraded\n',
    })
    const upgraded = await materializeEvolutionPreset({
      dshHome,
      enabled: true,
      templateDir: nextTemplate,
      templateVersion: '2',
    })
    expect(upgraded.status).toBe('upgraded')
    expect(upgraded.templateVersion).toBe('2')
    const body = await readFile(path.join(resolveEvolutionPresetPaths(dshHome).targetDir, 'preset.yml'), 'utf8')
    expect(body).toContain('upgraded')
  })

  it('preserves user-modified managed files', async () => {
    const root = await tempDir('autoevo-preset-modified')
    const dshHome = path.join(root, 'dsh')
    const templateDir = await writeTemplate(root, baseTemplate)
    await materializeEvolutionPreset({ dshHome, enabled: true, templateDir })
    const target = resolveEvolutionPresetPaths(dshHome).targetDir
    await writeFile(path.join(target, 'preset.yml'), 'name: user-changed\n', 'utf8')

    const nextTemplate = await writeTemplate(path.join(root, 'next'), {
      ...baseTemplate,
      'preset.yml': 'name: next\n',
    })
    const result = await materializeEvolutionPreset({
      dshHome,
      enabled: true,
      templateDir: nextTemplate,
      templateVersion: '2',
    })
    expect(result.status).toBe('preserved')
    expect(await readFile(path.join(target, 'preset.yml'), 'utf8')).toBe('name: user-changed\n')
  })

  it('preserves a foreign same-name directory without a valid manifest', async () => {
    const root = await tempDir('autoevo-preset-foreign')
    const dshHome = path.join(root, 'dsh')
    const target = resolveEvolutionPresetPaths(dshHome).targetDir
    await mkdir(target, { recursive: true })
    await writeFile(path.join(target, 'notes.txt'), 'mine\n', 'utf8')
    const templateDir = await writeTemplate(root, baseTemplate)
    const result = await materializeEvolutionPreset({ dshHome, enabled: true, templateDir })
    expect(result.status).toBe('preserved')
    expect(await readFile(path.join(target, 'notes.txt'), 'utf8')).toBe('mine\n')
  })

  it('preserves a same-name directory with a plausible but incomplete manifest', async () => {
    const root = await tempDir('autoevo-preset-incomplete-manifest')
    const dshHome = path.join(root, 'dsh')
    const target = resolveEvolutionPresetPaths(dshHome).targetDir
    await mkdir(target, { recursive: true })
    const manifest = {
      owner: 'dsh-plugin-autoevo',
      schemaVersion: 1,
      templateVersion: 'foreign',
      files: {},
    }
    await writeFile(
      path.join(target, EVOLUTION_PRESET_MANIFEST_FILENAME),
      `${JSON.stringify(manifest)}\n`,
      'utf8',
    )
    const templateDir = await writeTemplate(root, baseTemplate)

    const result = await materializeEvolutionPreset({ dshHome, enabled: true, templateDir })

    expect(result.status).toBe('preserved')
    expect(result.reason).toMatch(/no valid AutoEvo manifest/u)
    expect(JSON.parse(await readFile(
      path.join(target, EVOLUTION_PRESET_MANIFEST_FILENAME),
      'utf8',
    ))).toEqual(manifest)
  })

  it('preserves a managed preset when the manifest has an extra top-level field', async () => {
    const root = await tempDir('autoevo-preset-extra-manifest-field')
    const dshHome = path.join(root, 'dsh')
    const templateDir = await writeTemplate(root, baseTemplate)
    await materializeEvolutionPreset({ dshHome, enabled: true, templateDir })
    const target = resolveEvolutionPresetPaths(dshHome).targetDir
    const manifestPath = path.join(target, EVOLUTION_PRESET_MANIFEST_FILENAME)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    manifest.userNote = 'keep me'
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

    const result = await materializeEvolutionPreset({
      dshHome,
      enabled: true,
      templateDir,
      templateVersion: '2',
    })

    expect(result.status).toBe('preserved')
    expect(JSON.parse(await readFile(manifestPath, 'utf8'))).toMatchObject({ userNote: 'keep me' })
  })

  it('preserves a managed preset when the manifest bytes are non-canonical', async () => {
    const root = await tempDir('autoevo-preset-noncanonical-manifest')
    const dshHome = path.join(root, 'dsh')
    const templateDir = await writeTemplate(root, baseTemplate)
    await materializeEvolutionPreset({ dshHome, enabled: true, templateDir })
    const target = resolveEvolutionPresetPaths(dshHome).targetDir
    const manifestPath = path.join(target, EVOLUTION_PRESET_MANIFEST_FILENAME)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    const userFormatting = `${JSON.stringify(manifest)}\n`
    await writeFile(manifestPath, userFormatting, 'utf8')

    const result = await materializeEvolutionPreset({
      dshHome,
      enabled: true,
      templateDir,
      templateVersion: '2',
    })

    expect(result.status).toBe('preserved')
    expect(await readFile(manifestPath, 'utf8')).toBe(userFormatting)
  })

  it('preserves when a managed file is missing', async () => {
    const root = await tempDir('autoevo-preset-missing')
    const dshHome = path.join(root, 'dsh')
    const templateDir = await writeTemplate(root, baseTemplate)
    await materializeEvolutionPreset({ dshHome, enabled: true, templateDir })
    const target = resolveEvolutionPresetPaths(dshHome).targetDir
    const { unlink } = await import('node:fs/promises')
    await unlink(path.join(target, 'agent.cordis.yml'))
    const result = await materializeEvolutionPreset({
      dshHome,
      enabled: true,
      templateDir,
      templateVersion: '2',
    })
    expect(result.status).toBe('preserved')
    expect(result.reason).toMatch(/missing|not pristine/i)
  })

  it('preserves when an extra file is present', async () => {
    const root = await tempDir('autoevo-preset-extra')
    const dshHome = path.join(root, 'dsh')
    const templateDir = await writeTemplate(root, baseTemplate)
    await materializeEvolutionPreset({ dshHome, enabled: true, templateDir })
    const target = resolveEvolutionPresetPaths(dshHome).targetDir
    await writeFile(path.join(target, 'extra.txt'), 'x\n', 'utf8')
    const result = await materializeEvolutionPreset({
      dshHome,
      enabled: true,
      templateDir,
      templateVersion: '2',
    })
    expect(result.status).toBe('preserved')
    expect(await readFile(path.join(target, 'extra.txt'), 'utf8')).toBe('x\n')
  })

  it('restores the backup when the second rename fails', async () => {
    const root = await tempDir('autoevo-preset-swap-fail')
    const dshHome = path.join(root, 'dsh')
    const templateDir = await writeTemplate(root, baseTemplate)
    await materializeEvolutionPreset({ dshHome, enabled: true, templateDir })
    const original = await readFile(
      path.join(resolveEvolutionPresetPaths(dshHome).targetDir, 'preset.yml'),
      'utf8',
    )

    const nextTemplate = await writeTemplate(path.join(root, 'next'), {
      ...baseTemplate,
      'preset.yml': 'name: should-not-land\n',
    })

    let renameCount = 0
    await expect(materializeEvolutionPreset({
      dshHome,
      enabled: true,
      templateDir: nextTemplate,
      templateVersion: '2',
      rename: async (from, to) => {
        renameCount += 1
        // First rename is target -> backup (allow). Second is staging -> target (fail).
        if (renameCount === 2) throw new Error('simulated second rename failure')
        await rename(from, to)
      },
    })).rejects.toThrow(/simulated second rename failure/u)

    const restored = await readFile(
      path.join(resolveEvolutionPresetPaths(dshHome).targetDir, 'preset.yml'),
      'utf8',
    )
    expect(restored).toBe(original)
  })

  it('rejects path containment escapes', () => {
    const home = path.resolve(path.join(os.tmpdir(), 'autoevo-home-contain'))
    const paths = resolveEvolutionPresetPaths(home)
    expect(() => _testing.assertContained(paths.presetsRoot, path.join(paths.presetsRoot, '..', 'escape'), 'x'))
      .toThrow(/containment/u)
  })

  it('verifyPristine and buildManifest helpers agree with installed content', async () => {
    const root = await tempDir('autoevo-preset-helpers')
    const dshHome = path.join(root, 'dsh')
    const templateDir = await writeTemplate(root, baseTemplate)
    await materializeEvolutionPreset({ dshHome, enabled: true, templateDir })
    const target = resolveEvolutionPresetPaths(dshHome).targetDir
    const hashes = {
      'preset.yml': sha256(Buffer.from(baseTemplate['preset.yml'])),
      'agent.cordis.yml': sha256(Buffer.from(baseTemplate['agent.cordis.yml'])),
    }
    const manifest = buildManifest(hashes)
    await expect(verifyPristine(target, manifest)).resolves.toEqual({ ok: true })
  })

  it('never follows linked entries while verifying or cleaning an owned temp tree', async () => {
    const root = await tempDir('autoevo-preset-link')
    const outside = path.join(root, 'outside')
    await mkdir(outside, { recursive: true })
    await writeFile(path.join(outside, 'keep.txt'), 'keep\n', 'utf8')

    const tree = path.join(root, 'presets', '.evolution.backup-link')
    await mkdir(tree, { recursive: true })
    await writeFile(path.join(tree, EVOLUTION_PRESET_MANIFEST_FILENAME), '{}\n', 'utf8')
    await writeFile(path.join(tree, 'agent.cordis.yml'), 'agent\n', 'utf8')
    await symlink(outside, path.join(tree, 'preset.yml'), 'junction')

    const manifest = buildManifest({
      'preset.yml': sha256(Buffer.from('anything')),
      'agent.cordis.yml': sha256(Buffer.from('agent\n')),
    })
    await expect(verifyPristine(tree, manifest)).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining('linked entry'),
    })

    await _testing.cleanupOwnedTree(tree, path.dirname(tree))
    expect(await readFile(path.join(outside, 'keep.txt'), 'utf8')).toBe('keep\n')
    await expect(readFile(path.join(tree, 'agent.cordis.yml'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })
})
