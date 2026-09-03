import { describe, expect, it } from 'vitest'
import { POLICY_VERSION, type InstallationRecord } from '../../src/contracts.js'
import type { WorkflowRecord } from '../../src/workflow/contracts.js'
import { lifecycleStateFor, type WorkflowLifecycleState } from '../../src/workflow/lifecycle.js'

function workflow(overrides: Partial<WorkflowRecord> = {}): WorkflowRecord {
  return {
    policyVersion: POLICY_VERSION,
    status: 'running',
    cursor: 'resolve_local',
    ...overrides,
  } as WorkflowRecord
}

function installation(
  installOutcome: InstallationRecord['installOutcome'],
  verified = false,
): InstallationRecord {
  return { installOutcome, verified } as InstallationRecord
}

describe('public workflow lifecycle mapping', () => {
  it('maps direct workflow cursors to their public states', () => {
    const cases: Array<[WorkflowRecord['cursor'], WorkflowLifecycleState]> = [
      ['resolve_local', 'searched'],
      ['discover_remote', 'searched'],
      ['ensure_market', 'searched'],
      ['await_discovery', 'searched'],
      ['await_selection', 'selected'],
      ['review_github', 'reviewing'],
      ['review_local', 'reviewing'],
      ['install_verify', 'executing'],
      ['stopped', 'stopped'],
      ['create_authorized', 'create_authorized'],
      ['modify_authorized', 'modify_authorized'],
      ['reuse_local', 'reuse_local'],
      ['market_setup_required', 'market_setup_required'],
      ['market_restart_required', 'market_restart_required'],
      ['restart_required', 'restart_required'],
      ['recovery_required', 'recovery_required'],
      ['awaiting_user_test', 'awaiting_user_test'],
      ['activated', 'activated'],
      ['await_modify_work', 'interrupted'],
    ]
    for (const [cursor, expected] of cases) {
      expect(lifecycleStateFor(workflow({ cursor })), cursor).toBe(expected)
    }
  })

  it('maps the confirmation boundary to awaiting_confirmation', () => {
    expect(lifecycleStateFor(workflow({ cursor: 'await_confirmation', status: 'interrupted' })))
      .toBe('awaiting_confirmation')
    expect(lifecycleStateFor(workflow({ cursor: 'await_confirmation' })))
      .toBe('awaiting_confirmation')
  })

  it('never promotes an installation beyond Host-recorded evidence', () => {
    expect(lifecycleStateFor(
      workflow({ status: 'completed', cursor: 'installed' }),
      { installation: installation('verified', true) },
    )).toBe('verified')
    expect(lifecycleStateFor(
      workflow({ status: 'completed', cursor: 'installed' }),
      { installation: installation('activated') },
    )).toBe('activated')
    expect(lifecycleStateFor(
      workflow({ status: 'completed', cursor: 'installed' }),
      { installation: installation('awaiting_user_test') },
    )).toBe('awaiting_user_test')
    expect(lifecycleStateFor(
      workflow({ status: 'completed', cursor: 'installed' }),
      { installation: installation('recovery_required') },
    )).toBe('recovery_required')
  })

  it('gives stale policy, commitments, and committed recovery their required precedence', () => {
    expect(lifecycleStateFor(workflow({ policyVersion: '7', cursor: 'await_confirmation' })))
      .toBe('interrupted')
    expect(lifecycleStateFor(workflow({
      cursor: 'await_confirmation',
      actionCommitment: { id: 'commitment' } as NonNullable<WorkflowRecord['actionCommitment']>,
    }))).toBe('committed')
    expect(lifecycleStateFor(workflow({
      cursor: 'activated',
      recovery: { action: 'cleanup_and_restart' } as NonNullable<WorkflowRecord['recovery']>,
    }))).toBe('recovery_required')
    expect(lifecycleStateFor(workflow({ policyVersion: '7', status: 'completed', cursor: 'activated' })))
      .toBe('activated')
  })
})
