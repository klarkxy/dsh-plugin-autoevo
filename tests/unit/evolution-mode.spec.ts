import { describe, expect, it, vi } from 'vitest'
import { apply, name, inject, readEvolutionModeMarker } from '../../src/evolution-mode.js'
import { creatorSkillRegistration } from '../../src/creator-skill.js'
import {
  EVOLUTION_MODE_OWNER,
  EVOLUTION_MODE_PROTOCOL_VERSION,
  EVOLUTION_MODE_SERVICE_KEY,
  createEvolutionModeMarker,
  isEvolutionModeMarker,
} from '../../src/evolution-contracts.js'

function mockContext(overrides?: {
  getValue?: unknown
}) {
  const register = vi.fn<(registration: ReturnType<typeof creatorSkillRegistration>) => () => void>()
  register.mockReturnValue(() => undefined)
  const section = vi.fn<(input: { name: string; order: number; text: string }) => () => void>()
  section.mockReturnValue(() => undefined)
  const provide = vi.fn<(name: string, value: unknown) => () => void>()
  provide.mockReturnValue(() => undefined)
  const get = vi.fn((name?: string) => {
    void name
    return overrides?.getValue
  })
  const ctx = {
    skills: { register },
    systemPrompt: { section },
    provide,
    get,
  }
  return { ctx: ctx as never, register, section, provide, get }
}

describe('evolution-mode entry', () => {
  it('exports the scoped Cordis plugin name and inject list', () => {
    expect(name).toBe('autoevo-evolution-mode')
    expect(inject).toEqual(['systemPrompt'])
  })

  it('registers workflow instructions without exposing a parent Creator skill', () => {
    const { ctx, register, section, provide } = mockContext()
    apply(ctx)

    expect(register).not.toHaveBeenCalled()

    expect(section).toHaveBeenCalledTimes(1)
    const prompt = section.mock.calls[0]![0]
    expect(prompt.name).toBe('autoevo:evolution-mode')
    expect(prompt.order).toBe(119)
    expect(prompt.text).toContain('Capability Evolution')
    expect(prompt.text).toContain('capability_workflow')
    expect(prompt.text).toContain('candidate IDs')
    expect(prompt.text).toContain('navigation')
    expect(prompt.text).toContain('decision')
    expect(prompt.text).toContain('does not re-parse')
    expect(prompt.text).toContain('candidate_id')
    expect(prompt.text).toContain('Security findings are static observations only')
    expect(prompt.text).toContain('callback-server behavior')
    expect(prompt.text).toContain('create_authorized')
    expect(prompt.text).toContain('managed git source')
    expect(prompt.text).toContain('workflow_id')
    expect(prompt.text).toContain('interrupt_id')
    expect(prompt.text).toContain('never via parent-session')
    expect(prompt.text).toContain('do not inspect Cordis')
    expect(prompt.text).toContain('contributionAdvice')
    expect(prompt.text).toContain('contribute only after explicit approval')
    expect(prompt.text).toContain('Policy V5')
    expect(prompt.text).toContain('MechanicalFacts')
    expect(prompt.text).toContain('semantic verifier')
    expect(prompt.text).toContain('taskResultMatchedExpectation')
    expect(prompt.text).toContain('use_this and search_more')
    expect(prompt.text).not.toContain('scratch_ready')

    expect(provide).toHaveBeenCalledTimes(1)
    expect(provide.mock.calls[0]![0]).toBe(EVOLUTION_MODE_SERVICE_KEY)
    const marker = provide.mock.calls[0]![1]
    expect(isEvolutionModeMarker(marker)).toBe(true)
    expect(marker).toEqual({
      owner: EVOLUTION_MODE_OWNER,
      protocolVersion: EVOLUTION_MODE_PROTOCOL_VERSION,
    })
    expect(marker).toEqual(createEvolutionModeMarker())
  })

  it('readEvolutionModeMarker returns a typed marker only when the service payload matches', () => {
    const good = mockContext({ getValue: createEvolutionModeMarker() })
    expect(readEvolutionModeMarker(good.ctx)).toEqual({
      owner: EVOLUTION_MODE_OWNER,
      protocolVersion: EVOLUTION_MODE_PROTOCOL_VERSION,
    })
    expect(good.get).toHaveBeenCalledWith(EVOLUTION_MODE_SERVICE_KEY)

    const bad = mockContext({ getValue: { owner: 'other', protocolVersion: 1 } })
    expect(readEvolutionModeMarker(bad.ctx)).toBeUndefined()

    const decorated = mockContext({
      getValue: { ...createEvolutionModeMarker(), foreign: true },
    })
    expect(readEvolutionModeMarker(decorated.ctx)).toBeUndefined()

    const missing = mockContext({ getValue: undefined })
    expect(readEvolutionModeMarker(missing.ctx)).toBeUndefined()
  })
})
