import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { POLICY_VERSION, type AuthorizationDecisionInput, type ReviewRecord } from '../../src/contracts.js'
import { CreationGuard } from '../../src/creation-guard.js'
import {
  assertUseThisReceipt,
  nextStepForAuthorization,
  resolveDecisionFromModel,
  reviewIdentity,
} from '../../src/lifecycle/decide.js'
import { WORKFLOW_OPTIONS, type InterruptPayload } from '../../src/workflow/contracts.js'

const candidateId = `candidate_${'c'.repeat(24)}`
const repository = 'anonymous-lab/dsh-plugin-alpha'
const recoveryId = `recovery_${'d'.repeat(24)}`

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
    options: ids.map((id) => id === 'use_this' || id === 'modify_this' || id === 'apply_recovery'
      ? {
          ...WORKFLOW_OPTIONS[id],
          candidateIds: [candidateId],
          ...(id === 'apply_recovery' ? { recoveryIds: [recoveryId] } : {}),
        }
      : WORKFLOW_OPTIONS[id]),
    facts: {
      installProfiles: ['web'],
      candidateSnapshot: [{ id: candidateId, index: 2, kind: 'remote', repository }],
      recoveryOptions: [{
        id: recoveryId,
        operation: 'retry_install',
        strategy: 'minimum_release_age_exception',
        sourceInstallationId: `installation_${'e'.repeat(24)}`,
        diagnosticHash: 'f'.repeat(64),
        exactPackages: ['ds-harness-remote@0.3.35'],
        effectScope: 'single_install_command',
      }],
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
      requirement: 'synthetic-model',
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
      requirement: 'synthetic-model',
    })).toThrow(/already consumed|replay/i)
  })

  it('rejects unavailable or out-of-scope model decisions without consuming the fresh turn', () => {
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_decide' })
    const current = interrupt(['modify_this', 'stop'])
    guard.rememberUserMessage(agent, { content: [{ type: 'text', text: '你来理解这个决定' }] })
    expect(() => resolveDecisionFromModel({
      guard, agent, interrupt: current, decision: { action: 'create_new' }, requirement: 'synthetic-model',
    })).toThrow(/not available/i)
    expect(() => resolveDecisionFromModel({
      guard, agent, interrupt: current, decision: { action: 'modify_this' }, requirement: 'synthetic-model',
    })).toThrow(/requires candidate_id/i)
    expect(() => resolveDecisionFromModel({
      guard,
      agent,
      interrupt: current,
      decision: { action: 'modify_this', candidateId: `candidate_${'f'.repeat(24)}` },
      requirement: 'synthetic-model',
    })).toThrow(/not allowed/i)
    expect(() => resolveDecisionFromModel({
      guard,
      agent,
      interrupt: current,
      decision: { action: 'modify_this', candidateId, retention: 'persistent' } as unknown as AuthorizationDecisionInput,
      requirement: 'synthetic-model',
    })).toThrow(/do not accept retention/i)
    expect(resolveDecisionFromModel({
      guard, agent, interrupt: current, decision: { action: 'stop' }, requirement: 'synthetic-model',
    })).toMatchObject({ optionId: 'stop', userMessage: '你来理解这个决定' })
  })

  it('accepts a complete authentic user turn beyond the legacy presentation limit', () => {
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_decide' })
    const current = interrupt(['stop'])
    guard.rememberUserMessage(agent, { content: [{ type: 'text', text: 'x'.repeat(2_001) }] })
    expect(resolveDecisionFromModel({
      guard, agent, interrupt: current, decision: { action: 'stop' }, requirement: 'synthetic-model',
    }).userMessage).toHaveLength(2_001)
  })

  it('makes every use_this decision persistent', () => {
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_decide' })
    const current = interrupt(['use_this', 'stop'])
    guard.rememberUserMessage(agent, { content: [{ type: 'text', text: '用这个' }] })
    expect(resolveDecisionFromModel({
      guard,
      agent,
      interrupt: current,
      decision: { action: 'use_this', candidateId },
      requirement: 'synthetic-model',
    })).toMatchObject({
      optionId: 'use_this',
      install: { targetProfile: 'web', retention: 'persistent', verificationTask: 'synthetic-model' },
    })
  })

  it('accepts only a sealed recovery id and never accepts recovery parameters on other actions', () => {
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_decide' })
    const current = interrupt(['apply_recovery', 'stop'])
    guard.rememberUserMessage(agent, { content: [{ type: 'text', text: '按这个恢复方案继续' }] })
    expect(() => resolveDecisionFromModel({
      guard,
      agent,
      interrupt: current,
      decision: { action: 'apply_recovery', candidateId },
      requirement: 'synthetic-model',
    })).toThrow(/requires recovery_id/i)
    expect(() => resolveDecisionFromModel({
      guard,
      agent,
      interrupt: current,
      decision: { action: 'apply_recovery', candidateId, recoveryId: `recovery_${'a'.repeat(24)}` },
      requirement: 'synthetic-model',
    })).toThrow(/not allowed/i)
    expect(() => resolveDecisionFromModel({
      guard,
      agent,
      interrupt: current,
      decision: { action: 'stop', recoveryId },
      requirement: 'synthetic-model',
    })).toThrow(/does not accept recovery_id/i)
    expect(resolveDecisionFromModel({
      guard,
      agent,
      interrupt: current,
      decision: { action: 'apply_recovery', candidateId, recoveryId },
      requirement: 'synthetic-model',
    })).toMatchObject({
      optionId: 'apply_recovery',
      candidateId,
      recoveryId,
      install: {
        recoveryPlan: {
          id: recoveryId,
          operation: 'retry_install',
          strategy: 'minimum_release_age_exception',
          exactPackages: ['ds-harness-remote@0.3.35'],
          effectScope: 'single_install_command',
        },
      },
    })
  })

  it('reconstructs a profile-store repair only from the sealed recovery id', () => {
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_decide' })
    const current = interrupt(['apply_recovery', 'stop'])
    current.facts.recoveryOptions = [{
      id: recoveryId,
      operation: 'retry_install',
      strategy: 'profile_store_reuse',
      sourceInstallationId: `installation_${'e'.repeat(24)}`,
      diagnosticHash: 'f'.repeat(64),
      profileStoreFingerprint: 'a'.repeat(64),
      effectScope: 'single_install_command',
    }]
    guard.rememberUserMessage(agent, { content: [{ type: 'text', text: '先修复安装环境，再继续这个候选' }] })

    expect(resolveDecisionFromModel({
      guard,
      agent,
      interrupt: current,
      decision: { action: 'apply_recovery', candidateId, recoveryId },
      requirement: 'synthetic-model',
    })).toMatchObject({
      optionId: 'apply_recovery',
      candidateId,
      recoveryId,
      install: {
        recoveryPlan: {
          strategy: 'profile_store_reuse',
          profileStoreFingerprint: 'a'.repeat(64),
          effectScope: 'single_install_command',
        },
      },
    })
  })

  it('rejects legacy public retention even when it says persistent', () => {
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_decide' })
    const current = interrupt(['use_this', 'stop'])
    guard.rememberUserMessage(agent, { content: [{ type: 'text', text: '以后都用它' }] })
    expect(() => resolveDecisionFromModel({
      guard,
      agent,
      interrupt: current,
      decision: { action: 'use_this', candidateId, retention: 'persistent' } as unknown as AuthorizationDecisionInput,
      requirement: 'synthetic-model',
    })).toThrow(/do not accept retention/i)
  })

  it('keeps manual_runtime adoption persistent and rejects legacy retention input', () => {
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_decide' })
    const current = interrupt(['use_this', 'stop'])
    guard.rememberUserMessage(agent, { content: [{ type: 'text', text: '装这个' }] })
    expect(resolveDecisionFromModel({
      guard,
      agent,
      interrupt: current,
      decision: { action: 'use_this', candidateId },
      requirement: 'synthetic-model',
      verificationLayer: 'manual_runtime',
    })).toMatchObject({ install: { retention: 'persistent' } })
    const nextGuard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_decide' })
    nextGuard.rememberUserMessage(agent, { content: [{ type: 'text', text: '装这个' }] })
    expect(() => resolveDecisionFromModel({
      guard: nextGuard,
      agent,
      interrupt: current,
      decision: { action: 'use_this', candidateId, retention: 'temporary' } as unknown as AuthorizationDecisionInput,
      requirement: 'synthetic-model',
      verificationLayer: 'manual_runtime',
    })).toThrow(/do not accept retention/i)
  })

  it('keeps automatically verifiable candidates persistent too', () => {
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_decide' })
    const current = interrupt(['use_this', 'stop'])
    guard.rememberUserMessage(agent, { content: [{ type: 'text', text: '用这个' }] })
    expect(resolveDecisionFromModel({
      guard,
      agent,
      interrupt: current,
      decision: { action: 'use_this', candidateId },
      requirement: 'synthetic-model',
      verificationLayer: 'tool_roundtrip',
    })).toMatchObject({
      optionId: 'use_this',
      install: { targetProfile: 'web', retention: 'persistent', verificationTask: 'synthetic-model' },
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
    requirement: 'synthetic-model',
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
          name: 'dsh-plugin-alpha',
          identity: 'dsh-plugin-alpha',
          digest: 'e'.repeat(64),
          evolutionTarget: {
            kind: 'github_exact',
            repository: 'anonymous-lab/dsh-plugin-alpha',
            commit,
            packageName: 'dsh-plugin-alpha',
            profile: 'web',
            dependencySpec: `github:anonymous-lab/dsh-plugin-alpha#${commit}`,
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
      decision: { action: 'use_this', candidateId },
      requirement: 'dsh-plugin-alpha',
    })
    expect(resume.install).toMatchObject({
      targetProfile: 'web',
      retention: 'persistent',
      replacement: {
        profile: 'web',
        packageName: 'dsh-plugin-alpha',
        oldDependencySpec: `github:anonymous-lab/dsh-plugin-alpha#${commit}`,
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
      decision: { action: 'use_this', candidateId, retention: 'temporary' } as unknown as AuthorizationDecisionInput,
      requirement: 'dsh-plugin-alpha',
    })).toThrow(/do not accept retention/i)
  })

  it('installs a reviewed or failed known source as a first persistent install, not a live-spec replacement', () => {
    const commit = 'd'.repeat(40)
    const spec = `github:anonymous-lab/dsh-plugin-beta#${commit}`
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
            name: 'dsh-plugin-beta',
            identity: 'dsh-plugin-beta',
            digest: 'e'.repeat(64),
            evolutionTarget: {
              kind,
              repository: 'anonymous-lab/dsh-plugin-beta',
              commit,
              packageName: 'dsh-plugin-beta',
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
        decision: { action: 'use_this', candidateId },
        requirement: 'record-sync',
      })
      expect(resume.install).toMatchObject({
        targetProfile: 'web',
        retention: 'persistent',
      })
      expect(resume.install?.replacement).toBeUndefined()
    }
  })
})
