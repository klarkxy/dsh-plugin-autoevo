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
  type InterruptPayload,
  type WorkflowDiagnosis,
  type WorkflowExec,
  type WorkflowHost,
  type WorkflowRecord,
  type WorkflowView,
  type WorkflowViewStatus,
  retryableInstallContext,
  reviewSourceIdentity,
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
    protected readonly requireHostCapturedRequirement = true,
  ) {}

  protected requireHostTurnId(exec: ToolRunContext, purpose: string): string {
    const turnId = this.creationGuard.currentTurnId(exec.agent)
    if (turnId) return turnId
    if (!this.requireHostCapturedRequirement) return `turn_${'0'.repeat(24)}`
    throw new EvolutionError('invalid_input', `Cannot ${purpose} without a current Host user turn`)
  }

  protected async awaitPreEffect<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    try {
      const result = await operation()
      signal?.throwIfAborted()
      return result
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      throw error
    }
  }

  protected async readOptionalBeforeEffect<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T | undefined> {
    try {
      return await this.awaitPreEffect(operation, signal)
    } catch (error) {
      if (error instanceof EvolutionError && error.code === 'not_found') return undefined
      throw error
    }
  }

  protected cleanupExec(exec: ToolRunContext): WorkflowExec {
    const { signal: _ignoredSignal, ...cleanup } = exec
    return cleanup as WorkflowExec
  }

  protected assertSameOwner(workflow: WorkflowRecord, exec: ToolRunContext): void {
    const sessionId = ownerSessionId(exec.agent)
    if (!sessionId || workflow.ownerSessionId !== sessionId) {
      throw new EvolutionError('invalid_input', 'Workflow belongs to a different owner session', {
        expected: workflow.ownerSessionId,
        actual: sessionId,
      })
    }
  }

  protected assertOwner(workflow: WorkflowRecord, exec: ToolRunContext): void {
    this.assertSameOwner(workflow, exec)
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
  }

  protected settleTerminalGrant(workflow: WorkflowRecord, exec: ToolRunContext): void {
    if (workflow.cursor === 'reuse_local') return
    if (workflow.cursor === 'stopped') {
      this.creationGuard.invalidateHostGrant(exec.agent)
      return
    }
    this.clearWorkflowGrant(workflow)
    this.creationGuard.invalidateHostGrant(exec.agent)
  }

  protected async reviewsForWorkflow(
    workflow: WorkflowRecord,
    signal?: AbortSignal,
  ): Promise<ReviewRecord[]> {
    const ids = [...new Set([
      ...Object.values(workflow.reviewIdsByCandidate ?? {}),
      ...(workflow.lastReviewId ? [workflow.lastReviewId] : []),
    ])]
    const reviews: ReviewRecord[] = []
    for (const id of ids) {
      signal?.throwIfAborted()
      try {
        const review = await this.host.getReview(id)
        signal?.throwIfAborted()
        reviews.push(review)
      } catch (error) {
        if (signal?.aborted) throw signal.reason
        if (!(error instanceof EvolutionError) || error.code !== 'not_found') throw error
      }
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

  protected assertResolutionInterruptShape(
    workflow: WorkflowRecord,
    resolution: ResolutionRecord,
  ): void {
    if (resolution.id !== workflow.resolutionId
      || resolution.schemaVersion !== 2
      || (resolution.remoteDiscoveryComplete !== undefined
        && typeof resolution.remoteDiscoveryComplete !== 'boolean')) {
      throw new EvolutionError('invalid_input', 'Workflow resolution control state is malformed; no decision was applied')
    }
  }

  protected async canonicalInterruptPayload(
    workflow: WorkflowRecord,
    resolution: ResolutionRecord | undefined,
    reviews: ReviewRecord[],
    exec: ToolRunContext,
  ): Promise<Omit<InterruptPayload, 'interruptId' | 'ownerSessionId' | 'bootId' | 'validAfterTurnId' | 'snapshotDigest'>> {
    const signal = exec.signal
    signal?.throwIfAborted()
    if (workflow.cursor === 'await_clarification') {
      return interruptPayload('await_clarification', undefined, reviews, { workflow })
    }
    if (!resolution) {
      throw new EvolutionError('invalid_input', 'Workflow interrupt is missing its exact resolution')
    }
    this.assertResolutionInterruptShape(workflow, resolution)
    const installProfiles = workflow.cursor === 'await_confirmation'
      ? await this.awaitPreEffect(async () => await this.host.listInstallProfiles(), signal)
      : []
    const managedActionsAvailable = workflow.cursor === 'await_confirmation'
      || workflow.cursor === 'await_selection'
      ? await this.awaitPreEffect(
          async () => await this.host.managedWorkAvailable(exec as WorkflowExec),
          signal,
        )
      : true
    const retryableInstall = workflow.cursor === 'await_confirmation'
      ? await this.retryableInstall(workflow, signal)
      : undefined
    signal?.throwIfAborted()
    return interruptPayload(workflow.cursor, resolution, reviews, {
      ...(workflow.lastFailure ? { lastFailure: workflow.lastFailure } : {}),
      ...(installProfiles.length > 0 ? { installProfiles } : {}),
      ...(workflow.pendingPath ? { pendingPath: workflow.pendingPath } : {}),
      workflow,
      managedActionsAvailable,
      ...(retryableInstall ? { retryableInstall } : {}),
    })
  }

  protected assertCanonicalInterrupt(
    workflow: WorkflowRecord,
    expected: Omit<InterruptPayload, 'interruptId' | 'ownerSessionId' | 'bootId' | 'validAfterTurnId' | 'snapshotDigest'>,
  ): void {
    const authorizingOptions = (options: InterruptPayload['options']) => options.map((option) => ({
      id: option.id,
      ...(option.candidateIds ? { candidateIds: option.candidateIds } : {}),
      ...(option.recoveryIds ? { recoveryIds: option.recoveryIds } : {}),
    }))
    if (!workflow.interrupt
      || workflow.interrupt.kind !== workflow.cursor
      || hashObject({
        kind: workflow.interrupt.kind,
        options: authorizingOptions(workflow.interrupt.options),
        facts: workflow.interrupt.facts,
      }) !== hashObject({
        kind: expected.kind,
        options: authorizingOptions(expected.options),
        facts: expected.facts,
      })) {
      throw new EvolutionError('invalid_input', 'Workflow interrupt policy no longer matches canonical Host control; no decision was applied')
    }
  }

  protected async retryableInstall(
    workflow: WorkflowRecord,
    signal?: AbortSignal,
  ): Promise<import('./contracts.js').RetryableInstallContext | undefined> {
    if (!workflow.lastInstallationId) return undefined
    const installation = await this.readOptionalBeforeEffect(
      () => this.host.getInstallation(workflow.lastInstallationId!),
      signal,
    )
    return installation ? retryableInstallContext(workflow, installation) : undefined
  }

  protected async clearErroneousVerificationAttempt(
    workflow: WorkflowRecord,
    review: ReviewRecord,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!workflow.lastInstallationId) return
    const installation = await this.readOptionalBeforeEffect(
      () => this.host.getInstallation(workflow.lastInstallationId!),
      signal,
    )
    if (!installation || retryableInstallContext(workflow, installation)?.reviewId !== review.id) return
    const attempts = workflow.consumedVerificationAttempts ?? []
    const layer = review.runtimeSurface?.verificationLayer ?? installation.verification.layer ?? 'unspecified'
    const fixtureDigest = installation.verification.fixtureDigest
    const sourceIdentity = reviewSourceIdentity(review)
    const index = attempts.findIndex((attempt) => attempt.reviewId === review.id
      && attempt.sourceIdentity === sourceIdentity
      && attempt.layer === layer
      && attempt.fixtureDigest === fixtureDigest)
    if (index < 0) return
    const next = [...attempts]
    next.splice(index, 1)
    if (next.length > 0) workflow.consumedVerificationAttempts = next
    else delete workflow.consumedVerificationAttempts
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
    signal?: AbortSignal,
  ): Promise<WorkflowRecord | undefined> {
    const wanted = intentIdentity(intent)
    let workflows: WorkflowRecord[]
    try {
      workflows = await this.store.listWorkflowsStrict()
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      throw error
    }
    signal?.throwIfAborted()
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
    let workflows: WorkflowRecord[]
    try {
      workflows = await this.store.listWorkflowsStrict()
    } catch (error) {
      if (exec.signal?.aborted) throw exec.signal.reason
      throw error
    }
    exec.signal?.throwIfAborted()
    const stale = workflows.filter((item) => isUnfinished(item.status)
      && item.ownerSessionId === sessionId
      && item.requirementNormalized === requirementNormalized
      && item.policyVersion !== POLICY_VERSION)
    for (const item of stale) {
      await this.withLock(item.id, async () => {
        const latest = await this.store.getWorkflow(item.id)
        exec.signal?.throwIfAborted()
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
    this.creationGuard.invalidateHostGrant(exec.agent)
    exec.signal?.throwIfAborted()
    await this.host.releaseManagedSource?.(workflow, exec as WorkflowExec)
    exec.signal?.throwIfAborted()
    workflow.status = 'completed'
    workflow.lastFailure = {
      stage: 'workflow',
      code: 'policy_restart_required',
      message: 'This workflow predates the current policy. Call capability_workflow again from the current user requirement. Previous interrupts, decisions, receipts, verdicts, commitments, and leases are not executable.',
      retryable: false,
    }
    await this.checkpoint(workflow)
  }

  protected async reissueInterrupt(workflow: WorkflowRecord, exec: ToolRunContext): Promise<void> {
    this.creationGuard.invalidateHostGrant(exec.agent)
    if (workflow.cursor === 'recovery_required') {
      await this.awaitPreEffect(() => this.issueRecoveryInterrupt(workflow, exec), exec.signal)
      return
    }
    if (workflow.cursor === 'await_clarification') {
      await this.awaitPreEffect(() => this.issueClarificationInterrupt(workflow, exec), exec.signal)
      return
    }
    if (!workflow.resolutionId || !INTERRUPT_NODES.has(workflow.cursor)) return
    const resolution = await this.awaitPreEffect(
      () => this.host.getResolution(workflow.resolutionId!),
      exec.signal,
    )
    if (!workflow.candidateSnapshot) {
      workflow.candidateSnapshot = candidateSnapshotFor(resolution, excludedCandidateIds(workflow))
    }
    const reviews = await this.reviewsForWorkflow(workflow, exec.signal)
    const base = await this.canonicalInterruptPayload(workflow, resolution, reviews, exec)
    const sessionId = workflow.ownerSessionId ?? ownerSessionId(exec.agent)
    if (!sessionId) {
      throw new EvolutionError('invalid_input', 'Cannot reissue interrupt without an owner session')
    }
    const validAfterTurnId = this.requireHostTurnId(exec, 'reissue a workflow interrupt')
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
    await this.awaitPreEffect(() => this.checkpoint(workflow), exec.signal)
  }

  protected clarificationSnapshotDigest(workflow: WorkflowRecord): string {
    return hashObject({
      workflowId: workflow.id,
      policyVersion: workflow.policyVersion,
      generation: workflow.generation,
      requirement: workflow.requirement,
      clarificationQuestion: workflow.clarificationQuestion ?? null,
    })
  }

  protected async issueClarificationInterrupt(workflow: WorkflowRecord, exec: ToolRunContext): Promise<void> {
    const sessionId = workflow.ownerSessionId ?? ownerSessionId(exec.agent)
    if (!sessionId) throw new EvolutionError('invalid_input', 'Cannot issue clarification without an owner session')
    if (!workflow.clarificationQuestion) {
      throw new EvolutionError('invalid_input', 'Clarification checkpoint is missing its question')
    }
    const validAfterTurnId = this.requireHostTurnId(exec, 'issue a clarification interrupt')
    const snapshotDigest = this.clarificationSnapshotDigest(workflow)
    const base = interruptPayload('await_clarification', undefined, [], { workflow })
    workflow.bootId = this.creationGuard.bootId
    workflow.ownerSessionId = sessionId
    workflow.status = 'interrupted'
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
    await this.checkpoint(workflow)
  }

  protected async issueRecoveryInterrupt(workflow: WorkflowRecord, exec: ToolRunContext): Promise<void> {
    const sessionId = workflow.ownerSessionId ?? ownerSessionId(exec.agent)
    if (!sessionId) throw new EvolutionError('invalid_input', 'Cannot issue recovery control without an owner session')
    const validAfterTurnId = this.requireHostTurnId(exec, 'issue a recovery interrupt')
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
      installationId: this.installationReceiptId(workflow) ?? null,
      lastFailure: workflow.lastFailure ?? null,
    })
  }

  /** The pending id is persisted before the external install starts. */
  protected installationReceiptId(workflow: WorkflowRecord): string | undefined {
    return workflow.lastInstallationId ?? workflow.pendingInstallationId
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
    signal?: AbortSignal,
  ): Promise<WorkflowView> {
    signal?.throwIfAborted()
    const current = resolution ?? (!extras.skipLinkedReads && workflow.resolutionId
      ? await this.readOptionalBeforeEffect(() => this.host.getResolution(workflow.resolutionId!), signal)
      : undefined)
    const review = workflow.lastReviewId
      ? await this.readOptionalBeforeEffect(() => this.host.getReview(workflow.lastReviewId!), signal)
      : undefined
    const reviews = await this.reviewsForWorkflow(workflow, signal)
    const installationId = this.installationReceiptId(workflow)
    const installation = installationId
      ? await this.readOptionalBeforeEffect(() => this.host.getInstallation(installationId), signal)
      : undefined
    const lifecycleState = lifecycleStateFor(workflow, installation ? { installation } : {})
    const result = JSON.parse(JSON.stringify({
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
    signal?.throwIfAborted()
    return result
  }

  protected async invalidResumeView(
    workflow: WorkflowRecord,
    resolution: ResolutionRecord | undefined,
    exec: ToolRunContext,
    input: ResumeInput,
    summary: string,
  ): Promise<WorkflowView> {
    exec.signal?.throwIfAborted()
    const hostTurnId = this.creationGuard.currentTurnId(exec.agent) ?? 'turn_unknown'
    const fingerprint = hashObject({ navigation: input.navigation, decision: input.decision })
    const prior = workflow.invalidResumeAttempt
    const repeated = prior?.hostTurnId === hostTurnId && prior.fingerprint === fingerprint
    workflow.invalidResumeAttempt = {
      hostTurnId,
      fingerprint,
      count: repeated ? Math.min(2, prior.count + 1) : 1,
    }
    exec.signal?.throwIfAborted()
    try {
      await this.checkpoint(workflow)
      exec.signal?.throwIfAborted()
    } catch (error) {
      if (exec.signal?.aborted) throw exec.signal.reason
      throw error
    }
    return await this.view(workflow, resolution, {
      status: 'invalid_resume',
      resumeHint: workflow.invalidResumeAttempt.count >= 2
        ? `Repeated invalid action is blocked until a fresh user turn. ${summary}`
        : summary,
    }, exec.signal)
  }
}
