import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  POLICY_VERSION,
  type RequestIntent,
  type ResolutionAuthorization,
  type ResolutionRecord,
  type ResumeInput,
  type ReviewRecord,
} from '../contracts.js'
import { intentIdentity } from '../resolver/intent.js'
import type { CreationGuard } from '../creation-guard.js'
import { EvolutionError } from '../errors.js'
import { newInterruptId, ownerSessionId } from '../host-identity.js'
import { isDirectlyUsableReview } from '../review/direct-use.js'
import { hashObject } from '../state/hashes.js'
import type { StateStore } from '../state/store.js'
import {
  COMPLETED_CLEANUP_NODES,
  INTERRUPT_NODES,
  isInterruptKind,
  type WorkflowDiagnosis,
  type WorkflowExec,
  type WorkflowHost,
  type WorkflowRecord,
  type WorkflowView,
  type WorkflowViewStatus,
} from './contracts.js'
import { interruptPayload } from './graph.js'
import { lifecycleStateFor } from './lifecycle.js'
import {
  candidateSnapshotFor,
  excludedCandidateIds,
  isUnfinished,
  snapshotDigestFor,
} from './candidates.js'

export abstract class WorkflowEngineCore {
  protected readonly inflight = new Set<string>()

  constructor(
    protected readonly store: StateStore,
    protected readonly creationGuard: CreationGuard,
    protected readonly host: WorkflowHost,
  ) {}

  protected assertOwner(workflow: WorkflowRecord, exec: ToolRunContext): void {
    const sessionId = ownerSessionId(exec.agent)
    if (!sessionId || workflow.ownerSessionId !== sessionId) {
      throw new EvolutionError('invalid_input', 'Workflow belongs to a different owner session', {
        expected: workflow.ownerSessionId,
        actual: sessionId,
      })
    }
    if (workflow.policyVersion !== POLICY_VERSION) {
      throw new EvolutionError('invalid_input', 'Workflow predates the current policy and cannot be controlled')
    }
  }

  protected assertDiscoveryControl(workflow: WorkflowRecord, exec: ToolRunContext): void {
    this.assertOwner(workflow, exec)
    if (workflow.status !== 'interrupted' || workflow.cursor !== 'await_discovery' || workflow.interrupt) {
      throw new EvolutionError('invalid_input', 'Workflow is not at the autonomous discovery checkpoint', {
        status: workflow.status,
        cursor: workflow.cursor,
      })
    }
    workflow.bootId = this.creationGuard.bootId
  }

  protected clearWorkflowGrant(workflow: WorkflowRecord): void {
    delete workflow.selectionReceipt
    delete workflow.actionCommitment
    delete workflow.executionLease
  }

  protected settleTerminalGrant(workflow: WorkflowRecord, exec: ToolRunContext): void {
    if (workflow.cursor === 'reuse_local') return
    if (workflow.cursor === 'stopped') {
      delete workflow.executionLease
      this.creationGuard.invalidateExecutionLease(exec.agent)
      return
    }
    this.clearWorkflowGrant(workflow)
    this.creationGuard.invalidateExecutionLease(exec.agent)
  }

  protected async reviewsForWorkflow(workflow: WorkflowRecord): Promise<ReviewRecord[]> {
    const ids = [...new Set([
      ...Object.values(workflow.reviewIdsByCandidate ?? {}),
      ...(workflow.lastReviewId ? [workflow.lastReviewId] : []),
    ])]
    const reviews: ReviewRecord[] = []
    for (const id of ids) {
      const review = await this.host.getReview(id).catch(() => undefined)
      if (review) reviews.push(review)
    }
    return reviews.sort((left, right) => {
      const rank = (review: ReviewRecord): number => {
        if (isDirectlyUsableReview(review, workflow)) return 0
        if (review.recommendation === 'modify' || review.fit !== 'none') return 1
        return 2
      }
      return rank(left) - rank(right) || left.createdAt.localeCompare(right.createdAt)
    })
  }

  protected async reviewForAuthorization(
    workflow: WorkflowRecord,
    reviews: ReviewRecord[],
    candidateId: string | undefined,
  ): Promise<ReviewRecord> {
    if (!candidateId) {
      throw new EvolutionError('invalid_input', 'Final use/modify decision requires an exact candidate_id')
    }
    const reviewId = workflow.reviewIdsByCandidate?.[candidateId]
    if (!reviewId) {
      throw new EvolutionError('invalid_input', 'candidate_id has no review bound in this workflow', { candidateId })
    }
    const review = reviews.find((item) => item.id === reviewId)
    if (!review) {
      throw new EvolutionError('invalid_input', 'candidate_id review is missing from the current review snapshot', {
        candidateId,
        reviewId,
      })
    }
    return review
  }

  protected async findReusableWorkflow(
    sessionId: string,
    cwd: string,
    requirementNormalized: string,
    intent: RequestIntent,
  ): Promise<WorkflowRecord | undefined> {
    const wanted = intentIdentity(intent)
    const workflows = await this.store.listWorkflows()
    const matches = workflows
      .filter((item) => isUnfinished(item.status)
        && item.ownerSessionId === sessionId
        && item.cwd === cwd
        && item.requirementNormalized === requirementNormalized
        && item.policyVersion === POLICY_VERSION
        && (item.intent
          ? intentIdentity(item.intent) === wanted
          : item.status === 'running'))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    return matches[0]
  }

  protected async invalidateStalePolicyWorkflows(
    sessionId: string,
    requirementNormalized: string,
    exec: ToolRunContext,
  ): Promise<void> {
    const workflows = await this.store.listWorkflows()
    const stale = workflows.filter((item) => isUnfinished(item.status)
      && item.ownerSessionId === sessionId
      && item.requirementNormalized === requirementNormalized
      && item.policyVersion !== POLICY_VERSION)
    for (const item of stale) {
      await this.withLock(item.id, async () => {
        const latest = await this.store.getWorkflow(item.id)
        if (isUnfinished(latest.status) && latest.policyVersion !== POLICY_VERSION) {
          await this.invalidateLegacyPolicyWorkflow(latest, exec)
        }
      })
    }
  }

  protected async invalidateLegacyPolicyWorkflow(
    workflow: WorkflowRecord,
    exec: ToolRunContext,
  ): Promise<void> {
    delete workflow.interrupt
    this.clearWorkflowGrant(workflow)
    this.creationGuard.invalidateExecutionLease(exec.agent)
    await this.host.releaseManagedSource?.(workflow, exec as WorkflowExec).catch(() => undefined)
    workflow.status = 'completed'
    workflow.lastFailure = {
      stage: 'workflow',
      code: 'policy_restart_required',
      message: 'This workflow predates Policy V9. Call capability_workflow again to start a fresh discovery. Previous interrupts, decisions, receipts, verdicts, commitments, and leases are not executable.',
      retryable: false,
    }
    await this.checkpoint(workflow)
  }

  protected async reissueInterrupt(workflow: WorkflowRecord, exec: ToolRunContext): Promise<void> {
    this.creationGuard.invalidateExecutionLease(exec.agent)
    if (workflow.cursor === 'recovery_required') {
      await this.issueRecoveryInterrupt(workflow, exec)
      return
    }
    if (!workflow.resolutionId || !INTERRUPT_NODES.has(workflow.cursor)) return
    const resolution = await this.host.getResolution(workflow.resolutionId)
    if (!workflow.candidateSnapshot) {
      workflow.candidateSnapshot = candidateSnapshotFor(resolution, excludedCandidateIds(workflow))
    }
    const reviews = await this.reviewsForWorkflow(workflow)
    const installProfiles = workflow.cursor === 'await_confirmation'
      ? await this.host.listInstallProfiles?.() ?? []
      : []
    const managedActionsAvailable = workflow.cursor === 'await_confirmation'
      ? await this.host.managedWorkAvailable?.(exec as WorkflowExec) ?? true
      : true
    const base = interruptPayload(workflow.cursor, resolution, reviews, {
      ...(workflow.lastFailure ? { lastFailure: workflow.lastFailure } : {}),
      ...(installProfiles.length > 0 ? { installProfiles } : {}),
      ...(workflow.pendingPath ? { pendingPath: workflow.pendingPath } : {}),
      workflow,
      managedActionsAvailable,
    })
    const sessionId = workflow.ownerSessionId ?? ownerSessionId(exec.agent)
    if (!sessionId) {
      throw new EvolutionError('invalid_input', 'Cannot reissue interrupt without an owner session')
    }
    const validAfterTurnId = this.creationGuard.currentTurnId(exec.agent) ?? `turn_${'0'.repeat(24)}`
    const snapshotDigest = snapshotDigestFor(base.kind, resolution, reviews, workflow)
    workflow.bootId = this.creationGuard.bootId
    workflow.interrupt = {
      ...base,
      interruptId: newInterruptId({
        ownerSessionId: sessionId,
        bootId: this.creationGuard.bootId,
        validAfterTurnId,
        snapshotDigest,
      }),
      ownerSessionId: sessionId,
      bootId: this.creationGuard.bootId,
      validAfterTurnId,
      snapshotDigest,
    }
    workflow.status = 'interrupted'
    await this.checkpoint(workflow)
  }

  protected async issueRecoveryInterrupt(workflow: WorkflowRecord, exec: ToolRunContext): Promise<void> {
    const sessionId = workflow.ownerSessionId ?? ownerSessionId(exec.agent)
    if (!sessionId) throw new EvolutionError('invalid_input', 'Cannot issue recovery control without an owner session')
    const validAfterTurnId = this.creationGuard.currentTurnId(exec.agent) ?? `turn_${'0'.repeat(24)}`
    const snapshotDigest = this.recoverySnapshotDigest(workflow)
    workflow.bootId = this.creationGuard.bootId
    workflow.ownerSessionId = sessionId
    workflow.status = 'interrupted'
    workflow.interrupt = {
      kind: 'await_recovery',
      interruptId: newInterruptId({
        ownerSessionId: sessionId,
        bootId: this.creationGuard.bootId,
        validAfterTurnId,
        snapshotDigest,
      }),
      ownerSessionId: sessionId,
      bootId: this.creationGuard.bootId,
      validAfterTurnId,
      snapshotDigest,
      options: [],
      facts: {},
    }
    await this.checkpoint(workflow)
  }

  protected recoverySnapshotDigest(workflow: WorkflowRecord): string {
    return hashObject({
      workflowId: workflow.id,
      policyVersion: workflow.policyVersion,
      generation: workflow.generation,
      lastInstallationId: workflow.lastInstallationId ?? null,
      lastFailure: workflow.lastFailure ?? null,
    })
  }

  protected markInstallCompletion(workflow: WorkflowRecord, exec: ToolRunContext): void {
    if (!COMPLETED_CLEANUP_NODES.has(workflow.cursor)) return
    const turnId = this.creationGuard.currentTurnId(exec.agent)
    if (turnId) workflow.completionTurnId = turnId
  }

  protected async withLock<T>(id: string, run: () => Promise<T>): Promise<T> {
    if (this.inflight.has(id)) {
      throw new EvolutionError('invalid_input', 'This workflow is already running')
    }
    this.inflight.add(id)
    try {
      return await run()
    } finally {
      this.inflight.delete(id)
    }
  }

  protected async checkpoint(workflow: WorkflowRecord): Promise<void> {
    workflow.updatedAt = new Date().toISOString()
    await this.store.put('workflows', workflow)
  }

  protected syncGuard(
    workflow: WorkflowRecord,
    exec: ToolRunContext,
    guardGeneration: number | undefined,
    resolution?: { authorization?: ResolutionAuthorization },
  ): void {
    const authorization = resolution?.authorization
    if (authorization && exec.agent) {
      if (guardGeneration !== undefined) {
        this.creationGuard.applyResolutionAuthorization(exec.agent, authorization, guardGeneration)
      } else {
        this.creationGuard.applyReviewAuthorization(exec.agent, authorization)
      }
    }
    this.creationGuard.setWaiting(
      exec.agent,
      workflow.cursor === 'await_discovery'
        ? 'await_discovery'
        : isInterruptKind(workflow.cursor) ? workflow.cursor : undefined,
      workflow.interrupt?.validAfterTurnId,
    )
  }

  protected async view(
    workflow: WorkflowRecord,
    resolution?: WorkflowView['resolution'],
    extras: {
      status?: WorkflowViewStatus
      alreadyWaiting?: boolean
      resumeHint?: string
      diagnosis?: WorkflowDiagnosis
      skipLinkedReads?: boolean
    } = {},
  ): Promise<WorkflowView> {
    const current = resolution ?? (!extras.skipLinkedReads && workflow.resolutionId
      ? await this.host.getResolution(workflow.resolutionId).catch(() => undefined)
      : undefined)
    const review = workflow.lastReviewId
      ? await this.host.getReview(workflow.lastReviewId).catch(() => undefined)
      : undefined
    const reviews = await this.reviewsForWorkflow(workflow)
    const installation = workflow.lastInstallationId
      ? await this.host.getInstallation(workflow.lastInstallationId).catch(() => undefined)
      : undefined
    const lifecycleState = lifecycleStateFor(workflow, {
      ...(reviews.length > 0 ? { reviews } : {}),
      ...(installation ? { installation } : {}),
    })
    return JSON.parse(JSON.stringify({
      workflow,
      lifecycleState,
      ...(current ? { resolution: current } : {}),
      ...(review ? { review } : {}),
      ...(reviews.length > 0 ? { reviews } : {}),
      ...(installation ? { installation } : {}),
      ...(extras.diagnosis ? { diagnosis: extras.diagnosis } : {}),
      ...(extras.status ? { status: extras.status } : {}),
      ...(extras.alreadyWaiting ? { alreadyWaiting: true } : {}),
      ...(extras.resumeHint ? { resumeHint: extras.resumeHint } : {}),
    })) as WorkflowView
  }

  protected async invalidResumeView(
    workflow: WorkflowRecord,
    resolution: ResolutionRecord,
    exec: ToolRunContext,
    input: ResumeInput,
    summary: string,
  ): Promise<WorkflowView> {
    const hostTurnId = this.creationGuard.currentTurnId(exec.agent) ?? 'turn_unknown'
    const fingerprint = hashObject({ navigation: input.navigation, decision: input.decision })
    const prior = workflow.invalidResumeAttempt
    const repeated = prior?.hostTurnId === hostTurnId && prior.fingerprint === fingerprint
    workflow.invalidResumeAttempt = {
      hostTurnId,
      fingerprint,
      count: repeated ? Math.min(2, prior.count + 1) : 1,
    }
    await this.checkpoint(workflow)
    return await this.view(workflow, resolution, {
      status: 'invalid_resume',
      resumeHint: workflow.invalidResumeAttempt.count >= 2
        ? `Repeated invalid action is blocked until a fresh user turn. ${summary}`
        : summary,
    })
  }
}
