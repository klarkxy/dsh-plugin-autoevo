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

    expect(composition).toMatch(/^\s*customSkillDirs\s*:/mu)
    expect(composition).toMatch(/skills\/cordis-plugin-development|skills\/'/u)
    expect(composition).toMatch(/- id: delegation\s+[\s\S]*?workflowEngine: true/u)
    expect(composition).toContain('id: tool-subagent')
    expect(composition).toContain('id: tool-workflow')
    expect(composition).toContain('id: tool-ralph')
  })

  it('keeps persona natural and leaves the single autonomy contract to the root plugin', () => {
    const composition = readFileSync(join(presetRoot, 'agent.cordis.yml'), 'utf8')
    expect(composition).toContain('Exercise professional judgment')
    expect(composition).toContain('communicate naturally')
    expect(composition).toContain('Every capability request, including a temporary experiment')
    expect(composition).toContain('Two planes decide where an edit belongs')
    expect(composition).toContain('you may use the normal tools, shell, builds, tests, dependency changes, skills, and collaborators')
    expect(composition).not.toContain('AutoEvo autonomy contract:')
    expect(composition).not.toMatch(/workflow_id|interrupt_id|candidate_id|next_step|agent_directive/u)
  })

  it('trusts only the exact current clean-slate template', () => {
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
    expect(EVOLUTION_PRESET_KNOWN_MANIFESTS[3]).toMatchObject({
      templateVersion: '16',
      files: { 'agent.cordis.yml': '334f46d87e6f071a9db0da7b334010b1ff20e59996584ba27564f3cb77eb0d86' },
    })
    expect(EVOLUTION_PRESET_KNOWN_MANIFESTS[4]).toMatchObject({
      templateVersion: '17',
      files: { 'agent.cordis.yml': 'b0cbe8d0a90bbfd1a554c9df94d050d0dc5d04da0c908a04636657eba8c2b508' },
    })
    expect(managedFileHash('agent.cordis.yml')).toMatch(/^[a-f0-9]{64}$/u)
    expect(managedFileHash('preset.yml')).toMatch(/^[a-f0-9]{64}$/u)
    expect(managedFileHash('skills/cordis-plugin-development/SKILL.md')).toBe('5b2f44c10d88b4fc1612454798f8f95cec477686260e52e4277fc436be905d7b')
    expect(managedFileHash('skills/editing-cordis-compositions/SKILL.md')).toBe('2b7101ad02046396fe2ef594703bc7bd5489310272a8048876972dcf91abb890')
  })
})
