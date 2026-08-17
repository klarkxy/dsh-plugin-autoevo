import { describe, expect, it } from 'vitest'
import { E2E_CALCULATOR_REPOSITORY, targetRepository } from '../fixtures/scripted-llm.mjs'

describe('e2e calculator target', () => {
  it('reviews the official calculator even when live search ranks an unrelated plugin first', () => {
    expect(targetRepository({
      selectedRepositories: ['EchoUser005/dsh-fate-spectrum'],
      remoteCandidates: [
        { repository: 'EchoUser005/dsh-fate-spectrum', name: 'dsh-fate-spectrum' },
      ],
    })).toBe(E2E_CALCULATOR_REPOSITORY)
  })
})

