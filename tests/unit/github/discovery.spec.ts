import { describe, expect, it } from 'vitest'
import { validateGithubRepository } from '../../../src/github/discovery.js'

describe('GitHub repository identifiers', () => {
  it('accepts only strict owner/repository identifiers', () => {
    expect(validateGithubRepository('owner/repo-name')).toBe('owner/repo-name')
    for (const invalid of ['https://github.com/owner/repo', '../repo', 'owner/repo/extra', 'owner\\repo', 'owner/../repo']) {
      expect(() => validateGithubRepository(invalid)).toThrow('strict owner/repository')
    }
  })
})
