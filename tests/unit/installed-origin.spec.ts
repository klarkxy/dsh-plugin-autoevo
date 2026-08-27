import { describe, expect, it } from 'vitest'
import { evolutionTargetFromProfile, parseExactGithubDependency } from '../../src/resolver/installed-origin.js'

const SHA = '5'.repeat(40)

describe('installed origin parser', () => {
  it('accepts only github owner/repo with a 40-character SHA', () => {
    expect(parseExactGithubDependency(`github:anonymous-lab/dsh-plugin-alpha#${SHA}`)).toEqual({
      repository: 'anonymous-lab/dsh-plugin-alpha',
      commit: SHA,
    })
    expect(parseExactGithubDependency('github:anonymous-lab/dsh-plugin-alpha#main')).toBeUndefined()
    expect(parseExactGithubDependency(`github:anonymous-lab/dsh-plugin-alpha#${SHA.slice(0, 7)}`)).toBeUndefined()
    expect(parseExactGithubDependency('https://github.com/anonymous-lab/dsh-plugin-alpha')).toBeUndefined()
    expect(parseExactGithubDependency('dsh-plugin-alpha@1.2.3')).toBeUndefined()
    expect(parseExactGithubDependency('file:C:/tmp/dsh-plugin-alpha.tgz')).toBeUndefined()
  })

  it('does not treat a local or branch profile spec as evolution provenance', () => {
    expect(evolutionTargetFromProfile({
      packageName: 'dsh-plugin-alpha',
      profile: 'web',
      dependencySpec: 'github:anonymous-lab/dsh-plugin-alpha#main',
    })).toBeUndefined()
    expect(evolutionTargetFromProfile({
      packageName: 'dsh-plugin-alpha',
      profile: 'web',
      dependencySpec: 'file:[local-reference]',
    })).toBeUndefined()
    expect(evolutionTargetFromProfile({
      packageName: 'dsh-plugin-alpha',
      profile: 'web',
      dependencySpec: `github:anonymous-lab/dsh-plugin-alpha#${SHA}`,
    })).toMatchObject({
      kind: 'github_exact',
      repository: 'anonymous-lab/dsh-plugin-alpha',
      commit: SHA,
      packageName: 'dsh-plugin-alpha',
    })
  })
})
