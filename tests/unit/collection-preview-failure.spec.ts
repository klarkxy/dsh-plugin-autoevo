import { describe, expect, it, vi } from 'vitest'
import type { ResolutionRecord } from '../../src/contracts.js'
import { EvolutionError } from '../../src/errors.js'
import { previewGithubPlugins } from '../../src/review/review.js'
import { CapabilityEvolutionService } from '../../src/service.js'
import type { WorkflowExec } from '../../src/workflow/contracts.js'

vi.mock('../../src/review/review.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/review/review.js')>()
  return { ...actual, previewGithubPlugins: vi.fn() }
})

describe('collection preview failures', () => {
  it('preserves bounded package paths returned by the cached preview layer', async () => {
    const packagePaths = Array.from({ length: 6 }, (_, index) => `packages/plugin-${index + 1}`)
    vi.mocked(previewGithubPlugins).mockRejectedValueOnce(new EvolutionError(
      'invalid_input',
      'Repository contains more than five reviewable plugin packages',
      { packagePaths },
    ))
    const service = {
      runner: {},
      config: {},
    } as unknown as CapabilityEvolutionService
    const resolution = {
      cwd: 'C:/workspace',
      remoteCandidates: [{ repository: 'small-tail/whale', defaultBranch: 'main' }],
    } as ResolutionRecord

    const result = await CapabilityEvolutionService.prototype.previewGithubCandidates.call(
      service,
      resolution,
      [{ candidateId: `candidate_${'a'.repeat(24)}`, repository: 'small-tail/whale' }],
      {} as WorkflowExec,
    )

    expect(result.failures).toEqual([expect.objectContaining({ packagePaths })])
  })
})
