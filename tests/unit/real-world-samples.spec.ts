import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

type AutomationStatus = 'implemented' | 'real-live-passed' | 'planned'

interface Sample {
  id: string
  title: string
  user_turns: string[]
  coverage_categories: string[]
  fixture: string
  success_evidence: {
    kind: 'live_dsh_session' | 'automated_test' | 'test_plan'
    reference?: string
    session_id?: string
    workflow_id?: string
    assertion: string
  }
  cleanup: string[]
  automation: { status: AutomationStatus; reference: string }
}

interface SamplesFile {
  schema_version: number
  minimum_recommended_ids: string[]
  samples: Sample[]
}

const EXPECTED_IDS = [
  'reuse-local-unchanged',
  'stop-after-review',
  'remote-verified-install',
  'installed-upgrade-replacement',
  'failed-install-repair',
  'scratch-create-and-install',
  'sealed-install-failure-recovery',
  'manual-runtime-and-completed-restart',
]

function repositoryPath(...parts: string[]): string {
  return join(dirname(fileURLToPath(import.meta.url)), '../..', ...parts)
}

describe('real-world sample catalog', () => {
  it('keeps eight uniquely identified, maintainable user paths', () => {
    const path = repositoryPath('tests', 'fixtures', 'real-world-samples.json')
    const raw = JSON.parse(readFileSync(path, 'utf8')) as SamplesFile

    expect(raw.schema_version).toBe(1)
    expect(raw.samples).toHaveLength(EXPECTED_IDS.length)
    expect(raw.samples.map((sample) => sample.id)).toEqual(EXPECTED_IDS)

    for (const sample of raw.samples) {
      expect(sample.title.length).toBeGreaterThan(0)
      expect(sample.user_turns.length).toBeGreaterThanOrEqual(2)
      expect(sample.user_turns.every((turn) => /[\u3400-\u9fff]/u.test(turn))).toBe(true)
      expect(sample.coverage_categories.length).toBeGreaterThan(0)
      expect(sample.fixture.length).toBeGreaterThan(0)
      expect(sample.success_evidence.assertion.length).toBeGreaterThan(0)
      expect(sample.cleanup.length).toBeGreaterThan(0)
      expect(sample.cleanup.every((step) => step.length > 0)).toBe(true)
      expect(['implemented', 'real-live-passed', 'planned']).toContain(sample.automation.status)
      expect(sample.automation.reference.length).toBeGreaterThan(0)
    }
  })

  it('keeps the recommended starter set complete and runnable from automated coverage', () => {
    const raw = JSON.parse(readFileSync(repositoryPath('tests', 'fixtures', 'real-world-samples.json'), 'utf8')) as SamplesFile
    expect(raw.minimum_recommended_ids).toEqual([
      'reuse-local-unchanged',
      'stop-after-review',
      'remote-verified-install',
      'failed-install-repair',
      'scratch-create-and-install',
    ])
    expect(new Set(raw.minimum_recommended_ids).size).toBe(raw.minimum_recommended_ids.length)

    const byId = new Map(raw.samples.map((sample) => [sample.id, sample]))
    for (const id of raw.minimum_recommended_ids) {
      const sample = byId.get(id)
      expect(sample).toBeDefined()
      expect(sample!.automation.status).not.toBe('planned')
    }
  })

  it('does not represent plans or fixture tests as live DSH success', () => {
    const raw = JSON.parse(readFileSync(repositoryPath('tests', 'fixtures', 'real-world-samples.json'), 'utf8')) as SamplesFile
    const liveSamples = raw.samples.filter((sample) => sample.automation.status === 'real-live-passed')
    expect(liveSamples).toHaveLength(2)
    expect(liveSamples[0]).toMatchObject({
      id: 'reuse-local-unchanged',
      success_evidence: {
        kind: 'live_dsh_session',
        session_id: 'session-c4c5d09d-03ad-4c52-8657-a58c930db1d2',
        workflow_id: 'workflow_51eaaa4f1713af0e00890069',
      },
    })
    expect(liveSamples[1]).toMatchObject({
      id: 'failed-install-repair',
      success_evidence: {
        kind: 'live_dsh_session',
        session_id: 'session-af8d6384-6c1c-4b2a-af69-94c8044fae83',
        workflow_id: 'workflow_afb5a08eed8e5fa45dba77f4',
      },
    })

    for (const sample of raw.samples.filter((entry) => entry.automation.status === 'planned')) {
      expect(sample.success_evidence.kind).not.toBe('live_dsh_session')
      expect(sample.success_evidence.session_id).toBeUndefined()
      expect(sample.success_evidence.workflow_id).toBeUndefined()
    }
  })

  it('contains no obsolete Host-launched child construction claim', () => {
    const sources = [
      readFileSync(repositoryPath('tests', 'fixtures', 'real-world-samples.json'), 'utf8'),
      readFileSync(repositoryPath('docs', 'real-world-samples.md'), 'utf8'),
      readFileSync(repositoryPath('evals', 'evals.json'), 'utf8'),
    ]
    expect(sources.join('\n')).not.toMatch(/Host-launched child|Host-child grant|workspace-write child/u)
  })
})
