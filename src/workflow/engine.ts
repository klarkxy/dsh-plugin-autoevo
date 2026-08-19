import { randomUUID } from 'node:crypto'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  BRIDGE_EXECUTION_TOOLS,
  FORGED_RESUME_HOST_KEYS,
  POLICY_VERSION,
  type ActionCommitment,
  type ExecutionEndpoint,
  type ExecutionLease,
  type NavigationInput,
  type ResolutionAuthorization,
  type ResolutionRecord,
  type ResumeInput,
  type ReviewRecord,
  type SelectionReceipt,
} from '../contracts.js'
import type { CreationGuard } from '../creation-guard.js'
import { EvolutionError } from '../errors.js'
import {
  newInterruptId,
  normalizeRequirement,
  ownerSessionId,
  sessionCwd,
} from '../host-identity.js'
import { assertOptionAllowed, nextStepForAuthorization, resolveDecisionFromModel, resolveDecisionTarget } from '../lifecycle/decide.js'
import {
  frozenManifestDigest,
  isDirectlyUsableReview,
  reviewCandidateDigest,
  reviewerBindingDigest,
  reviewSnapshotDigest,
} from '../review/direct-use.js'
import { needsSemanticReviewer } from '../review/review.js'
import { hashObject } from '../state/hashes.js'
import type { StateStore } from '../state/store.js'
import {
  INTERRUPT_NODES,
  TERMINAL_NODES,
  isInterruptKind,
  type CandidateSnapshotItem,
  type InterruptPayload,
  type ValidatedResume,
  type WorkflowExec,
  type WorkflowHost,
  type WorkflowRecord,
  type WorkflowView,
} from './contracts.js'
import { executeNode, interruptPayload, transition } from './graph.js'
import { lifecycleStateFor } from './lifecycle.js'

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new EvolutionError('command_failed', 'Workflow cancelled')
  }
}

const MIXED_SNAPSHOT_MAX = 5

function candidateId(kind: CandidateSnapshotItem['kind'], identity: string): string {
  return `candidate_${hashObject({ kind, identity: identity.toLowerCase() }).slice(0, 24)}`
}

function excludedCandidateIds(workflow?: Pick<WorkflowRecord, 'seenCandidateIds' | 'rejectedCandidateIds'>): Set<string> {
  return new Set([...(workflow?.seenCandidateIds ?? []), ...(workflow?.rejectedCandidateIds ?? [])])
}

function localSnapshotItem(item: ResolutionRecord['localCandidates'][number]): Omit<CandidateSnapshotItem, 'index'> {
  return {
    id: candidateId('local', item.name),
    kind: 'local',
    name: item.name,
    identity: item.name,
    localName: item.name,
    localKind: item.kind,
    availability: item.availability,
    ...(item.fit ? { fit: item.fit } : {}),
    digest: hashObject({
      kind: item.kind,
      name: item.name,
      description: item.description,
      availability: item.availability,
      fit: item.fit,
    }),
  }
}

function remoteSnapshotItem(item: ResolutionRecord['remoteCandidates'][number]): Omit<CandidateSnapshotItem, 'index'> {
  return {
    id: candidateId('remote', item.repository),
    kind: 'remote',
    name: item.name,
    identity: item.repository,
    repository: item.repository,
    digest: hashObject({
      repository: item.repository,
      name: item.name,
      description: item.description,
      stars: item.stars,
      updatedAt: item.updatedAt,
      defaultBranch: item.defaultBranch,
    }),
  }
}

function candidateSnapshotFor(
  resolution: ResolutionRecord,
  excludedIds: ReadonlySet<string> = new Set(),
): CandidateSnapshotItem[] {
  const locals = resolution.localCandidates
    .filter((item) => item.fit !== 'none')
    .map(localSnapshotItem)
    .filter((item) => !excludedIds.has(item.id))
  const remotes = resolution.remoteCandidates
    .map(remoteSnapshotItem)
    .filter((item) => !excludedIds.has(item.id))
  const picked: Array<Omit<CandidateSnapshotItem, 'index'>> = []

  if (locals.length > 0 && remotes.length > 0) {
    const fullLocals = locals.filter((item) => item.fit === 'full')
    const otherLocals = locals.filter((item) => item.fit !== 'full')
    for (const item of fullLocals) {
      if (picked.length >= MIXED_SNAPSHOT_MAX - 1) break
      picked.push(item)
    }
    if (picked.length === 0) picked.push(otherLocals[0] ?? locals[0]!)
    for (const item of remotes) {
      if (picked.length >= MIXED_SNAPSHOT_MAX) break
      picked.push(item)
    }
    for (const item of [...fullLocals, ...otherLocals, ...remotes]) {
      if (picked.length >= 3) break
      if (!picked.includes(item)) picked.push(item)
    }
  } else {
    picked.push(...(locals.length > 0 ? locals : remotes).slice(0, MIXED_SNAPSHOT_MAX))
  }

  return picked.map((item, offset) => ({ ...item, index: offset + 1 }))
}

function assertResumeDoesNotForgeHostFacts(input: ResumeInput): void {
  const record = input as unknown as Record<string, unknown>
  for (const key of FORGED_RESUME_HOST_KEYS) {
    if (record[key] !== undefined) {
      throw new EvolutionError('invalid_input', 'ResumeInput does not accept Host-owned selection, commitment, or lease fields', {
        key,
      })
    }
  }
}

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

function endpointForLocalReuse(candidate: CandidateSnapshotItem): ExecutionEndpoint {
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
  throw new EvolutionError('invalid_input', 'reuse_local cannot derive an exact endpoint from this snapshot candidate', {
    candidateId: candidate.id,
    availability: candidate.availability,
  })
}

function mintSelectionReceipt(input: {
  workflowId: string
  interrupt: InterruptPayload
  kind: SelectionReceipt['kind']
  candidateIds: string[]
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
      kind: input.kind,
      candidateIds: input.candidateIds,
      candidateDigests,
      hostTurnId: input.hostTurnId,
      createdAt,
    }).slice(0, 24)}`,
    workflowId: input.workflowId,
    interruptId: input.interrupt.interruptId,
    snapshotDigest: input.interrupt.snapshotDigest,
    kind: input.kind,
    candidateIds: input.candidateIds,
    candidateDigests,
    hostTurnId: input.hostTurnId,
    ownerSessionId: input.interrupt.ownerSessionId,
    bootId: input.interrupt.bootId,
    createdAt,
  }
}

function mintActionCommitment(input: {
  receipt: SelectionReceipt
  action: SelectionReceipt['kind']
  candidate?: CandidateSnapshotItem
  endpoint: ExecutionEndpoint
  retention?: ActionCommitment['retention']
  targetProfile?: string
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
      createdAt,
    }).slice(0, 24)}`,
    selectionReceiptId: input.receipt.id,
    snapshotDigest: input.receipt.snapshotDigest,
    ...(input.candidate ? { candidateId: input.candidate.id } : {}),
    ...(candidateDigest ? { candidateDigest } : {}),
    frozenIdentity: input.candidate ? frozenIdentityFor(input.candidate) : { kind: 'none' },
    requestedAction: input.action,
    ...(input.retention ? { retention: input.retention } : {}),
    ...(input.targetProfile ? { targetProfile: input.targetProfile } : {}),
    endpoint: input.endpoint,
    allowedParameterConstraints: input.endpoint.kind === 'bridge'
      ? { exactTarget: input.endpoint.target }
      : {},
    createdAt,
    ...(review ? { reviewId: review.id } : {}),
    ...(reviewSnapshot ? { reviewSnapshotDigest: reviewSnapshot } : {}),
    ...(reviewerRequestId ? { reviewerRequestId } : {}),
    ...(reviewerVerdictDigest ? { reviewerVerdictDigest } : {}),
    ...(manifestDigest ? { frozenManifestDigest: manifestDigest } : {}),
    ...(review ? { frozenInstallSpec: review.installSpec } : {}),
  }
}

function mintExecutionLease(input: {
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

function registerReviewedCandidate(workflow: WorkflowRecord, review: ReviewRecord): void {
  const snapshot = workflow.candidateSnapshot ?? []
  const source = review.sourceSnapshot
  let candidate = source.kind === 'github'
    ? snapshot.find((item) => item.repository?.toLowerCase() === source.repository.toLowerCase())
    : snapshot.find((item) => workflow.reviewIdsByCandidate?.[item.id] === review.id)

  if (!candidate && source.kind === 'local') {
    const identity = `${source.path}:${source.statusHash}`
    candidate = {
      id: candidateId('local', identity),
      index: snapshot.reduce((max, item) => Math.max(max, item.index), 0) + 1,
      kind: 'local',
      name: review.manifest.packageName ?? 'managed-plugin',
      identity,
      localName: review.manifest.packageName ?? source.path,
      fit: review.fit,
      digest: hashObject({
        reviewId: review.id,
        sourceSnapshot: source,
        installSpec: review.installSpec,
        recommendation: review.recommendation,
      }),
    }
    snapshot.push(candidate)
    workflow.candidateSnapshot = snapshot
  }
  if (!candidate) return

  workflow.reviewIdsByCandidate = {
    ...(workflow.reviewIdsByCandidate ?? {}),
    [candidate.id]: review.id,
  }
  workflow.reviewedCandidateIds = [...new Set([...(workflow.reviewedCandidateIds ?? []), candidate.id])]
}

function newWorkflowId(requirement: string): string {
  return `workflow_${hashObject({ requirement, at: new Date().toISOString(), nonce: randomUUID() }).slice(0, 24)}`
}

function snapshotDigestFor(
  kind: InterruptPayload['kind'],
  resolution: WorkflowView['resolution'],
  reviews: ReviewRecord[],
  workflow: WorkflowRecord,
): string {
  if (kind === 'await_confirmation') {
    return hashObject({
      kind,
      reviews: reviews.map((review) => ({
        reviewId: review.id,
        reviewIdentity: review.sourceSnapshot.kind === 'github'
          ? review.sourceSnapshot.commit
          : review.sourceSnapshot.statusHash,
        installSpec: review.installSpec,
        inspectedFiles: review.inspectedFiles,
        manifest: review.manifest,
      })),
      candidateSnapshot: workflow.candidateSnapshot,
      reviewedCandidateIds: workflow.reviewedCandidateIds,
    })
  }
  if (kind === 'await_modify_work') {
    const review = reviews[0]
    if (review) {
      return hashObject({
        kind,
        reviewId: review.id,
        reviewIdentity: review.sourceSnapshot.kind === 'github'
          ? review.sourceSnapshot.commit
          : review.sourceSnapshot.statusHash,
        path: workflow.pendingPath,
      })
    }
    if (!workflow.pendingPath) throw new EvolutionError('invalid_input', 'Create-work interrupt requires a managed source path snapshot')
    return hashObject({ kind, path: workflow.pendingPath, resolutionId: resolution?.id })
  }
  if (!resolution) throw new EvolutionError('invalid_input', 'Selection interrupt requires a resolution snapshot')
  return hashObject({
    kind,
    candidateSnapshot: workflow.candidateSnapshot,
    remoteDiscoveryComplete: resolution.remoteDiscoveryComplete,
    remoteCandidateSource: resolution.remoteCandidateSource,
  })
}

function isUnfinished(status: WorkflowRecord['status']): boolean {
  return status === 'interrupted' || status === 'running'
}

export class WorkflowEngine {
  private readonly inflight = new Set<string>()

  constructor(
    private readonly store: StateStore,
    private readonly creationGuard: CreationGuard,
    private readonly host: WorkflowHost,
  ) {}

  async start(requirement: string, exec: ToolRunContext): Promise<WorkflowView> {
    const normalized = normalizeRequirement(requirement)
    if (!normalized || normalized.length > 2_000) {
      throw new EvolutionError('invalid_input', 'requirement must contain 1 to 2000 characters')
    }
    const sessionId = ownerSessionId(exec.agent)
    if (!sessionId) {
      throw new EvolutionError('invalid_input', 'A live Agent session identity is required to start a workflow')
    }
    const cwd = sessionCwd(exec.agent)
    await this.invalidateStalePolicyWorkflows(sessionId, normalized, exec)
    const existing = await this.findReusableWorkflow(sessionId, cwd, normalized)
    if (existing) {
      return await this.withLock(existing.id, async () => {
        const latest = await this.store.getWorkflow(existing.id)
        if (latest.status === 'running') {
          if (latest.bootId === this.creationGuard.bootId) {
            throw new EvolutionError('invalid_input', 'This workflow is already running')
          }
          latest.bootId = this.creationGuard.bootId
          latest.cursor = 'recovery_required'
          latest.status = 'completed'
          latest.lastFailure = {
            code: 'service_restart_incomplete',
            message: 'The service restarted while this workflow was running. Side effects are not retried automatically; recovery is required.',
          }
          delete latest.interrupt
          this.clearWorkflowGrant(latest)
          this.creationGuard.invalidateExecutionLease(exec.agent)
          await this.host.releaseManagedSource?.(latest, exec as WorkflowExec).catch(() => undefined)
          await this.checkpoint(latest)
          const interruptedResolution = latest.resolutionId ? await this.host.getResolution(latest.resolutionId) : undefined
          return await this.view(latest, interruptedResolution)
        }
        if (latest.bootId !== this.creationGuard.bootId && latest.status === 'interrupted' && latest.interrupt) {
          this.creationGuard.invalidateExecutionLease(exec.agent)
          await this.reissueInterrupt(latest, exec)
        }
        let resolution = latest.resolutionId ? await this.host.getResolution(latest.resolutionId) : undefined
        return await this.view(latest, resolution)
      })
    }

    const now = new Date().toISOString()
    const workflow: WorkflowRecord = {
      schemaVersion: 2,
      id: newWorkflowId(requirement),
      policyVersion: POLICY_VERSION,
      createdAt: now,
      updatedAt: now,
      requirement,
      requirementNormalized: normalized,
      cwd,
      ownerSessionId: sessionId,
      bootId: this.creationGuard.bootId,
      status: 'running',
      cursor: 'resolve_local',
      generation: 1,
      consumedInterruptIds: [],
    }
    this.creationGuard.invalidateExecutionLease(exec.agent)
    const guardGeneration = this.creationGuard.beginResolution(exec.agent)
    return await this.withLock(workflow.id, () => this.runUntilPark(workflow, exec, guardGeneration))
  }

  async resume(input: ResumeInput, exec: ToolRunContext): Promise<WorkflowView> {
    return await this.withLock(input.workflowId, async () => {
      assertResumeDoesNotForgeHostFacts(input)
      const workflow = await this.store.getWorkflow(input.workflowId)
      if (workflow.policyVersion !== POLICY_VERSION) {
        await this.invalidateLegacyPolicyWorkflow(workflow, exec)
        const resolution = workflow.resolutionId
          ? await this.host.getResolution(workflow.resolutionId).catch(() => undefined)
          : undefined
        return await this.view(workflow, resolution)
      }
      if (workflow.status !== 'interrupted' || !workflow.interrupt || !INTERRUPT_NODES.has(workflow.cursor)) {
        throw new EvolutionError('invalid_input', 'This workflow is not waiting for a user decision', {
          status: workflow.status,
          cursor: workflow.cursor,
        })
      }
      if (workflow.consumedInterruptIds?.includes(input.interruptId)) {
        throw new EvolutionError('invalid_input', 'This interrupt_id was already consumed (replay rejected)', {
          interruptId: input.interruptId,
        })
      }
      if (workflow.interrupt.interruptId !== input.interruptId) {
        throw new EvolutionError('invalid_input', 'interrupt_id does not match the current workflow interrupt', {
          expected: workflow.interrupt.interruptId,
          actual: input.interruptId,
        })
      }

      const sessionId = ownerSessionId(exec.agent)
      if (!sessionId || sessionId !== workflow.ownerSessionId || sessionId !== workflow.interrupt.ownerSessionId) {
        throw new EvolutionError('invalid_input', 'Workflow interrupt belongs to a different owner session', {
          expected: workflow.ownerSessionId,
          actual: sessionId,
        })
      }
      if (workflow.interrupt.bootId !== this.creationGuard.bootId || workflow.bootId !== this.creationGuard.bootId) {
        await this.reissueInterrupt(workflow, exec)
        throw new EvolutionError('invalid_input', 'Workflow interrupt was invalidated by a service restart; present the reissued interrupt and obtain a fresh user confirmation', {
          workflowId: workflow.id,
          interruptId: workflow.interrupt?.interruptId,
        })
      }
      if (!workflow.resolutionId) {
        throw new EvolutionError('invalid_input', 'This workflow has no resolution to resume')
      }
      const resolution = await this.host.getResolution(workflow.resolutionId)
      const reviews = await this.reviewsForWorkflow(workflow)
      const expectedDigest = snapshotDigestFor(workflow.interrupt.kind, resolution, reviews, workflow)
      if (expectedDigest !== workflow.interrupt.snapshotDigest) {
        throw new EvolutionError('invalid_input', 'Interrupt candidate/review snapshot digest mismatch', {
          expected: expectedDigest,
          actual: workflow.interrupt.snapshotDigest,
        })
      }

      if (input.navigation && input.decision) {
        throw new EvolutionError('invalid_input', 'Provide either navigation or decision, not both')
      }
      if (input.navigation) {
        return await this.resumeNavigation(workflow, resolution, input.navigation, input.interruptId, exec)
      }
      if (workflow.cursor !== 'await_confirmation') {
        throw new EvolutionError(
          'invalid_input',
          'This interrupt accepts read-only navigation; provide navigation instead of an authorization attempt',
          { cursor: workflow.cursor },
        )
      }
      if (!input.decision) {
        throw new EvolutionError(
          'invalid_input',
          'Final confirmation requires a model-interpreted decision bound to the fresh user turn',
        )
      }
      resolveDecisionTarget(input.decision, workflow.interrupt)
      const decisionReview = input.decision.action === 'use_this' || input.decision.action === 'modify_this'
        ? await this.reviewForAuthorization(workflow, reviews, input.decision.candidateId)
        : undefined
      const resume = resolveDecisionFromModel({
        guard: this.creationGuard,
        agent: exec.agent,
        interrupt: workflow.interrupt,
        decision: input.decision,
        requirement: workflow.requirement,
        ...(decisionReview ? { reviewId: decisionReview.id } : {}),
      })

      const latest = await this.store.getWorkflow(workflow.id)
      if (latest.generation !== workflow.generation || latest.status !== 'interrupted') {
        throw new EvolutionError('invalid_input', 'This workflow is already running or has moved on')
      }
      latest.generation += 1
      latest.status = 'running'
      delete latest.lastFailure
      latest.consumedInterruptIds = [...(latest.consumedInterruptIds ?? []), input.interruptId]
      latest.pendingRepositories = resume.repositories
      if (resume.ref) latest.pendingRef = resume.ref
      else delete latest.pendingRef
      if (resume.path) latest.pendingPath = resume.path
      else delete latest.pendingPath
      if (resume.install) latest.pendingInstall = resume.install
      else delete latest.pendingInstall
      const nextResolution = await this.host.applyDecision(resolution, resume, decisionReview, latest)
      if (decisionReview) {
        // Downstream graph nodes consume lastReviewId; pin it to the exact
        // candidate selected by the model instead of the review display order.
        latest.lastReviewId = decisionReview.id
      }
      if (resume.optionId === 'modify_this' && decisionReview) {
        latest.lineageTipReviewId = decisionReview.id
      }
      latest.cursor = transition(latest.cursor, resume.optionId)
      const consumedInterrupt = workflow.interrupt
      delete latest.interrupt
      this.grantFinalDecision({
        workflow: latest,
        interrupt: consumedInterrupt,
        resume,
        ...(decisionReview ? { review: decisionReview } : {}),
        exec,
      })
      return await this.runUntilPark(latest, exec, undefined, nextResolution)
    })
  }

  private async resumeNavigation(
    workflow: WorkflowRecord,
    resolution: ResolutionRecord,
    navigation: NavigationInput,
    interruptId: string,
    exec: ToolRunContext,
  ): Promise<WorkflowView> {
    const latest = await this.store.getWorkflow(workflow.id)
    if (latest.generation !== workflow.generation || latest.status !== 'interrupted') {
      throw new EvolutionError('invalid_input', 'This workflow is already running or has moved on')
    }
    const interrupt = workflow.interrupt
    if (!interrupt) {
      throw new EvolutionError('invalid_input', 'This workflow is not waiting for a user decision')
    }
    const snapshot = latest.candidateSnapshot ?? []
    const requestedIds = [...new Set(navigation.candidateIds ?? [])]
    for (const id of requestedIds) {
      if (!snapshot.some((item) => item.id === id)) {
        throw new EvolutionError('invalid_input', 'Navigation candidate is outside the current candidate snapshot', {
          candidateId: id,
        })
      }
    }
    assertOptionAllowed(interrupt, navigation.kind)

    let repositories: string[] = []
    let pendingReviewIds: string[] = []
    let reuseCandidate: CandidateSnapshotItem | undefined
    if (navigation.kind === 'review_candidates') {
      if (requestedIds.length < 1 || requestedIds.length > 3) {
        throw new EvolutionError('invalid_input', 'review_candidates requires one to three candidate_ids')
      }
      const selected = snapshot
        .filter((item) => requestedIds.includes(item.id))
        .sort((left, right) => left.index - right.index)
      if (selected.some((item) => item.kind !== 'remote' || !item.repository)) {
        throw new EvolutionError('invalid_input', 'review_candidates accepts remote candidates only')
      }
      const alreadyReviewed = new Set(latest.reviewedCandidateIds ?? [])
      const pending = selected.filter((item) => !alreadyReviewed.has(item.id))
      if (pending.length === 0) {
        throw new EvolutionError('invalid_input', 'Every selected candidate was already reviewed')
      }
      repositories = pending.map((item) => item.repository!)
      pendingReviewIds = pending.map((item) => item.id)
    } else if (navigation.kind === 'reuse_local') {
      if (requestedIds.length !== 1) {
        throw new EvolutionError('invalid_input', 'reuse_local requires exactly one candidate_id')
      }
      const candidate = snapshot.find((item) => item.id === requestedIds[0])
      if (!candidate || candidate.kind !== 'local' || candidate.fit !== 'full') {
        throw new EvolutionError('invalid_input', 'reuse_local requires a full local candidate from this snapshot')
      }
      reuseCandidate = candidate
    }

    const turn = this.creationGuard.consumeDecisionTurn(exec.agent, interrupt)
    const receiptCandidateIds = navigation.kind === 'search_more'
      ? []
      : navigation.kind === 'stop'
        ? []
        : requestedIds
    const receipt = mintSelectionReceipt({
      workflowId: latest.id,
      interrupt,
      kind: navigation.kind,
      candidateIds: receiptCandidateIds,
      snapshot,
      hostTurnId: turn.turnId,
    })

    latest.generation += 1
    latest.status = 'running'
    latest.consumedInterruptIds = [...(latest.consumedInterruptIds ?? []), interruptId]
    delete latest.interrupt
    delete latest.lastFailure

    if (navigation.kind === 'review_candidates') {
      this.creationGuard.invalidateExecutionLease(exec.agent)
      latest.selectionReceipt = receipt
      latest.actionCommitment = mintActionCommitment({
        receipt,
        action: 'review_candidates',
        endpoint: { kind: 'none' },
      })
      delete latest.executionLease
      latest.reviewPlan = {
        mode: navigation.reviewMode ?? 'fixed',
        candidateIds: pendingReviewIds,
        maxReviews: Math.min(3, pendingReviewIds.length) as 1 | 2 | 3,
      }
      latest.reviewQueue = [...latest.reviewPlan.candidateIds]
      latest.pendingRepositories = repositories
      latest.cursor = 'review_github'
    } else if (navigation.kind === 'search_more') {
      this.creationGuard.invalidateExecutionLease(exec.agent)
      const currentIds = snapshot.map((item) => item.id)
      latest.seenCandidateIds = [...new Set([...(latest.seenCandidateIds ?? []), ...currentIds])]
      latest.rejectedCandidateIds = [...new Set([...(latest.rejectedCandidateIds ?? []), ...currentIds])]
      latest.forceRemoteDiscovery = true
      this.clearWorkflowGrant(latest)
      delete latest.candidateSnapshot
      delete latest.reviewPlan
      delete latest.reviewQueue
      delete latest.pendingRepositories
      latest.cursor = 'discover_remote'
    } else if (navigation.kind === 'reuse_local') {
      const candidate = reuseCandidate!
      const endpoint = endpointForLocalReuse(candidate)
      const commitment = mintActionCommitment({
        receipt,
        action: 'reuse_local',
        candidate,
        endpoint,
      })
      const lease = mintExecutionLease({ receipt, commitment })
      this.creationGuard.grantHostSelection(exec.agent, receipt, commitment, lease)
      latest.selectionReceipt = receipt
      latest.actionCommitment = commitment
      latest.executionLease = lease
      latest.cursor = 'reuse_local'
    } else {
      this.creationGuard.invalidateExecutionLease(exec.agent)
      latest.selectionReceipt = receipt
      latest.actionCommitment = mintActionCommitment({
        receipt,
        action: 'stop',
        endpoint: { kind: 'none' },
      })
      delete latest.executionLease
      latest.cursor = 'stopped'
    }

    if (!this.host.applyNavigation) {
      throw new EvolutionError('invalid_input', 'This workflow host does not support read-only navigation')
    }
    const nextResolution = await this.host.applyNavigation(resolution, navigation, repositories)
    return await this.runUntilPark(latest, exec, undefined, nextResolution)
  }

  private grantFinalDecision(input: {
    workflow: WorkflowRecord
    interrupt: InterruptPayload | undefined
    resume: ValidatedResume
    review?: ReviewRecord
    exec: ToolRunContext
  }): void {
    const interrupt = input.interrupt
    if (!interrupt) {
      throw new EvolutionError('invalid_input', 'Final decision requires the consumed interrupt')
    }
    const snapshot = input.workflow.candidateSnapshot ?? []
    const needsCandidate = input.resume.optionId === 'use_this' || input.resume.optionId === 'modify_this'
    const candidate = input.resume.candidateId
      ? snapshot.find((item) => item.id === input.resume.candidateId)
      : undefined
    if (needsCandidate && !candidate) {
      throw new EvolutionError('invalid_input', 'Final use/modify commitment requires the interrupt-bound candidate', {
        candidateId: input.resume.candidateId,
      })
    }
    if (needsCandidate && !input.review) {
      throw new EvolutionError('invalid_input', 'Final use/modify commitment requires the selected review', {
        candidateId: input.resume.candidateId,
      })
    }
    const receipt = mintSelectionReceipt({
      workflowId: input.workflow.id,
      interrupt,
      kind: input.resume.optionId,
      candidateIds: candidate ? [candidate.id] : [],
      snapshot,
      hostTurnId: input.resume.hostTurnId,
    })
    const commitment = mintActionCommitment({
      receipt,
      action: input.resume.optionId,
      ...(candidate ? { candidate } : {}),
      endpoint: { kind: 'none' },
      ...(input.resume.optionId === 'use_this' && input.resume.install?.retention
        ? { retention: input.resume.install.retention }
        : {}),
      ...(input.resume.optionId === 'use_this' && input.resume.install?.targetProfile
        ? { targetProfile: input.resume.install.targetProfile }
        : {}),
      ...(needsCandidate && input.review ? { review: input.review } : {}),
      workflow: input.workflow,
    })
    input.workflow.selectionReceipt = receipt
    input.workflow.actionCommitment = commitment
    delete input.workflow.executionLease
    this.creationGuard.grantHostSelection(input.exec.agent, receipt, commitment)
  }

  private clearWorkflowGrant(workflow: WorkflowRecord): void {
    delete workflow.selectionReceipt
    delete workflow.actionCommitment
    delete workflow.executionLease
  }

  private settleTerminalGrant(workflow: WorkflowRecord, exec: ToolRunContext): void {
    if (workflow.cursor === 'reuse_local') return
    if (workflow.cursor === 'stopped') {
      delete workflow.executionLease
      this.creationGuard.invalidateExecutionLease(exec.agent)
      return
    }
    this.clearWorkflowGrant(workflow)
    this.creationGuard.invalidateExecutionLease(exec.agent)
  }

  private async reviewsForWorkflow(workflow: WorkflowRecord): Promise<ReviewRecord[]> {
    const ids = [...new Set([
      ...Object.values(workflow.reviewIdsByCandidate ?? {}),
      ...(workflow.lastReviewId ? [workflow.lastReviewId] : []),
    ])]
    const reviews: ReviewRecord[] = []
    for (const id of ids) reviews.push(await this.host.getReview(id))
    return reviews.sort((left, right) => {
      const rank = (review: ReviewRecord): number => {
        if (isDirectlyUsableReview(review, workflow)) return 0
        if (review.recommendation === 'modify' || review.fit !== 'none') return 1
        return 2
      }
      return rank(left) - rank(right) || left.createdAt.localeCompare(right.createdAt)
    })
  }

  private async reviewForAuthorization(
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

  private async findReusableWorkflow(
    sessionId: string,
    cwd: string,
    requirementNormalized: string,
  ): Promise<WorkflowRecord | undefined> {
    const workflows = await this.store.listWorkflows()
    const matches = workflows
      .filter((item) => isUnfinished(item.status)
        && item.ownerSessionId === sessionId
        && item.cwd === cwd
        && item.requirementNormalized === requirementNormalized
        && item.policyVersion === POLICY_VERSION)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    return matches[0]
  }

  private async invalidateStalePolicyWorkflows(
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

  private async invalidateLegacyPolicyWorkflow(
    workflow: WorkflowRecord,
    exec: ToolRunContext,
  ): Promise<void> {
    delete workflow.interrupt
    this.clearWorkflowGrant(workflow)
    this.creationGuard.invalidateExecutionLease(exec.agent)
    await this.host.releaseManagedSource?.(workflow, exec as WorkflowExec).catch(() => undefined)
    workflow.status = 'completed'
    workflow.lastFailure = {
      code: 'policy_restart_required',
      message: 'This workflow predates Policy V5. Call capability_workflow again to start a fresh discovery. Previous interrupts, decisions, receipts, verdicts, commitments, and leases are not executable.',
    }
    await this.checkpoint(workflow)
  }

  private async reissueInterrupt(workflow: WorkflowRecord, exec: ToolRunContext): Promise<void> {
    this.creationGuard.invalidateExecutionLease(exec.agent)
    if (!workflow.resolutionId || !INTERRUPT_NODES.has(workflow.cursor)) return
    const resolution = await this.host.getResolution(workflow.resolutionId)
    if (!workflow.candidateSnapshot) {
      workflow.candidateSnapshot = candidateSnapshotFor(resolution, excludedCandidateIds(workflow))
    }
    const reviews = await this.reviewsForWorkflow(workflow)
    const installProfiles = workflow.cursor === 'await_confirmation'
      ? await this.host.listInstallProfiles?.() ?? []
      : []
    const base = interruptPayload(workflow.cursor, resolution, reviews, {
      ...(workflow.lastFailure ? { lastFailure: workflow.lastFailure } : {}),
      ...(installProfiles.length > 0 ? { installProfiles } : {}),
      ...(workflow.pendingPath ? { pendingPath: workflow.pendingPath } : {}),
      workflow,
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

  private async withLock<T>(id: string, run: () => Promise<T>): Promise<T> {
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

  private async runUntilPark(
    workflow: WorkflowRecord,
    exec: ToolRunContext,
    guardGeneration?: number,
    resolution?: WorkflowView['resolution'],
  ): Promise<WorkflowView> {
    if (!resolution && workflow.resolutionId) {
      resolution = await this.host.getResolution(workflow.resolutionId)
    }
    try {
      while (true) {
        throwIfAborted(exec.signal)
        await this.checkpoint(workflow)
        this.syncGuard(workflow, exec, guardGeneration, resolution)

        if (INTERRUPT_NODES.has(workflow.cursor)) {
          if (!resolution && workflow.resolutionId) {
            resolution = await this.host.getResolution(workflow.resolutionId)
          }
          if (!resolution) {
            throw new EvolutionError('invalid_input', 'Workflow interrupt is missing a resolution')
          }
          if (!workflow.candidateSnapshot) {
            workflow.candidateSnapshot = candidateSnapshotFor(resolution, excludedCandidateIds(workflow))
          }
          if (workflow.cursor === 'await_selection' || workflow.cursor === 'await_confirmation') {
            this.creationGuard.invalidateExecutionLease(exec.agent)
            if (workflow.actionCommitment?.requestedAction === 'use_this') {
              this.clearWorkflowGrant(workflow)
            }
          }
          const reviews = await this.reviewsForWorkflow(workflow)
          workflow.status = 'interrupted'
          const installProfiles = workflow.cursor === 'await_confirmation'
            ? await this.host.listInstallProfiles?.() ?? []
            : []
          const base = interruptPayload(workflow.cursor, resolution, reviews, {
            ...(workflow.lastFailure ? { lastFailure: workflow.lastFailure } : {}),
            ...(installProfiles.length > 0 ? { installProfiles } : {}),
            ...(workflow.pendingPath ? { pendingPath: workflow.pendingPath } : {}),
            workflow,
          })
          const sessionId = workflow.ownerSessionId ?? ownerSessionId(exec.agent)
          if (!sessionId) {
            throw new EvolutionError('invalid_input', 'Cannot issue interrupt without an owner session')
          }
          const validAfterTurnId = this.creationGuard.currentTurnId(exec.agent) ?? `turn_${'0'.repeat(24)}`
          const snapshotDigest = snapshotDigestFor(base.kind, resolution, reviews, workflow)
          workflow.bootId = this.creationGuard.bootId
          workflow.ownerSessionId = sessionId
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
          this.syncGuard(workflow, exec, guardGeneration, resolution)
          return await this.view(workflow, resolution)
        }

        if (TERMINAL_NODES.has(workflow.cursor)) {
          this.settleTerminalGrant(workflow, exec)
          await this.host.releaseManagedSource?.(workflow, exec as WorkflowExec)
          workflow.status = 'completed'
          delete workflow.interrupt
          await this.checkpoint(workflow)
          this.syncGuard(workflow, exec, guardGeneration, resolution)
          return await this.view(workflow, resolution)
        }

        workflow.status = 'running'
        const result = await executeNode(workflow.cursor, {
          host: this.host,
          workflow,
          exec: exec as WorkflowExec,
          ...(resolution ? { resolution } : {}),
        })
        if (result.resolution) resolution = result.resolution
        if (result.node === 'await_selection' && result.resolution) {
          workflow.candidateSnapshot = candidateSnapshotFor(result.resolution, excludedCandidateIds(workflow))
        }
        if (result.review) {
          workflow.lastReviewId = result.review.id
          workflow.lineageTipReviewId = result.review.id
          registerReviewedCandidate(workflow, result.review)
        }
        if (result.reviews) {
          for (const review of result.reviews) {
            registerReviewedCandidate(workflow, review)
          }
          const reviewed = new Set(workflow.reviewedCandidateIds ?? [])
          workflow.reviewQueue = (workflow.reviewQueue ?? []).filter((id) => !reviewed.has(id))
          const first = result.reviews[0]
          if (first) workflow.lastReviewId = first.id
        }
        if (result.reviewFailures) {
          workflow.reviewFailures = result.reviewFailures.map((failure) => ({
            candidateId: workflow.candidateSnapshot?.find((item) => item.repository?.toLowerCase()
              === failure.repository.toLowerCase())?.id ?? candidateId('remote', failure.repository),
            code: failure.code,
            message: failure.message,
          }))
        }
        if (result.installation) workflow.lastInstallationId = result.installation.id
        if (result.kind === 'next') {
          workflow.cursor = result.node
          continue
        }
        workflow.cursor = result.node
        this.settleTerminalGrant(workflow, exec)
        await this.host.releaseManagedSource?.(workflow, exec as WorkflowExec)
        workflow.status = 'completed'
        delete workflow.interrupt
        await this.checkpoint(workflow)
        this.syncGuard(workflow, exec, guardGeneration, resolution)
        return await this.view(workflow, resolution)
      }
    } catch (error) {
      this.creationGuard.invalidateExecutionLease(exec.agent)
      await this.host.releaseManagedSource?.(workflow, exec as WorkflowExec).catch(() => undefined)
      workflow.status = 'failed'
      workflow.error = {
        code: error instanceof EvolutionError ? error.code : 'command_failed',
        message: error instanceof Error ? error.message : String(error),
      }
      await this.checkpoint(workflow).catch(() => undefined)
      throw error
    }
  }

  private async checkpoint(workflow: WorkflowRecord): Promise<void> {
    workflow.updatedAt = new Date().toISOString()
    await this.store.put('workflows', workflow)
  }

  private syncGuard(
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
    this.creationGuard.setWaiting(exec.agent, isInterruptKind(workflow.cursor) ? workflow.cursor : undefined)
  }

  private async view(workflow: WorkflowRecord, resolution?: WorkflowView['resolution']): Promise<WorkflowView> {
    const current = resolution ?? (workflow.resolutionId ? await this.host.getResolution(workflow.resolutionId) : undefined)
    const review = workflow.lastReviewId ? await this.host.getReview(workflow.lastReviewId) : undefined
    const reviews = await this.reviewsForWorkflow(workflow)
    const installation = workflow.lastInstallationId
      ? await this.host.getInstallation(workflow.lastInstallationId)
      : undefined
    const baseNextStep = current?.authorization
      ? nextStepForAuthorization(workflow.requirement, current.authorization)
      : current?.nextStep
    const policyRestart = workflow.lastFailure?.code === 'policy_restart_required'
    const nextStep = policyRestart
      ? workflow.lastFailure?.message
      : workflow.lastFailure
        ? [baseNextStep, `Previous install failed (${workflow.lastFailure.code}): ${workflow.lastFailure.message}`]
          .filter(Boolean)
          .join(' ')
        : baseNextStep
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
      ...(nextStep ? { nextStep } : {}),
    })) as WorkflowView
  }
}
