import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { POLICY_VERSION, type RemotePluginCandidate, type ReviewRecord } from '../../src/contracts.js'
import { CreationGuard } from '../../src/creation-guard.js'
import {
  assertResumeContradiction,
  assertUseThisReceipt,
  resolveResumeRepositories,
  reviewIdentity,
  validateResume,
} from '../../src/lifecycle/decide.js'
import { WORKFLOW_OPTIONS } from '../../src/workflow/contracts.js'

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

const agent = {} as Agent

function interrupt(ids: Array<keyof typeof WORKFLOW_OPTIONS>) {
  return {
    kind: 'await_selection' as const,
    options: ids.map((id) => WORKFLOW_OPTIONS[id]),
    facts: {},
  }
}

describe('resume validation', () => {
  it('accepts option_id as the decision and keeps claimed repositories in the candidate set', () => {
    expect(resolveResumeRepositories(['omdsh-dev/dsh-tool-calculator'], remotes, 'inspect'))
      .toEqual(['omdsh-dev/dsh-tool-calculator'])
    expect(() => resolveResumeRepositories([], remotes, 'inspect')).toThrow(/exactly one repository/i)
    expect(() => resolveResumeRepositories(['MirDie/dsh-xai', 'omdsh-dev/dsh-tool-calculator'], remotes, 'inspect'))
      .toThrow(/exactly one repository/i)
    expect(() => resolveResumeRepositories(['acme/one'], remotes, 'stop')).toThrow(/only valid when inspecting/i)
  })

  it('rejects a create-new option that the user message does not support', () => {
    expect(() => assertResumeContradiction('这个看起来不错', 'create_new')).toThrow(/contradict/i)
    expect(() => assertResumeContradiction('没有合适的，新建一个', 'use_this')).toThrow(/contradict/i)
    expect(() => assertResumeContradiction('先停', 'inspect')).toThrow(/contradict/i)
    expect(() => assertResumeContradiction('没有合适的，新建一个', 'create_new')).not.toThrow()
  })

  it('requires the live user turn to match user_message when a turn was claimed', () => {
    const guard = new CreationGuard({ isEvolutionMode: () => true })
    expect(validateResume({
      guard,
      agent,
      interrupt: interrupt(['inspect', 'stop']),
      userMessage: '审查 MirDie/dsh-xai',
      optionId: 'inspect',
      remotes,
      repositories: ['MirDie/dsh-xai'],
    })).toMatchObject({
      optionId: 'inspect',
      repositories: ['MirDie/dsh-xai'],
    })

    guard.rememberUserMessage(agent, { content: [{ type: 'text', text: '审查 MirDie/dsh-xai' }] })
    expect(validateResume({
      guard,
      agent,
      interrupt: interrupt(['inspect', 'stop']),
      userMessage: '审查 MirDie/dsh-xai',
      optionId: 'inspect',
      remotes,
      repositories: ['MirDie/dsh-xai'],
    })).toMatchObject({
      optionId: 'inspect',
      repositories: ['MirDie/dsh-xai'],
    })

    expect(() => validateResume({
      guard,
      agent,
      interrupt: interrupt(['inspect', 'stop']),
      userMessage: '先看第二个',
      optionId: 'inspect',
      remotes,
      repositories: ['MirDie/dsh-xai'],
    })).toThrow(/does not match the latest user turn/i)
  })

  it('rejects an option that is not in the current interrupt', () => {
    const guard = new CreationGuard({ isEvolutionMode: () => true })
    guard.rememberUserMessage(agent, { content: [{ type: 'text', text: '用这个' }] })
    expect(() => validateResume({
      guard,
      agent,
      interrupt: interrupt(['inspect', 'stop']),
      userMessage: '用这个',
      optionId: 'use_this',
      remotes,
    })).toThrow(/not available/i)
  })
})

describe('install authorization receipts', () => {
  const reviewed: ReviewRecord = {
    schemaVersion: 1,
    id: `review_${'a'.repeat(64)}`,
    policyVersion: POLICY_VERSION,
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
        optionId: 'use_this',
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
