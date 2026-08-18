import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { POLICY_VERSION, type RemotePluginCandidate, type ReviewRecord } from '../../src/contracts.js'
import { CreationGuard } from '../../src/creation-guard.js'
import {
  assertUseThisReceipt,
  inferOptionId,
  nextStepForAuthorization,
  resolveDecisionFromHost,
  resolveRepositoryFromMessage,
  reviewIdentity,
  _testing,
} from '../../src/lifecycle/decide.js'
import { WORKFLOW_OPTIONS, type InterruptPayload } from '../../src/workflow/contracts.js'

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

const agent = {
  id: 'session-decide',
  session: { header: { id: 'session-decide', cwd: 'C:/workspace', version: 0, createdAt: 0 } },
} as unknown as Agent

function interrupt(ids: Array<keyof typeof WORKFLOW_OPTIONS>): InterruptPayload {
  return {
    kind: 'await_selection',
    interruptId: `interrupt_${'a'.repeat(24)}`,
    ownerSessionId: 'session-decide',
    bootId: 'boot_decide',
    validAfterTurnId: `turn_${'0'.repeat(24)}`,
    snapshotDigest: 'b'.repeat(64),
    options: ids.map((id) => WORKFLOW_OPTIONS[id]),
    facts: {},
  }
}

describe('resume validation', () => {
  it('tells the model to resume an explicit modification without inventing another gate', () => {
    const text = nextStepForAuthorization('改进插件', {
      state: 'confirmation_required',
      resolutionId: `resolution_${'f'.repeat(24)}`,
      reason: 'review complete',
    })
    expect(text).toContain('不要在 resume 前追加设计问卷')
    expect(text).toContain('修改后重新审查并再次确认')
  })

  it('infers inspect from a host turn that names a candidate repository', () => {
    expect(inferOptionId('先看 MirDie/dsh-xai', interrupt(['inspect', 'stop']), remotes)).toBe('inspect')
    expect(resolveRepositoryFromMessage('审查 MirDie/dsh-xai', remotes)).toEqual(['MirDie/dsh-xai'])
    expect(_testing.CREATE_NEW_RE.test('Create new')).toBe(true)
  })

  it('accepts the canonical option id together with the authentic modification details', () => {
    expect(inferOptionId(
      '确认 modify_this：按 turn 支持不连续多选，按原顺序拼成一张长截图并保留细分隔线。',
      interrupt(['modify_this', 'stop']),
      remotes,
    )).toBe('modify_this')
  })

  it('derives the decision and repository only from the fresh Host user turn', () => {
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_decide' })
    guard.rememberUserMessage(agent, { content: [{ type: 'text', text: '审查 MirDie/dsh-xai' }] })
    expect(resolveDecisionFromHost({
      guard,
      agent,
      interrupt: interrupt(['inspect', 'stop']),
      remotes,
      requirement: 'calculator',
    })).toMatchObject({
      optionId: 'inspect',
      repositories: ['MirDie/dsh-xai'],
    })
    expect(() => resolveDecisionFromHost({
      guard,
      agent,
      interrupt: interrupt(['inspect', 'stop']),
      remotes,
      requirement: 'calculator',
    })).toThrow(/already consumed|replay/i)
  })

  it('rejects an option that is not in the current interrupt', () => {
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_decide' })
    guard.rememberUserMessage(agent, { content: [{ type: 'text', text: '用这个' }] })
    expect(() => resolveDecisionFromHost({
      guard,
      agent,
      interrupt: interrupt(['inspect', 'stop']),
      remotes,
      requirement: 'calculator',
    })).toThrow(/Could not resolve/i)
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
