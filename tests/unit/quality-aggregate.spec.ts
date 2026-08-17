import { describe, expect, it } from 'vitest'
import { aggregateRepository } from '../../quality/src/aggregate.js'
import { parseObservationBatch, type QualityObservation } from '../../quality/src/protocol.js'

function observation(overrides: Partial<QualityObservation> & Pick<QualityObservation, 'id' | 'outcome' | 'stage'>): QualityObservation {
  return {
    schemaVersion: 1,
    createdAt: '2026-08-17T00:00:00.000Z',
    repository: 'acme/plugin',
    commit: 'a'.repeat(40),
    localModification: false,
    policyVersion: 'v6-2026-08-17',
    autoevoVersion: '0.5.0',
    dshVersion: '0.1.0-rc.6',
    reasonCodes: [],
    securityRisk: 'low',
    repairability: null,
    evolutionValue: null,
    ...overrides,
  }
}

describe('quality observation batch', () => {
  it('accepts one batched POST and rejects unknown fields by rebuilding the allowlist', () => {
    const parsed = parseObservationBatch({
      schemaVersion: 1,
      observations: [{
        schemaVersion: 1,
        id: `quality_${'ab'.repeat(16)}`,
        createdAt: '2026-08-17T00:00:00.000Z',
        repository: 'acme/plugin',
        commit: 'a'.repeat(40),
        localModification: false,
        policyVersion: 'v6-2026-08-17',
        autoevoVersion: '0.5.0',
        dshVersion: '0.1.0-rc.6',
        stage: 'review',
        outcome: 'repairable',
        reasonCodes: ['fit_partial'],
        securityRisk: 'low',
        repairability: 'repairable',
        evolutionValue: 'high',
        requirement: 'PRIVATE',
        delivery: { status: 'pending' },
      }],
    })
    expect(parsed).toHaveLength(1)
    expect(parsed?.[0]).not.toHaveProperty('requirement')
    expect(parsed?.[0]).not.toHaveProperty('delivery')
  })
})

describe('quality aggregation', () => {
  it('does not mark junk or broken from a single verification failure', () => {
    const assessment = aggregateRepository('acme/plugin', [
      observation({
        id: `quality_${'11'.repeat(16)}`,
        stage: 'verification',
        outcome: 'verification_failed',
        reasonCodes: ['exit_nonzero'],
      }),
    ])
    expect(assessment.classification).toBe('unknown')
  })

  it('marks broken only after several independent failures', () => {
    const observations = [0, 1, 2].map((index) => observation({
      id: `quality_${String(index).repeat(32)}`,
      commit: String(index).repeat(40),
      createdAt: `2026-08-0${index + 1}T00:00:00.000Z`,
      stage: 'verification',
      outcome: 'verification_failed',
      reasonCodes: ['exit_nonzero'],
    }))
    expect(aggregateRepository('acme/plugin', observations).classification).toBe('broken')
  })

  it('keeps repairable reviews visible instead of collapsing them to junk', () => {
    const assessment = aggregateRepository('acme/plugin', [
      observation({
        id: `quality_${'22'.repeat(16)}`,
        stage: 'review',
        outcome: 'repairable',
        repairability: 'repairable',
        evolutionValue: 'high',
        reasonCodes: ['recommendation_modify'],
      }),
    ])
    expect(assessment.classification).toBe('repairable')
  })
})
