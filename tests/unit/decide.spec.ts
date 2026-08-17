import { describe, expect, it } from 'vitest'
import type { RemotePluginCandidate } from '../../src/contracts.js'
import { mentionedRepositories, resolveDecision } from '../../src/lifecycle/decide.js'

const remotes: RemotePluginCandidate[] = [
  {
    repository: 'MirDie/dsh-xai',
    name: 'dsh-xai',
    description: 'xAI Grok',
    stars: 2,
    updatedAt: null,
    topics: ['dsh-plugin'],
  },
  {
    repository: 'omdsh-dev/dsh-tool-calculator',
    name: 'dsh-tool-calculator',
    description: 'calculator',
    stars: 1,
    updatedAt: null,
    topics: ['dsh-plugin'],
  },
]

describe('conversational decision parsing', () => {
  it('maps a named repository or 1-based index to inspect', () => {
    expect(mentionedRepositories('先看第一个', remotes)).toEqual(['MirDie/dsh-xai'])
    expect(mentionedRepositories('选 2 审一下', remotes)).toEqual(['omdsh-dev/dsh-tool-calculator'])
    expect(mentionedRepositories('审查 omdsh-dev/dsh-tool-calculator', remotes))
      .toEqual(['omdsh-dev/dsh-tool-calculator'])
    expect(resolveDecision({
      userMessage: '看第二个',
      remotes,
      locals: [],
      phase: 'gate1',
    })).toMatchObject({
      action: 'inspect',
      selectedRepositories: ['omdsh-dev/dsh-tool-calculator'],
      searchMore: false,
    })
  })

  it('requires create-new wording and rejects a mismatched claimed action', () => {
    expect(resolveDecision({
      userMessage: '没有合适的，新建一个',
      remotes,
      locals: [],
      phase: 'gate1',
    }).action).toBe('create_new')
    expect(() => resolveDecision({
      userMessage: '这个看起来不错',
      claimedAction: 'create_new',
      remotes,
      locals: [],
      phase: 'gate1',
    })).toThrow(/does not match/i)
  })

  it('rejects a claimed repository that the user did not mention', () => {
    expect(() => resolveDecision({
      userMessage: '先看第一个',
      claimedAction: 'inspect',
      claimedRepositories: ['omdsh-dev/dsh-tool-calculator'],
      remotes,
      locals: [],
      phase: 'gate1',
    })).toThrow(/not mentioned/i)
  })
})
