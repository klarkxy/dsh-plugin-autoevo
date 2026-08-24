import { describe, expect, it } from 'vitest'
import { POLICY_VERSION, type InstallationRecord, type ReviewRecord } from '../../src/contracts.js'
import { TERMINAL_NODES, type WorkflowRecord } from '../../src/workflow/contracts.js'
import { lifecycleStateFor, type LifecycleMappingInput, type WorkflowLifecycleState } from '../../src/workflow/lifecycle.js'

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
  it.each<{
    name: string
    overrides: Partial<WorkflowRecord>
    extras?: LifecycleMappingInput
    expected: WorkflowLifecycleState
    terminal?: Parameters<typeof TERMINAL_NODES.has>[0]
  }>([
    {
      name: 'maps discover_remote to searched without claiming verified early',
      overrides: { cursor: 'discover_remote' },
      expected: 'searched',
    },
    {
      name: 'maps interrupted await_selection to selected',
      overrides: { status: 'interrupted', cursor: 'await_selection' },
      expected: 'selected',
    },
    {
      name: 'maps review_github to reviewing',
      overrides: { cursor: 'review_github' },
      expected: 'reviewing',
    },
    {
      name: 'maps an approved reviewer verdict to approved',
      overrides: { status: 'interrupted', cursor: 'await_confirmation' },
      extras: { reviews: [review(verdict('approved'))] },
      expected: 'approved',
    },
    {
      name: 'maps a rejected reviewer verdict to rejected',
      overrides: { status: 'interrupted', cursor: 'await_confirmation' },
      extras: { reviews: [review(verdict('rejected'))] },
      expected: 'rejected',
    },
    {
      name: 'maps an uncertain reviewer verdict to uncertain',
      overrides: { status: 'interrupted', cursor: 'await_confirmation' },
      extras: { reviews: [review(verdict('uncertain'))] },
      expected: 'uncertain',
    },
    {
      name: 'maps a review without a verdict to skipped',
      overrides: { status: 'interrupted', cursor: 'await_confirmation' },
      extras: { reviews: [review()] },
      expected: 'skipped',
    },
    {
      name: 'maps await_confirmation without reviews to awaiting_confirmation',
      overrides: { status: 'interrupted', cursor: 'await_confirmation' },
      expected: 'awaiting_confirmation',
    },
    {
      name: 'maps an action commitment to committed',
      overrides: {
        cursor: 'await_confirmation',
        actionCommitment: { id: 'c1' } as NonNullable<WorkflowRecord['actionCommitment']>,
      },
      expected: 'committed',
    },
    {
      name: 'maps an execution lease to leased',
      overrides: {
        cursor: 'await_confirmation',
        executionLease: { id: 'l1' } as NonNullable<WorkflowRecord['executionLease']>,
      },
      expected: 'leased',
    },
    {
      name: 'maps install_verify to executing',
      overrides: { cursor: 'install_verify' },
      expected: 'executing',
    },
    {
      name: 'maps a verified installation to verified',
      overrides: { status: 'completed', cursor: 'installed' },
      extras: { installation: installation(true) },
      expected: 'verified',
    },
    {
      name: 'maps a failed installation to recovery_required',
      overrides: { status: 'completed', cursor: 'installed' },
      extras: { installation: installation(false) },
      expected: 'recovery_required',
    },
    {
      name: 'keeps recovery_required distinct',
      overrides: { status: 'completed', cursor: 'recovery_required' },
      expected: 'recovery_required',
    },
    {
      name: 'keeps restart_required distinct',
      overrides: { status: 'completed', cursor: 'restart_required' },
      expected: 'restart_required',
    },
    {
      name: 'keeps market_restart_required distinct',
      overrides: { status: 'completed', cursor: 'market_restart_required' },
      expected: 'market_restart_required',
    },
    {
      name: 'keeps market_setup_required distinct',
      overrides: { status: 'completed', cursor: 'market_setup_required' },
      expected: 'market_setup_required',
    },
    {
      name: 'keeps modify_authorized distinct',
      overrides: { status: 'completed', cursor: 'modify_authorized' },
      expected: 'modify_authorized',
    },
    {
      name: 'keeps create_authorized distinct',
      overrides: { status: 'completed', cursor: 'create_authorized' },
      expected: 'create_authorized',
    },
    {
      name: 'keeps stopped distinct',
      overrides: { status: 'completed', cursor: 'stopped' },
      expected: 'stopped',
    },
    {
      name: 'maps interrupted await_modify_work to interrupted',
      overrides: { status: 'interrupted', cursor: 'await_modify_work' },
      expected: 'interrupted',
    },
    {
      name: 'keeps reuse_local distinct',
      overrides: { status: 'completed', cursor: 'reuse_local' },
      expected: 'reuse_local',
    },
    {
      name: 'maps a stale policy version to interrupted',
      overrides: { policyVersion: '4', status: 'interrupted', cursor: 'await_confirmation' },
      expected: 'interrupted',
    },
    {
      name: 'maps awaiting_user_test as a normal completed lifecycle, not verified or recovery',
      overrides: { status: 'completed', cursor: 'awaiting_user_test' },
      expected: 'awaiting_user_test',
      terminal: 'awaiting_user_test',
    },
    {
      name: 'keeps awaiting_user_test even with a verified installation',
      overrides: { status: 'completed', cursor: 'awaiting_user_test' },
      extras: { installation: installation(true) },
      expected: 'awaiting_user_test',
    },
    {
      name: 'maps an awaiting_user_test install outcome to awaiting_user_test',
      overrides: { status: 'completed', cursor: 'installed' },
      extras: {
        installation: {
          ...installation(false),
          installOutcome: 'awaiting_user_test',
          verified: false,
        },
      },
      expected: 'awaiting_user_test',
    },
    {
      name: 'maps a stale policy version on awaiting_user_test to interrupted',
      overrides: { policyVersion: '7', status: 'completed', cursor: 'awaiting_user_test' },
      expected: 'interrupted',
    },
    {
      name: 'maps activated as a completed lifecycle that is not verified or recovery',
      overrides: { status: 'completed', cursor: 'activated' },
      expected: 'activated',
      terminal: 'activated',
    },
    {
      name: 'maps an activated install outcome to activated',
      overrides: { status: 'completed', cursor: 'installed' },
      extras: {
        installation: {
          ...installation(false),
          installOutcome: 'activated',
          installed: true,
          loaded: true,
          verified: false,
        },
      },
      expected: 'activated',
    },
    {
      name: 'keeps activated even with a verified installation',
      overrides: { status: 'completed', cursor: 'activated' },
      extras: { installation: installation(true) },
      expected: 'activated',
    },
    {
      name: 'keeps restart_required when the install outcome is activated',
      overrides: { status: 'completed', cursor: 'restart_required' },
      extras: {
        installation: {
          ...installation(false),
          installOutcome: 'activated',
          installed: true,
          verified: false,
        },
      },
      expected: 'restart_required',
    },
  ])('$name', ({ overrides, extras, expected, terminal }) => {
    if (terminal !== undefined) expect(TERMINAL_NODES.has(terminal)).toBe(true)
    expect(lifecycleStateFor(workflow(overrides), extras)).toBe(expected)
  })
})
