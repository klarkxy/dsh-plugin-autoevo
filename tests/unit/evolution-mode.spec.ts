import { describe, expect, it, vi } from 'vitest'
import {
  apply,
  AUTOEVO_AUTONOMY_CONTRACT,
  name,
  inject,
  readEvolutionModeMarker,
} from '../../src/evolution-mode.js'
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
    expect(inject).toEqual([])
  })

  it('provides only the scoped marker so the root autonomy contract is not duplicated', () => {
    const { ctx, register, section, provide } = mockContext()
    apply(ctx)

    expect(register).not.toHaveBeenCalled()

    expect(section).not.toHaveBeenCalled()
    expect(AUTOEVO_AUTONOMY_CONTRACT).toContain('runtime Policy V11')
    expect(AUTOEVO_AUTONOMY_CONTRACT).toContain('supposedly temporary capability')
    expect(AUTOEVO_AUTONOMY_CONTRACT).toContain('Host captures the latest top-level user message verbatim')
    expect(AUTOEVO_AUTONOMY_CONTRACT).toContain('one clarification_question')
    expect(AUTOEVO_AUTONOMY_CONTRACT).toContain('zero candidates is a valid result')
    expect(AUTOEVO_AUTONOMY_CONTRACT).toContain('Public decisions never accept retention')
    expect(AUTOEVO_AUTONOMY_CONTRACT).toContain('normal DSH-permitted tools, shell commands, builds, tests, dependency adjustment, skills, and collaboration')
    expect(AUTOEVO_AUTONOMY_CONTRACT).toContain('Pre-V11 unfinished workflows')

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
