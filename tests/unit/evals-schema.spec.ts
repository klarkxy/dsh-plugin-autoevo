import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

interface EvalCase {
  id: string
  prompt: string
  expected_output: string
  assertions: string[]
}

interface EvalsFile {
  skill_name: string
  evals: EvalCase[]
}

describe('evals/evals.json schema', () => {
  it('is structurally valid and keeps the six baseline cases', () => {
    const path = join(dirname(fileURLToPath(import.meta.url)), '../../evals/evals.json')
    const raw = JSON.parse(readFileSync(path, 'utf8')) as EvalsFile
    expect(raw.skill_name).toBe('autoevo-plugin-creator')
    expect(Array.isArray(raw.evals)).toBe(true)
    expect(raw.evals).toHaveLength(6)

    const ids = new Set<string>()
    for (const item of raw.evals) {
      expect(typeof item.id).toBe('string')
      expect(item.id.length).toBeGreaterThan(0)
      expect(ids.has(item.id)).toBe(false)
      ids.add(item.id)
      expect(typeof item.prompt).toBe('string')
      expect(item.prompt.length).toBeGreaterThan(0)
      expect(typeof item.expected_output).toBe('string')
      expect(item.expected_output.length).toBeGreaterThan(0)
      expect(Array.isArray(item.assertions)).toBe(true)
      expect(item.assertions.length).toBeGreaterThan(0)
      for (const assertion of item.assertions) {
        expect(typeof assertion).toBe('string')
        expect(assertion.length).toBeGreaterThan(0)
      }
    }

    expect(ids).toEqual(new Set([
      'reuse-local-capability',
      'scratch-authorized-host-tool',
      'existing-plugin-update',
      'client-slot-ui',
      'repair-and-rollback',
      'near-miss-static-package-release',
    ]))
  })
})
