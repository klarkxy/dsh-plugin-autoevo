import { describe, expect, it } from 'vitest'
import { evolutionTargetFromProfile, parseExactGithubDependency } from '../../src/resolver/installed-origin.js'

const SHA = '5'.repeat(40)

describe('installed origin parser', () => {
  it('accepts only github owner/repo with a 40-character SHA', () => {
    expect(parseExactGithubDependency(`github:MirDie/dsh-xai#${SHA}`)).toEqual({
      repository: 'MirDie/dsh-xai',
      commit: SHA,
    })
    expect(parseExactGithubDependency('github:MirDie/dsh-xai#main')).toBeUndefined()
    expect(parseExactGithubDependency(`github:MirDie/dsh-xai#${SHA.slice(0, 7)}`)).toBeUndefined()
    expect(parseExactGithubDependency('https://github.com/MirDie/dsh-xai')).toBeUndefined()
    expect(parseExactGithubDependency('dsh-xai@1.2.3')).toBeUndefined()
    expect(parseExactGithubDependency('file:C:/tmp/dsh-xai.tgz')).toBeUndefined()
  })

  it('does not treat a local or branch profile spec as evolution provenance', () => {
    expect(evolutionTargetFromProfile({
      packageName: 'dsh-xai',
      profile: 'web',
      dependencySpec: 'github:MirDie/dsh-xai#main',
    })).toBeUndefined()
    expect(evolutionTargetFromProfile({
      packageName: 'dsh-xai',
      profile: 'web',
      dependencySpec: 'file:[local-reference]',
    })).toBeUndefined()
    expect(evolutionTargetFromProfile({
      packageName: 'dsh-xai',
      profile: 'web',
      dependencySpec: `github:MirDie/dsh-xai#${SHA}`,
    })).toMatchObject({
      kind: 'github_exact',
      repository: 'MirDie/dsh-xai',
      commit: SHA,
      packageName: 'dsh-xai',
    })
  })
})
