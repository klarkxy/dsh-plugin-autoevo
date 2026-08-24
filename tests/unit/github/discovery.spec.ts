import { describe, expect, it } from 'vitest'
import { validateGithubRepository, _testing } from '../../../src/github/discovery.js'

describe('GitHub repository identifiers', () => {
  it('accepts only strict owner/repository identifiers', () => {
    expect(validateGithubRepository('owner/repo-name')).toBe('owner/repo-name')
    for (const invalid of ['https://github.com/owner/repo', '../repo', 'owner/repo/extra', 'owner\\repo', 'owner/../repo']) {
      expect(() => validateGithubRepository(invalid)).toThrow('strict owner/repository')
    }
  })
})

describe('scoped GitHub query', () => {
  it('drops archived, forked, and disabled repositories', () => {
    expect(_testing.asCandidate({
      full_name: 'acme/old',
      name: 'old',
      archived: true,
      updated_at: '2026-01-01T00:00:00Z',
    })).toBeNull()
    expect(_testing.asCandidate({
      full_name: 'acme/fork',
      name: 'fork',
      fork: true,
      updated_at: '2026-01-01T00:00:00Z',
    })).toBeNull()
    expect(_testing.asCandidate({
      full_name: 'acme/ok',
      name: 'ok',
      description: 'calculator',
      stargazers_count: 3,
      updated_at: '2026-01-02T00:00:00Z',
      topics: ['search'],
      default_branch: 'main',
    })).toEqual(expect.objectContaining({
      repository: 'acme/ok',
      topics: ['dsh-plugin', 'search'],
      updatedAt: '2026-01-02T00:00:00Z',
      defaultBranch: 'main',
    }))
  })
})

