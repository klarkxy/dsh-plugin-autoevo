import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { POLICY_VERSION, type ReviewRecord } from '../../src/contracts.js'
import { CreationGuard } from '../../src/creation-guard.js'
import {
  assertUseThisReceipt,
  nextStepForAuthorization,
  resolveDecisionFromModel,
  reviewIdentity,
} from '../../src/lifecycle/decide.js'
import { WORKFLOW_OPTIONS, type InterruptPayload } from '../../src/workflow/contracts.js'

const candidateId = `candidate_${'c'.repeat(24)}`
const repository = 'MirDie/dsh-xai'

const agent = {
  id: 'session-decide',
  session: { header: { id: 'session-decide', cwd: 'C:/workspace', version: 0, createdAt: 0 } },
} as unknown as Agent

function interrupt(ids: Array<keyof typeof WORKFLOW_OPTIONS>): InterruptPayload {
  return {
    kind: 'await_confirmation',
    interruptId: `interrupt_${'a'.repeat(24)}`,
    ownerSessionId: 'session-decide',
    bootId: 'boot_decide',
    validAfterTurnId: `turn_${'0'.repeat(24)}`,
    snapshotDigest: 'b'.repeat(64),
    options: ids.map((id) => id === 'use_this' || id === 'modify_this'
      ? { ...WORKFLOW_OPTIONS[id], candidateIds: [candidateId] }
      : WORKFLOW_OPTIONS[id]),
    facts: {
      installProfiles: ['web'],
      candidateSnapshot: [{ id: candidateId, index: 2, kind: 'remote', repository }],
    },
  }
}

describe('resume validation', () => {
  it('tells the model to submit its semantic interpretation as a structured decision', () => {
    const text = nextStepForAuthorization('改进插件', {
      state: 'confirmation_required',
      resolutionId: `resolution_${'f'.repeat(24)}`,
      reason: 'review complete',
    })
    expect(text).toContain('结构化 decision')
    expect(text).toContain('审查结论')
  })

  it('trusts the model action for wording the old regex could not understand', () => {
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_decide' })
    const current = interrupt(['modify_this', 'stop'])
    guard.rememberUserMessage(agent, { content: [{ type: 'text', text: '在 2 上改' }] })
    expect(resolveDecisionFromModel({
      guard,
      agent,
      interrupt: current,
      decision: { action: 'modify_this', candidateId },
      requirement: 'grok',
    })).toMatchObject({
      optionId: 'modify_this',
      candidateId,
      repositories: [repository],
      userMessage: '在 2 上改',
    })
    expect(() => resolveDecisionFromModel({
      guard,
      agent,
      interrupt: current,
      decision: { action: 'modify_this', candidateId },
      requirement: 'grok',
    })).toThrow(/already consumed|replay/i)
  })

  it('rejects unavailable or out-of-scope model decisions without consuming the fresh turn', () => {
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_decide' })
    const current = interrupt(['modify_this', 'stop'])
    guard.rememberUserMessage(agent, { content: [{ type: 'text', text: '你来理解这个决定' }] })
    expect(() => resolveDecisionFromModel({
      guard, agent, interrupt: current, decision: { action: 'create_new' }, requirement: 'grok',
    })).toThrow(/not available/i)
    expect(() => resolveDecisionFromModel({
      guard, agent, interrupt: current, decision: { action: 'modify_this' }, requirement: 'grok',
    })).toThrow(/requires candidate_id/i)
    expect(() => resolveDecisionFromModel({
      guard,
      agent,
      interrupt: current,
      decision: { action: 'modify_this', candidateId: `candidate_${'f'.repeat(24)}` },
      requirement: 'grok',
    })).toThrow(/not allowed/i)
    expect(() => resolveDecisionFromModel({
      guard,
      agent,
      interrupt: current,
      decision: { action: 'modify_this', candidateId, retention: 'persistent' },
      requirement: 'grok',
    })).toThrow(/does not accept retention/i)
    expect(resolveDecisionFromModel({
      guard, agent, interrupt: current, decision: { action: 'stop' }, requirement: 'grok',
    })).toMatchObject({ optionId: 'stop', userMessage: '你来理解这个决定' })
  })

  it('does not consume an oversized authentic user turn before validation completes', () => {
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_decide' })
    const current = interrupt(['stop'])
    guard.rememberUserMessage(agent, { content: [{ type: 'text', text: 'x'.repeat(2_001) }] })
    expect(() => resolveDecisionFromModel({
      guard, agent, interrupt: current, decision: { action: 'stop' }, requirement: 'grok',
    })).toThrow(/1 to 2000 characters/i)
    expect(() => guard.previewDecisionTurn(agent, current)).not.toThrow()
    expect(guard.consumeDecisionTurn(agent, current).message).toHaveLength(2_001)
  })

  it('defaults use_this retention to temporary unless the same confirmation selects persistent', () => {
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_decide' })
    const current = interrupt(['use_this', 'stop'])
    guard.rememberUserMessage(agent, { content: [{ type: 'text', text: '用这个' }] })
    expect(resolveDecisionFromModel({
      guard,
      agent,
      interrupt: current,
      decision: { action: 'use_this', candidateId },
      requirement: 'grok',
    })).toMatchObject({
      optionId: 'use_this',
      install: { targetProfile: 'web', retention: 'temporary', verificationTask: 'grok' },
    })
  })

  it('uses model-interpreted retention and Host-derived profile facts', () => {
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_decide' })
    const current = interrupt(['use_this', 'stop'])
    guard.rememberUserMessage(agent, { content: [{ type: 'text', text: '以后都用它' }] })
    expect(resolveDecisionFromModel({
      guard,
      agent,
      interrupt: current,
      decision: { action: 'use_this', candidateId, retention: 'persistent' },
      requirement: 'grok',
    })).toMatchObject({
      optionId: 'use_this',
      install: { targetProfile: 'web', retention: 'persistent', verificationTask: 'grok' },
    })
  })

  it('rejects temporary retention for manual_runtime candidates at the decision gate without consuming the turn', () => {
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_decide' })
    const current = interrupt(['use_this', 'stop'])
    guard.rememberUserMessage(agent, { content: [{ type: 'text', text: '装这个' }] })
    // Defaulted retention is temporary and must not reach install for a
    // manual_runtime candidate; the fresh turn stays unconsumed so the user
    // can reconfirm persistent at the same interrupt.
    expect(() => resolveDecisionFromModel({
      guard,
      agent,
      interrupt: current,
      decision: { action: 'use_this', candidateId },
      requirement: 'grok',
      verificationLayer: 'manual_runtime',
    })).toThrow(/requires persistent retention/i)
    expect(() => resolveDecisionFromModel({
      guard,
      agent,
      interrupt: current,
      decision: { action: 'use_this', candidateId, retention: 'temporary' },
      requirement: 'grok',
      verificationLayer: 'manual_runtime',
    })).toThrow(/requires persistent retention/i)
    expect(resolveDecisionFromModel({
      guard,
      agent,
      interrupt: current,
      decision: { action: 'use_this', candidateId, retention: 'persistent' },
      requirement: 'grok',
      verificationLayer: 'manual_runtime',
    })).toMatchObject({
      optionId: 'use_this',
      install: { targetProfile: 'web', retention: 'persistent', verificationTask: 'grok' },
    })
  })

  it('keeps the temporary default for automatically verifiable candidates', () => {
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_decide' })
    const current = interrupt(['use_this', 'stop'])
    guard.rememberUserMessage(agent, { content: [{ type: 'text', text: '用这个' }] })
    expect(resolveDecisionFromModel({
      guard,
      agent,
      interrupt: current,
      decision: { action: 'use_this', candidateId },
      requirement: 'grok',
      verificationLayer: 'tool_roundtrip',
    })).toMatchObject({
      optionId: 'use_this',
      install: { targetProfile: 'web', retention: 'temporary', verificationTask: 'grok' },
    })
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

  it('binds persistent replacement to the frozen installed target instead of a first-time install', () => {
    const commit = '5'.repeat(40)
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_decide' })
    const current: InterruptPayload = {
      kind: 'await_confirmation',
      interruptId: `interrupt_${'a'.repeat(24)}`,
      ownerSessionId: 'session-decide',
      bootId: 'boot_decide',
      validAfterTurnId: `turn_${'0'.repeat(24)}`,
      snapshotDigest: 'b'.repeat(64),
      options: [{ ...WORKFLOW_OPTIONS.use_this, candidateIds: [candidateId] }, WORKFLOW_OPTIONS.stop],
      facts: {
        installProfiles: ['web'],
        candidateSnapshot: [{
          id: candidateId,
          index: 1,
          kind: 'local',
          name: 'dsh-xai',
          identity: 'dsh-xai',
          digest: 'e'.repeat(64),
          evolutionTarget: {
            kind: 'github_exact',
            repository: 'MirDie/dsh-xai',
            commit,
            packageName: 'dsh-xai',
            profile: 'web',
            dependencySpec: `github:MirDie/dsh-xai#${commit}`,
            specDigest: 'f'.repeat(64),
          },
        }],
      },
    }
    guard.rememberUserMessage(agent, { content: [{ type: 'text', text: '替换现装插件' }] })
    const resume = resolveDecisionFromModel({
      guard,
      agent,
      interrupt: current,
      decision: { action: 'use_this', candidateId, retention: 'persistent' },
      requirement: 'dsh-xai',
    })
    expect(resume.install).toMatchObject({
      targetProfile: 'web',
      retention: 'persistent',
      replacement: {
        profile: 'web',
        packageName: 'dsh-xai',
        oldDependencySpec: `github:MirDie/dsh-xai#${commit}`,
      },
    })
    const again = {
      ...current,
      interruptId: `interrupt_${'b'.repeat(24)}`,
    }
    guard.rememberUserMessage(agent, { content: [{ type: 'text', text: '临时装' }] })
    expect(() => resolveDecisionFromModel({
      guard,
      agent,
      interrupt: again,
      decision: { action: 'use_this', candidateId, retention: 'temporary' },
      requirement: 'dsh-xai',
    })).toThrow(/persistent retention/i)
  })

  it('installs a reviewed or failed known source as a first persistent install, not a live-spec replacement', () => {
    const commit = 'd'.repeat(40)
    const spec = `github:klarkxy/zhihu-search#${commit}`
    for (const kind of ['reviewed_snapshot', 'failed_install'] as const) {
      const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_decide' })
      const current: InterruptPayload = {
        kind: 'await_confirmation',
        interruptId: `interrupt_${(kind === 'failed_install' ? 'd' : 'c').repeat(24)}`,
        ownerSessionId: 'session-decide',
        bootId: 'boot_decide',
        validAfterTurnId: `turn_${'0'.repeat(24)}`,
        snapshotDigest: 'b'.repeat(64),
        options: [{ ...WORKFLOW_OPTIONS.use_this, candidateIds: [candidateId] }, WORKFLOW_OPTIONS.stop],
        facts: {
          installProfiles: ['web'],
          candidateSnapshot: [{
            id: candidateId,
            index: 1,
            kind: 'local',
            name: 'dsh-plugin-zhihu-search',
            identity: 'dsh-plugin-zhihu-search',
            digest: 'e'.repeat(64),
            evolutionTarget: {
              kind,
              repository: 'klarkxy/zhihu-search',
              commit,
              packageName: 'dsh-plugin-zhihu-search',
              profile: 'web',
              dependencySpec: spec,
              specDigest: 'f'.repeat(64),
            },
          }],
        },
      }
      guard.rememberUserMessage(agent, { content: [{ type: 'text', text: '用这个长期保留' }] })
      const resume = resolveDecisionFromModel({
        guard,
        agent,
        interrupt: current,
        decision: { action: 'use_this', candidateId, retention: 'persistent' },
        requirement: 'zhihu-search',
      })
      expect(resume.install).toMatchObject({
        targetProfile: 'web',
        retention: 'persistent',
      })
      expect(resume.install?.replacement).toBeUndefined()
    }
  })
})
