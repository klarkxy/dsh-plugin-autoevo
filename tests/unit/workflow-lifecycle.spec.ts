import { describe, expect, it } from 'vitest'
import { POLICY_VERSION, type InstallationRecord, type ReviewRecord } from '../../src/contracts.js'
import { lifecycleStateFor } from '../../src/workflow/lifecycle.js'
import type { WorkflowRecord } from '../../src/workflow/contracts.js'

function workflow(overrides: Partial<WorkflowRecord> = {}): WorkflowRecord {
  return {
    schemaVersion: 2,
    id: `workflow_${'d'.repeat(24)}`,
    policyVersion: POLICY_VERSION,
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
    requirement: 'calculator',
    status: 'running',
    cursor: 'resolve_local',
    generation: 1,
    ...overrides,
  }
}

function review(decision?: ReviewRecord['reviewerVerdict']): ReviewRecord {
  return {
    schemaVersion: 1,
    id: `review_${'a'.repeat(64)}`,
    policyVersion: POLICY_VERSION,
    createdAt: '2026-08-19T00:00:00.000Z',
    resolutionId: `resolution_${'b'.repeat(24)}`,
    requirement: 'calculator',
    sourceSnapshot: {
      kind: 'github',
      repository: 'acme/one',
      requestedRef: 'main',
      commit: 'c'.repeat(40),
      defaultBranch: 'main',
    },
    inspectedFiles: [],
    manifest: { kind: 'bundle', packageName: 'dsh-one', scripts: [], dependencies: [], peerDependencies: {}, expectedTools: [] },
    fit: 'full',
    confidence: 0.8,
    securityRisk: 'low',
    maintained: true,
    license: 'MIT',
    compatibility: { status: 'compatible', reason: 'ok', runtimeVersion: '0.1.0-rc.6' },
    missingCapabilities: [],
    findings: [],
    recommendation: 'use',
    installSpec: `github:acme/one#${'c'.repeat(40)}`,
    ...(decision ? { reviewerVerdict: decision } : {}),
  }
}

function verdict(decision: 'approved' | 'rejected' | 'uncertain'): NonNullable<ReviewRecord['reviewerVerdict']> {
  return {
    requestId: `reviewer_${'1'.repeat(24)}`,
    reviewId: `review_${'a'.repeat(64)}`,
    requirementHash: '2'.repeat(64),
    snapshotDigest: '3'.repeat(64),
    candidateDigest: '4'.repeat(64),
    reviewerSessionId: 'reviewer-session',
    reviewerVersion: '1',
    decision,
    evidence: [],
    conditions: [],
    semanticCoverage: 'full',
    createdAt: '2026-08-19T00:00:03.000Z',
  }
}

function installation(verified: boolean): InstallationRecord {
  return {
    schemaVersion: 1,
    id: `installation_${'5'.repeat(24)}`,
    createdAt: '2026-08-19T00:00:04.000Z',
    reviewId: `review_${'a'.repeat(64)}`,
    targetProfile: 'web',
    retention: 'temporary',
    dshHome: 'C:/dsh',
    packageName: 'dsh-one',
    installSpec: `github:acme/one#${'c'.repeat(40)}`,
    installOutcome: verified ? 'verified' : 'recovery_required',
    installed: verified,
    loaded: verified,
    verified,
    restartRequired: false,
    removed: false,
    verification: {
      attempted: true,
      expectedTools: ['calculator'],
      calledTools: ['calculator'],
      resultTools: ['calculator'],
      failedTools: [],
      sessionFiles: [],
      taskResultObserved: true,
      reason: verified ? 'ok' : 'failed',
    },
  }
}

describe('public workflow lifecycle mapping', () => {
  it('maps the main discovery-to-verify path without claiming verified early', () => {
    expect(lifecycleStateFor(workflow({ cursor: 'discover_remote' }))).toBe('searched')
    expect(lifecycleStateFor(workflow({ status: 'interrupted', cursor: 'await_selection' }))).toBe('selected')
    expect(lifecycleStateFor(workflow({ cursor: 'review_github' }))).toBe('reviewing')
    expect(lifecycleStateFor(
      workflow({ status: 'interrupted', cursor: 'await_confirmation' }),
      { reviews: [review(verdict('approved'))] },
    )).toBe('approved')
    expect(lifecycleStateFor(
      workflow({ status: 'interrupted', cursor: 'await_confirmation' }),
      { reviews: [review(verdict('rejected'))] },
    )).toBe('rejected')
    expect(lifecycleStateFor(
      workflow({ status: 'interrupted', cursor: 'await_confirmation' }),
      { reviews: [review(verdict('uncertain'))] },
    )).toBe('uncertain')
    expect(lifecycleStateFor(
      workflow({ status: 'interrupted', cursor: 'await_confirmation' }),
      { reviews: [review()] },
    )).toBe('skipped')
    expect(lifecycleStateFor(workflow({ status: 'interrupted', cursor: 'await_confirmation' }))).toBe('awaiting_confirmation')
    expect(lifecycleStateFor(workflow({
      cursor: 'await_confirmation',
      actionCommitment: { id: 'c1' } as NonNullable<WorkflowRecord['actionCommitment']>,
    }))).toBe('committed')
    expect(lifecycleStateFor(workflow({
      cursor: 'await_confirmation',
      executionLease: { id: 'l1' } as NonNullable<WorkflowRecord['executionLease']>,
    }))).toBe('leased')
    expect(lifecycleStateFor(workflow({ cursor: 'install_verify' }))).toBe('executing')
    expect(lifecycleStateFor(
      workflow({ status: 'completed', cursor: 'installed' }),
      { installation: installation(true) },
    )).toBe('verified')
    expect(lifecycleStateFor(
      workflow({ status: 'completed', cursor: 'installed' }),
      { installation: installation(false) },
    )).toBe('recovery_required')
  })

  it('keeps distinct recovery and terminal states', () => {
    expect(lifecycleStateFor(workflow({ status: 'completed', cursor: 'recovery_required' }))).toBe('recovery_required')
    expect(lifecycleStateFor(workflow({ status: 'completed', cursor: 'restart_required' }))).toBe('restart_required')
    expect(lifecycleStateFor(workflow({ status: 'completed', cursor: 'market_restart_required' }))).toBe('market_restart_required')
    expect(lifecycleStateFor(workflow({ status: 'completed', cursor: 'market_setup_required' }))).toBe('market_setup_required')
    expect(lifecycleStateFor(workflow({ status: 'completed', cursor: 'modify_authorized' }))).toBe('modify_authorized')
    expect(lifecycleStateFor(workflow({ status: 'completed', cursor: 'create_authorized' }))).toBe('create_authorized')
    expect(lifecycleStateFor(workflow({ status: 'completed', cursor: 'stopped' }))).toBe('stopped')
    expect(lifecycleStateFor(workflow({ status: 'interrupted', cursor: 'await_modify_work' }))).toBe('interrupted')
    expect(lifecycleStateFor(workflow({ status: 'completed', cursor: 'reuse_local' }))).toBe('reuse_local')
    expect(lifecycleStateFor(workflow({
      policyVersion: '4',
      status: 'interrupted',
      cursor: 'await_confirmation',
    }))).toBe('interrupted')
  })
})
