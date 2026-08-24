import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  EVOLUTION_MODE_PACKAGE_EXPORT,
  EVOLUTION_MODE_SERVICE_KEY,
  EVOLUTION_PRESET_DESCRIPTION,
  EVOLUTION_PRESET_DISPLAY_NAME,
  EVOLUTION_PRESET_KNOWN_MANIFESTS,
  EVOLUTION_PRESET_TEMPLATE_VERSION,
} from '../../src/evolution-contracts.js'

const presetRoot = join(dirname(fileURLToPath(import.meta.url)), '../../presets/evolution')

function managedFileHash(name: string): string {
  const normalized = readFileSync(join(presetRoot, name), 'utf8')
    .replace(/\r\n/gu, '\n')
    .replace(/\r/gu, '\n')
  return createHash('sha256').update(normalized, 'utf8').digest('hex')
}

describe('evolution preset template', () => {
  it('declares Capability Evolution metadata', () => {
    const preset = parse(readFileSync(join(presetRoot, 'preset.yml'), 'utf8')) as {
      name?: string
      description?: string
      order?: number
    }
    expect(preset.name).toBe(EVOLUTION_PRESET_DISPLAY_NAME)
    expect(preset.description).toBe(EVOLUTION_PRESET_DESCRIPTION)
    expect(preset.order).toBe(5)
  })

  it('composes Cordis tools with the scoped AutoEvo evolution-mode entry', () => {
    const composition = readFileSync(join(presetRoot, 'agent.cordis.yml'), 'utf8')

    expect(composition).toContain(EVOLUTION_MODE_PACKAGE_EXPORT)
    expect(composition).toContain('id: autoevo-evolution-mode')
    expect(composition).toMatch(
      new RegExp(`isolate:\\s*\\n\\s*${EVOLUTION_MODE_SERVICE_KEY}:\\s*true`, 'u'),
    )

    expect(composition).toContain('id: tool-cordis')
    expect(composition).toContain("name: '@deepseek-ai/dsh-tool-cordis'")
    expect(composition).toContain('id: tool-fs')
    expect(composition).toContain("name: '@deepseek-ai/dsh-tool-fs'")
    expect(composition).toContain('id: tool-skill')
    expect(composition).toContain("name: '@deepseek-ai/dsh-tool-skill'")

    expect(composition).toContain('editing-cordis-compositions')
    expect(composition).toMatch(/^\s*customSkillDirs\s*:/mu)
    expect(composition).toMatch(/skills\/cordis-plugin-development|skills\/'/u)
    expect(composition).toContain('id: delegation')
    expect(composition).toContain('id: tool-subagent')
    expect(composition).toContain('id: tool-workflow')
    expect(composition).toContain('id: tool-ralph')
  })

  it('keeps persona natural and leaves the single autonomy contract to the root plugin', () => {
    const composition = readFileSync(join(presetRoot, 'agent.cordis.yml'), 'utf8')
    expect(composition).toContain('Exercise professional judgment')
    expect(composition).toContain('communicate naturally')
    expect(composition).toContain('Load the `editing-cordis-compositions` skill')
    expect(composition).toContain('Two planes decide where an edit belongs')
    expect(composition).toContain('awaiting a user test')
    expect(composition).not.toContain('AutoEvo autonomy contract:')
    expect(composition).not.toMatch(/workflow_id|interrupt_id|candidate_id|next_step|agent_directive/u)
    expect(composition).not.toMatch(/navigation|use_this|search_more|create_authorized|managed git source/u)
  })

  it('trusts only the exact current clean-slate template', () => {
    expect(EVOLUTION_PRESET_TEMPLATE_VERSION).toBe('14')
    expect(EVOLUTION_PRESET_KNOWN_MANIFESTS).toEqual([{
      owner: 'dsh-plugin-autoevo',
      schemaVersion: 1,
      templateVersion: '13',
      files: {
        'agent.cordis.yml': '521d2133694c5642e3e78fcd5ddfa7f2d7af6eab80244fdd2c22030dd586d55c',
        'preset.yml': 'd51f8ab85feeb76c73de0cb091735b7ddbdad4d2b3d8adfc878dd35b6e79bbbd',
      },
    }])
    expect(managedFileHash('agent.cordis.yml')).toBe('0a1352f1dd4e68abf01a6c80f23be30aeb239294071207cc225815bfffa17c5b')
    expect(managedFileHash('preset.yml')).toBe('c3e8587363b21edeba9c36e4009c8496c0938144f5c552e489ffda3b5316c4a4')
    expect(managedFileHash('skills/cordis-plugin-development/SKILL.md')).toBe('01811d3ee9c03a466abae12d54d229e7de7bd74ca6b730c54ce9d5e696b294aa')
    expect(managedFileHash('skills/editing-cordis-compositions/SKILL.md')).toBe('b223233e9df5c8cbedeb7dee8d38ddc47d545af54b323abe3830f4748b688f6c')
  })
})
