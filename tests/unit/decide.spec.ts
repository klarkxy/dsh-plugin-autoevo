import { describe, expect, it } from 'vitest'
import type { RemotePluginCandidate } from '../../src/contracts.js'
import type { ReviewRecord } from '../../src/contracts.js'
import { assertUseThisReceipt, mentionedRepositories, resolveDecision, reviewIdentity } from '../../src/lifecycle/decide.js'

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

  const four: RemotePluginCandidate[] = [
    ...remotes,
    {
      repository: 'paicat1/dsh-screenshot',
      name: 'dsh-screenshot',
      description: 'screen capture',
      stars: 1,
      updatedAt: null,
      topics: ['dsh-plugin'],
    },
    {
      repository: 'XEsx630/dsh-screenshot',
      name: 'dsh-screenshot-region',
      description: 'region capture',
      stars: 0,
      updatedAt: null,
      topics: ['dsh-plugin'],
    },
  ]

  it('maps spoken inspect phrases and split indexes without treating a bare menu number as a pick', () => {
    expect(mentionedRepositories('看下3', four)).toEqual(['paicat1/dsh-screenshot'])
    expect(mentionedRepositories('具体看看3', four)).toEqual(['paicat1/dsh-screenshot'])
    expect(mentionedRepositories('看下3和4', four)).toEqual(['paicat1/dsh-screenshot', 'XEsx630/dsh-screenshot'])
    expect(mentionedRepositories('看下34', four)).toEqual(['paicat1/dsh-screenshot', 'XEsx630/dsh-screenshot'])
    expect(mentionedRepositories('选10', four)).toEqual([])
    expect(mentionedRepositories('1，安装', four)).toEqual([])
    expect(resolveDecision({
      userMessage: '具体看看3',
      remotes: four,
      locals: [],
      phase: 'gate1',
    }).action).toBe('inspect')
    expect(() => resolveDecision({
      userMessage: '1，安装',
      remotes: four,
      locals: [],
      phase: 'gate1',
    })).toThrow(/could not read a decision/i)
  })

  it('resolves this-plugin and install-for-me from prior selection or a single remote', () => {
    expect(mentionedRepositories('审查一下这个插件', four, ['paicat1/dsh-screenshot']))
      .toEqual(['paicat1/dsh-screenshot'])
    expect(mentionedRepositories('审查一下这个插件', four)).toEqual([])
    expect(mentionedRepositories('审查一下这个插件', [four[2]!])).toEqual(['paicat1/dsh-screenshot'])
    expect(resolveDecision({
      userMessage: '你帮我安装',
      remotes: four,
      locals: [],
      phase: 'gate1',
      previouslySelected: ['paicat1/dsh-screenshot'],
    })).toMatchObject({ action: 'inspect', selectedRepositories: ['paicat1/dsh-screenshot'] })
    expect(resolveDecision({
      userMessage: '你帮我安装',
      remotes: four,
      locals: [],
      phase: 'gate2',
      previouslySelected: ['paicat1/dsh-screenshot'],
    }).action).toBe('use_this')
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

describe('install authorization receipts', () => {
  const reviewed: ReviewRecord = {
    schemaVersion: 1,
    id: `review_${'a'.repeat(64)}`,
    policyVersion: 'v6-2026-08-17',
    createdAt: '2026-08-17T00:00:00.000Z',
    resolutionId: `resolution_${'b'.repeat(24)}`,
    requirement: 'grok',
    sourceSnapshot: {
      kind: 'local',
      path: 'C:/workspace/plugin',
      baseReviewId: `review_${'c'.repeat(64)}`,
      baseCommit: 'd'.repeat(40),
      statusHash: 'e'.repeat(64),
    },
    inspectedFiles: [],
    manifest: { kind: 'bundle', scripts: [], dependencies: [], peerDependencies: {}, expectedTools: [] },
    fit: 'full',
    confidence: 0.8,
    securityRisk: 'medium',
    maintained: true,
    license: 'MIT',
    compatibility: { status: 'compatible', reason: 'test', runtimeVersion: '0.1.0-rc.6' },
    missingCapabilities: [],
    findings: [],
    recommendation: 'use',
    installSpec: null,
  }

  it('accepts the latest matching use-this and rejects a later modify-this', () => {
    const identity = reviewIdentity(reviewed)
    expect(() => assertUseThisReceipt(reviewed, {
      id: reviewed.resolutionId,
      decisions: [{
        id: 'decision_1',
        phase: 'gate2',
        action: 'use_this',
        selectedRepositories: ['acme/plugin'],
        reviewId: reviewed.id,
        reviewIdentity: identity,
        createdAt: '2026-08-17T00:00:00.000Z',
      }],
    })).not.toThrow()
    expect(() => assertUseThisReceipt(reviewed, {
      id: reviewed.resolutionId,
      decisions: [{
        id: 'decision_1',
        phase: 'gate2',
        action: 'use_this',
        selectedRepositories: ['acme/plugin'],
        reviewId: reviewed.id,
        reviewIdentity: identity,
        createdAt: '2026-08-17T00:00:00.000Z',
      }, {
        id: 'decision_2',
        phase: 'gate2',
        action: 'modify_this',
        selectedRepositories: ['acme/plugin'],
        reviewId: reviewed.id,
        reviewIdentity: identity,
        createdAt: '2026-08-17T00:01:00.000Z',
      }],
    })).toThrow(/has not chosen/i)
  })
})
