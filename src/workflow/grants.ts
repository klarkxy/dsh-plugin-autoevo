import {
  BRIDGE_EXECUTION_TOOLS,
  type ActionCommitment,
  type DecisionPhase,
  type ExecutionEndpoint,
  type ExecutionLease,
  type ReviewRecord,
  type SelectionReceipt,
} from '../contracts.js'
import { EvolutionError } from '../errors.js'
import { needsSemanticReviewer } from '../review/review.js'
import {
  frozenManifestDigest,
  reviewCandidateDigest,
  reviewerBindingDigest,
  reviewSnapshotDigest,
} from '../review/direct-use.js'
import { hashObject } from '../state/hashes.js'
import type { CandidateSnapshotItem, InterruptPayload, WorkflowRecord } from './contracts.js'

function frozenIdentityFor(candidate: CandidateSnapshotItem): ActionCommitment['frozenIdentity'] {
  return {
    kind: candidate.kind,
    name: candidate.name,
    identity: candidate.identity,
    ...(candidate.localKind ? { localKind: candidate.localKind } : {}),
    ...(candidate.availability ? { availability: candidate.availability } : {}),
    ...(candidate.fit ? { fit: candidate.fit } : {}),
    ...(candidate.repository ? { repository: candidate.repository } : {}),
  }
}

export function endpointForLocalReuse(candidate: CandidateSnapshotItem): ExecutionEndpoint {
  const name = candidate.localName ?? candidate.name
  if (candidate.availability === 'available_via_tool_search') {
    return {
      kind: 'bridge',
      tools: [...BRIDGE_EXECUTION_TOOLS],
      target: name,
    }
  }
  if (candidate.availability === 'available') {
    return { kind: 'exact_tool', name }
  }
  if (candidate.availability === 'known_source') {
    throw new EvolutionError('invalid_input', 'Known-source lineage cannot be reused unchanged; review it first')
  }
  if (candidate.availability === 'installed_in_profile') return { kind: 'none' }
  throw new EvolutionError('invalid_input', 'reuse_local cannot derive an exact endpoint from this snapshot candidate', {
    candidateId: candidate.id,
    availability: candidate.availability,
  })
}

export function mintSelectionReceipt(input: {
  workflowId: string
  interrupt: InterruptPayload
  phase: DecisionPhase
  kind: SelectionReceipt['kind']
  candidateIds: string[]
  recoveryId?: string
  snapshot: CandidateSnapshotItem[]
  hostTurnId: string
}): SelectionReceipt {
  const candidateDigests: Record<string, string> = {}
  for (const id of input.candidateIds) {
    const item = input.snapshot.find((entry) => entry.id === id)
    if (item) candidateDigests[id] = item.digest
  }
  const createdAt = new Date().toISOString()
  return {
    id: `selection_${hashObject({
      workflowId: input.workflowId,
      interruptId: input.interrupt.interruptId,
      snapshotDigest: input.interrupt.snapshotDigest,
      phase: input.phase,
      kind: input.kind,
      candidateIds: input.candidateIds,
      candidateDigests,
      recoveryId: input.recoveryId,
      hostTurnId: input.hostTurnId,
      createdAt,
    }).slice(0, 24)}`,
    workflowId: input.workflowId,
    interruptId: input.interrupt.interruptId,
    snapshotDigest: input.interrupt.snapshotDigest,
    phase: input.phase,
    kind: input.kind,
    candidateIds: input.candidateIds,
    candidateDigests,
    ...(input.recoveryId ? { recoveryId: input.recoveryId } : {}),
    hostTurnId: input.hostTurnId,
    ownerSessionId: input.interrupt.ownerSessionId,
    bootId: input.interrupt.bootId,
    createdAt,
  }
}

export function assertBuiltinEnablementBinding(
  workflow: WorkflowRecord,
  phase: SelectionReceipt['phase'],
): {
  candidate: CandidateSnapshotItem
  endpoint: Extract<ExecutionEndpoint, { kind: 'host_bundled_enable' }>
} {
  const receipt = workflow.selectionReceipt
  const commitment = workflow.actionCommitment
  const candidateId = receipt?.candidateIds.length === 1 ? receipt.candidateIds[0] : undefined
  const candidate = candidateId
    ? workflow.candidateSnapshot?.find((item) => item.id === candidateId)
    : undefined
  const endpoint = commitment?.endpoint
  const bundled = candidate?.hostBundled
  if (!receipt
    || receipt.phase !== phase
    || receipt.kind !== 'enable_builtin'
    || !candidateId
    || !candidate
    || candidate.kind !== 'local'
    || candidate.availability !== 'host_bundled'
    || !bundled
    || receipt.candidateDigests[candidateId] !== candidate.digest
    || !commitment
    || commitment.selectionReceiptId !== receipt.id
    || commitment.snapshotDigest !== receipt.snapshotDigest
    || commitment.requestedAction !== 'enable_builtin'
    || commitment.candidateId !== candidateId
    || commitment.candidateDigest !== candidate.digest
    || endpoint?.kind !== 'host_bundled_enable'
    || endpoint.packageName !== bundled.packageName
    || endpoint.version !== bundled.version
    || endpoint.mountId !== bundled.mountId
    || !endpoint.targetProfile
    || commitment.targetProfile !== endpoint.targetProfile) {
    throw new EvolutionError(
      'review_expired',
      `enable_builtin requires an exact frozen ${phase} candidate, mount, and profile binding`,
    )
  }
  return { candidate, endpoint }
}

export function mintActionCommitment(input: {
  receipt: SelectionReceipt
  action: SelectionReceipt['kind']
  candidate?: CandidateSnapshotItem
  endpoint: ExecutionEndpoint
  retention?: ActionCommitment['retention']
  targetProfile?: string
  recoveryPlan?: ActionCommitment['allowedParameterConstraints']['recoveryPlan']
  review?: ReviewRecord
  workflow?: WorkflowRecord
}): ActionCommitment {
  const createdAt = new Date().toISOString()
  const review = input.review
  const reviewSnapshot = review ? reviewSnapshotDigest(review) : undefined
  const manifestDigest = review ? frozenManifestDigest(review) : undefined
  const candidateDigest = input.candidate?.digest
    ?? (review ? reviewCandidateDigest(review, input.workflow) : undefined)
  const reviewerRequestId = review && needsSemanticReviewer(review) ? review.reviewerRequestId : undefined
  const reviewerVerdictDigest = review && needsSemanticReviewer(review) && review.reviewerVerdict
    ? reviewerBindingDigest(review.reviewerVerdict)
    : undefined
  return {
    id: `commitment_${hashObject({
      selectionReceiptId: input.receipt.id,
      snapshotDigest: input.receipt.snapshotDigest,
      action: input.action,
      candidateId: input.candidate?.id,
      candidateDigest,
      endpoint: input.endpoint,
      retention: input.retention,
      reviewId: review?.id,
      reviewSnapshot,
      reviewerRequestId,
      reviewerVerdictDigest,
      recoveryPlan: input.recoveryPlan,
      createdAt,
    }).slice(0, 24)}`,
    selectionReceiptId: input.receipt.id,
    snapshotDigest: input.receipt.snapshotDigest,
    ...(input.candidate ? { candidateId: input.candidate.id } : {}),
    ...(candidateDigest ? { candidateDigest } : {}),
    frozenIdentity: input.candidate ? frozenIdentityFor(input.candidate) : { kind: 'none' },
    requestedAction: input.action,
    ...(input.receipt.recoveryId ? { recoveryId: input.receipt.recoveryId } : {}),
    ...(input.retention ? { retention: input.retention } : {}),
    ...(input.targetProfile ? { targetProfile: input.targetProfile } : {}),
    endpoint: input.endpoint,
    allowedParameterConstraints: {
      ...(input.endpoint.kind === 'bridge' ? { exactTarget: input.endpoint.target } : {}),
      ...(input.recoveryPlan ? { recoveryPlan: input.recoveryPlan } : {}),
    },
    createdAt,
    ...(review ? { reviewId: review.id } : {}),
    ...(reviewSnapshot ? { reviewSnapshotDigest: reviewSnapshot } : {}),
    ...(reviewerRequestId ? { reviewerRequestId } : {}),
    ...(reviewerVerdictDigest ? { reviewerVerdictDigest } : {}),
    ...(manifestDigest ? { frozenManifestDigest: manifestDigest } : {}),
    ...(review ? { frozenInstallSpec: review.installSpec } : {}),
  }
}

export function mintExecutionLease(input: {
  receipt: SelectionReceipt
  commitment: ActionCommitment
}): ExecutionLease {
  if (input.commitment.endpoint.kind === 'none') {
    throw new EvolutionError('invalid_input', 'Execution lease requires an exact endpoint or bridge closure')
  }
  const createdAt = new Date().toISOString()
  return {
    id: `lease_${hashObject({
      commitmentId: input.commitment.id,
      selectionReceiptId: input.receipt.id,
      hostTurnId: input.receipt.hostTurnId,
      createdAt,
    }).slice(0, 24)}`,
    commitmentId: input.commitment.id,
    selectionReceiptId: input.receipt.id,
    workflowId: input.receipt.workflowId,
    ownerSessionId: input.receipt.ownerSessionId,
    bootId: input.receipt.bootId,
    hostTurnId: input.receipt.hostTurnId,
    interruptId: input.receipt.interruptId,
    snapshotDigest: input.receipt.snapshotDigest,
    ...(input.commitment.candidateId ? { candidateId: input.commitment.candidateId } : {}),
    ...(input.commitment.candidateDigest ? { candidateDigest: input.commitment.candidateDigest } : {}),
    requestedAction: input.commitment.requestedAction,
    endpoint: input.commitment.endpoint,
    allowedParameterConstraints: input.commitment.allowedParameterConstraints,
    createdAt,
  }
}
