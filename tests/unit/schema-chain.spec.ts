import type { Agent } from '@deepseek-ai/dsh-agent'
import { describe, expect, it } from 'vitest'
import { FORGED_RESUME_HOST_KEYS } from '../../src/contracts.js'
import { parseRequestIntent } from '../../src/resolver/intent.js'
import { CreationGuard } from '../../src/creation-guard.js'
import { resolveDecisionFromModel } from '../../src/lifecycle/decide.js'
import { WORKFLOW_OPTIONS, type InterruptPayload } from '../../src/workflow/contracts.js'

const candidateId = `candidate_${'c'.repeat(24)}`
const agent = {
  id: 'session-schema',
  session: { header: { id: 'session-schema', cwd: 'C:/workspace', version: 0, createdAt: 0 } },
} as unknown as Agent

function interrupt(): InterruptPayload {
  return {
    kind: 'await_confirmation',
    interruptId: `interrupt_${'a'.repeat(24)}`,
    ownerSessionId: 'session-schema',
    bootId: 'boot_schema',
    validAfterTurnId: `turn_${'0'.repeat(24)}`,
    snapshotDigest: 'b'.repeat(64),
    options: [
      { ...WORKFLOW_OPTIONS.use_this, candidateIds: [candidateId] },
      WORKFLOW_OPTIONS.search_more,
      WORKFLOW_OPTIONS.stop,
    ],
    facts: {
      installProfiles: ['web'],
      candidateSnapshot: [{ id: candidateId, index: 1, kind: 'remote', repository: 'acme/one' }],
    },
  }
}

describe('model JSON to Host schema chain', () => {
  it('accepts a valid decision payload', () => {
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_schema' })
    guard.rememberUserMessage(agent, { content: [{ type: 'text', text: '用这个' }] })
    expect(resolveDecisionFromModel({
      guard,
      agent,
      interrupt: interrupt(),
      decision: { action: 'use_this', candidateId },
    })).toMatchObject({
      optionId: 'use_this',
      candidateId,
      install: { retention: 'persistent' },
    })
  })

  it('rejects missing candidate_id and illegal or forged Host fields', () => {
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_schema' })
    guard.rememberUserMessage(agent, { content: [{ type: 'text', text: '用这个' }] })
    expect(() => resolveDecisionFromModel({
      guard,
      agent,
      interrupt: interrupt(),
      decision: { action: 'use_this' },
    })).toThrow(/requires candidate_id/i)
    expect(() => parseRequestIntent({ operation: 'evolve_existing', required_surface: 'native_dsh_plugin', evolutionTarget: {} })).toThrow(/unknown fields/i)
    expect(parseRequestIntent({ operation: 'evolve_existing', required_surface: 'native_dsh_plugin', target_name: 'dsh-plugin-alpha' })).toEqual({
      operation: 'evolve_existing',
      requiredSurface: 'native_dsh_plugin',
      targetName: 'dsh-plugin-alpha',
    })
    expect(parseRequestIntent({
      operation: 'evolve_existing',
      required_surface: 'native_dsh_plugin',
      target_name: 'record-sync',
      evolve_reason: 'repair',
    })).toEqual({
      operation: 'evolve_existing',
      requiredSurface: 'native_dsh_plugin',
      targetName: 'record-sync',
      evolveReason: 'repair',
    })
    expect(() => parseRequestIntent({
      operation: 'discover_or_reuse',
      required_surface: 'any',
      evolve_reason: 'repair',
    })).toThrow(/evolve_reason is only valid/i)
    expect(FORGED_RESUME_HOST_KEYS).toEqual(expect.arrayContaining([
      'selectionReceipt',
      'actionCommitment',
      'executionLease',
      'reviewerVerdict',
      'verificationVerdict',
      'verifierVerdict',
    ]))
  })
})
