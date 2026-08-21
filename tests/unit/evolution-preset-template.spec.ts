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

    expect(composition).not.toContain('editing-cordis-compositions')
    expect(composition).not.toMatch(/^\s*customSkillDirs\s*:/mu)
    expect(composition).not.toMatch(/skills\/cordis-plugin-development/u)
    expect(composition).not.toMatch(/skills\/editing-cordis-compositions/u)
  })

  it('keeps persona natural and leaves the single autonomy contract to the root plugin', () => {
    const composition = readFileSync(join(presetRoot, 'agent.cordis.yml'), 'utf8')
    expect(composition).toContain('Exercise professional judgment')
    expect(composition).toContain('communicate naturally')
    expect(composition).toContain('Policy V8')
    expect(composition).toContain('awaiting a user test')
    expect(composition).not.toContain('AutoEvo autonomy contract:')
    expect(composition).not.toMatch(/workflow_id|interrupt_id|candidate_id|next_step|agent_directive/u)
    expect(composition).not.toMatch(/navigation|use_this|search_more|create_authorized|managed git source/u)
  })

  it('trusts only the exact current clean-slate template', () => {
    expect(EVOLUTION_PRESET_TEMPLATE_VERSION).toBe('12')
    expect(EVOLUTION_PRESET_KNOWN_MANIFESTS).toEqual([{
      owner: 'dsh-plugin-autoevo',
      schemaVersion: 1,
      templateVersion: EVOLUTION_PRESET_TEMPLATE_VERSION,
      files: {
        'agent.cordis.yml': managedFileHash('agent.cordis.yml'),
        'preset.yml': managedFileHash('preset.yml'),
      },
    }])
  })
})
