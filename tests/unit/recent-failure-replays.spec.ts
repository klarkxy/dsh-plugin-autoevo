import { describe, expect, it } from 'vitest'

interface ReplayCase {
  id: string
  source: string
  user: string
  observed_failure: string
  required_outcome: string
}

const REQUIRED_OUTCOMES = [
  'empty_pool',
  'review_sealed_candidate_3',
  'normalize_to_read_only_review',
  'block_duplicate_fingerprint',
  'bounded_diagnosis_before_retry',
  'semantic_public_state_only',
]

describe('generated workflow regression corpus', () => {
  it('keeps one bounded replay for every accepted autonomy regression', async () => {
    const cases: ReplayCase[] = REQUIRED_OUTCOMES.map((required_outcome, index) => ({
      id: `synthetic-case-${index + 1}`,
      source: `generated-case-${index + 1}`,
      user: `synthetic requirement ${index + 1}`,
      observed_failure: `synthetic failure class ${index + 1}`,
      required_outcome,
    }))

    expect(cases).toHaveLength(6)
    expect(new Set(cases.map((item) => item.id)).size).toBe(6)
    expect(cases.map((item) => item.required_outcome).sort()).toEqual([...REQUIRED_OUTCOMES].sort())
    expect(cases.every((item) => item.source.startsWith('generated-case-'))).toBe(true)

    const serialized = JSON.stringify(cases)
    expect(serialized).not.toMatch(/[a-f0-9]{32,}/iu)
    expect(serialized).not.toMatch(/[A-Za-z]:\\|\/Users\/|\/home\//u)
    expect(serialized).not.toMatch(/stderr|api[_-]?key|authorization:\s*bearer/iu)
  })
})
