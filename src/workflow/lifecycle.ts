import { POLICY_VERSION, type InstallationRecord, type ReviewRecord } from '../contracts.js'
import { needsSemanticReviewer } from '../review/review.js'
import { COMPLETED_CLEANUP_NODES, type WorkflowNodeId, type WorkflowRecord } from './contracts.js'

/**
 * Public workflow lifecycle presentation. Internal `cursor` names stay on the
 * record for graph safety; this field is a deterministic mapping only.
 */
export type WorkflowLifecycleState =
  | 'searched'
  | 'selected'
  | 'reviewing'
  | 'approved'
  | 'rejected'
  | 'uncertain'
  | 'skipped'
  | 'awaiting_confirmation'
  | 'committed'
  | 'leased'
  | 'executing'
  | 'verified'
  | 'activated'
  | 'awaiting_user_test'
  | 'recovery_required'
  | 'restart_required'
  | 'market_restart_required'
  | 'market_setup_required'
  | 'modify_authorized'
  | 'create_authorized'
  | 'stopped'
  | 'interrupted'
  | 'reuse_local'

export interface LifecycleMappingInput {
  reviews?: readonly ReviewRecord[]
  installation?: InstallationRecord
}

function reviewDecisionState(review: ReviewRecord | undefined): WorkflowLifecycleState | undefined {
  if (!review) return undefined
  const decision = review.reviewerVerdict?.decision
  if (decision === 'approved') return 'approved'
  if (decision === 'rejected') return 'rejected'
  if (decision === 'uncertain') return 'uncertain'
  if (!needsSemanticReviewer(review)) return 'skipped'
  return undefined
}

function installedLifecycle(installation: InstallationRecord | undefined): WorkflowLifecycleState {
  if (installation?.installOutcome === 'awaiting_user_test') return 'awaiting_user_test'
  if (installation?.installOutcome === 'activated' && installation.verified !== true) return 'activated'
  if (installation?.verified === true && installation.installOutcome === 'verified') return 'verified'
  return 'recovery_required'
}

/** Map internal cursor/status/grants to the public lifecycle state. Never claims verified early. */
export function lifecycleStateFor(
  workflow: Pick<
    WorkflowRecord,
    'status' | 'cursor' | 'policyVersion' | 'actionCommitment' | 'executionLease' | 'lastFailure'
  >,
  extras: LifecycleMappingInput = {},
): WorkflowLifecycleState {
  const readableLegacyCompletion = workflow.policyVersion !== POLICY_VERSION
    && workflow.status === 'completed'
    && COMPLETED_CLEANUP_NODES.has(workflow.cursor)
  if ((!readableLegacyCompletion && workflow.policyVersion !== POLICY_VERSION) || workflow.lastFailure?.code === 'policy_restart_required') {
    return 'interrupted'
  }

  const cursor: WorkflowNodeId = workflow.cursor
  if (cursor === 'stopped') return 'stopped'
  if (cursor === 'create_authorized') return 'create_authorized'
  if (cursor === 'modify_authorized') return 'modify_authorized'
  if (cursor === 'reuse_local') return 'reuse_local'
  if (cursor === 'market_setup_required') return 'market_setup_required'
  if (cursor === 'market_restart_required') return 'market_restart_required'
  if (cursor === 'restart_required') return 'restart_required'
  if (cursor === 'recovery_required') return 'recovery_required'
  if (cursor === 'awaiting_user_test') return 'awaiting_user_test'
  if (cursor === 'activated') return 'activated'
  if (cursor === 'installed') return installedLifecycle(extras.installation)

  if (workflow.executionLease) return 'leased'
  if (cursor === 'install_verify') return 'executing'
  if (cursor === 'prepare_modify' || cursor === 'prepare_create') {
    return workflow.actionCommitment ? 'committed' : 'executing'
  }
  if (workflow.actionCommitment) return 'committed'

  if (cursor === 'review_github' || cursor === 'review_local') return 'reviewing'
  if (cursor === 'resolve_local' || cursor === 'discover_remote' || cursor === 'ensure_market' || cursor === 'await_discovery') return 'searched'
  if (cursor === 'await_selection') return 'selected'
  if (cursor === 'await_modify_work') return 'interrupted'
  if (cursor === 'await_confirmation') {
    return reviewDecisionState(extras.reviews?.[0]) ?? 'awaiting_confirmation'
  }
  if (workflow.status === 'interrupted') return 'interrupted'
  if (workflow.status === 'failed') return 'recovery_required'
  return 'searched'
}
