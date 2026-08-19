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
} from '../../src/evolution-contracts.js'

const presetRoot = join(dirname(fileURLToPath(import.meta.url)), '../../presets/evolution')

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

  it('persona teaches reuse-before-create with Host interrupt resume and managed-child boundaries', () => {
    const composition = readFileSync(join(presetRoot, 'agent.cordis.yml'), 'utf8')
    expect(composition).toContain('Capability Evolution')
    expect(composition).toContain('reuse first')
    expect(composition).toContain('capability_workflow')
    expect(composition).toContain('capability_workflow_resume')
    expect(composition).toContain('workflow_id')
    expect(composition).toContain('interrupt_id')
    expect(composition).not.toContain('Load autoevo-plugin-creator')
    expect(composition).toContain('candidate IDs')
    expect(composition).toContain('navigation')
    expect(composition).toContain('decision')
    expect(composition).toContain('does not re-parse')
    expect(composition).toContain('candidate_id')
    expect(composition).toContain('Security findings are static observations only')
    expect(composition).toContain('callback-server behavior')
    expect(composition).toContain('managed git source')
    expect(composition).toContain('integrity-oriented partial isolation')
    expect(composition).not.toContain('scratch_ready')
    expect(composition).not.toContain('capability_resolve')
    expect(composition).not.toContain('matching option_id')
    expect(composition).toContain('Ordinary coding tools remain available')
    expect(composition).toContain('Policy V5')
    expect(composition).toContain('create_authorized')
    expect(composition).toContain('MechanicalFacts')
    expect(composition).toContain('use_this and search_more')
    expect(composition).toContain('taskResultMatchedExpectation')
    expect(composition).toContain('semantic verifier')
  })

  it('persona covers upgrading existing capabilities and upstream contribution', () => {
    const composition = readFileSync(join(presetRoot, 'agent.cordis.yml'), 'utf8')
    expect(composition).toContain('upgrade it in place instead of replacing it')
    expect(composition).toContain('origin repository and exact commit')
    expect(composition).toContain('remove the outdated installation by its receipt')
    expect(composition).toContain('contribute the improvement upstream')
    expect(composition).toContain('only after the user approves that specific step')
  })
})
