import type { Agent } from '@deepseek-ai/dsh-agent'
import { describe, expect, it, vi } from 'vitest'
import { createEvolutionModeMarker, EVOLUTION_MODE_SERVICE_KEY } from '../../src/evolution-contracts.js'
import { _testing } from '../../src/plugin-runtime.js'

const agent = { ctx: {} } as Agent

function contextFor(input: {
  preset?: string
  marker?: unknown
  throwOnLookup?: boolean
}) {
  const composedPreset = vi.fn(() => input.preset)
  const serviceFor = vi.fn(() => {
    if (input.throwOnLookup) throw new Error('lookup failed')
    return input.marker
  })
  const get = vi.fn((name: string) => name === 'agentPresets'
    ? { composedPreset, serviceFor }
    : undefined)
  return {
    ctx: { get } as never,
    composedPreset,
    serviceFor,
  }
}

describe('evolution mode runtime identity', () => {
  it('accepts only an evolution-mounted Agent with the exact isolated marker', () => {
    const genuine = contextFor({ preset: 'evolution', marker: createEvolutionModeMarker() })
    expect(_testing.createIsEvolutionMode(genuine.ctx)(agent)).toBe(true)
    expect(genuine.composedPreset).toHaveBeenCalledWith(agent.ctx)
    expect(genuine.serviceFor).toHaveBeenCalledWith(agent, EVOLUTION_MODE_SERVICE_KEY)

    const copied = contextFor({ preset: 'evolution-copy', marker: createEvolutionModeMarker() })
    expect(_testing.createIsEvolutionMode(copied.ctx)(agent)).toBe(false)
    expect(copied.serviceFor).not.toHaveBeenCalled()

    const lookalike = contextFor({ preset: 'evolution', marker: { owner: 'dsh-plugin-autoevo', protocolVersion: 1, foreign: true } })
    expect(_testing.createIsEvolutionMode(lookalike.ctx)(agent)).toBe(false)
  })

  it('fails closed when the roster or isolated lookup is unavailable', () => {
    expect(_testing.createIsEvolutionMode({ get: () => undefined } as never)(agent)).toBe(false)
    const throwing = contextFor({ preset: 'evolution', throwOnLookup: true })
    expect(_testing.createIsEvolutionMode(throwing.ctx)(agent)).toBe(false)
  })
})
