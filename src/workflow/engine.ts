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
import { assertOptionAllowed, resolveDecisionFromModel, resolveDecisionTarget } from '../lifecycle/decide.js'
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
  COMPLETED_CLEANUP_NODES,
  INSTALL_SUCCESS_OUTCOMES,
  INTERRUPT_NODES,
  MODEL_CONTROL_NODES,
  TERMINAL_NODES,
  isInterruptKind,
  type CandidateSnapshotItem,
  type DiagnosticFact,
  type DiscoveryPresentInput,
  type DiscoveryRefineInput,
  type InterruptPayload,
  type ValidatedResume,
  type WorkflowExec,
  type WorkflowHost,
  type WorkflowRecord,
  type WorkflowRecoveryInput,
  type WorkflowDiagnoseInput,
  type WorkflowDiagnosis,
  type WorkflowView,
  type WorkflowViewStatus,
} from './contracts.js'
import { retryableResumeHint } from './agent-view.js'
import { executeNode, interruptPayload, transition } from './graph.js'
import { lifecycleStateFor } from './lifecycle.js'
import { boundedAgentText as boundedDiagnosticText } from './sanitize.js'

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new EvolutionError('command_failed', 'Workflow cancelled')
  }
}

/** At await_selection, use_this/modify_this means "review this", not install. */
function selectionNavigationFromMisplacedDecision(
  workflow: WorkflowRecord,
  decision: ResumeInput['decision'],
): NavigationInput | undefined {
  if (workflow.cursor !== 'await_selection' || !decision) return undefined
  if (decision.action === 'stop') return { kind: 'stop' }
  if (decision.action !== 'use_this' && decision.action !== 'modify_this') return undefined
  const candidateId = decision.candidateId
  if (!candidateId) return undefined
  const item = (workflow.candidateSnapshot ?? []).find((entry) => entry.id === candidateId)
  if (decision.action === 'use_this' && item?.kind === 'local' && item.fit === 'full') {
    return { kind: 'reuse_local', candidateIds: [candidateId] }
  }
  if (!item || item.kind !== 'remote') return undefined
  return { kind: 'review_candidates', candidateIds: [candidateId] }
}

const MIXED_SNAPSHOT_MAX = 8
const DISCOVERY_POOL_MAX = 20
const SEALED_SHORTLIST_MAX = 5

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
    ...(item.profileEvidence ? { installation: {
      source: item.profileEvidence.source,
      profile: item.profileEvidence.profile,
      package_name: item.profileEvidence.packageName,
      dependency_spec: item.profileEvidence.dependencySpec,
      configured_bundle: item.profileEvidence.configuredBundle,
    } } : {}),
    digest: hashObject({
      kind: item.kind,
      name: item.name,
      description: item.description,
      availability: item.availability,
      fit: item.fit,
      profileEvidence: item.profileEvidence,
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
  limit = MIXED_SNAPSHOT_MAX,
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
      if (picked.length >= limit - 1) break
      picked.push(item)
    }
    if (picked.length === 0) picked.push(otherLocals[0] ?? locals[0]!)
    for (const item of remotes) {
      if (picked.length >= limit) break
      picked.push(item)
    }
    for (const item of [...fullLocals, ...otherLocals, ...remotes]) {
      if (picked.length >= limit) break
      if (!picked.includes(item)) picked.push(item)
    }
  } else {
    picked.push(...(locals.length > 0 ? locals : remotes).slice(0, limit))
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
  if (candidate.availability === 'installed_in_profile') return { kind: 'none' }
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

function discoveryBudget(): NonNullable<WorkflowRecord['discoveryBudget']> {
  return {
    refinementRoundsUsed: 0,
    refinementQueriesUsed: [],
    explicitRepositories: [],
    maxRefinementRounds: 2,
    maxRefinementQueries: 5,
    maxCandidates: 20,
  }
}

function normalizeRefinementQuery(value: string): string {
  return value.normalize('NFKC').replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 120)
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
          latest.status = 'interrupted'
          latest.lastFailure = {
            stage: 'workflow',
            code: 'service_restart_incomplete',
            message: 'The service restarted while this workflow was running. Side effects are not retried automatically; recovery is required.',
            retryable: false,
          }
          delete latest.interrupt
          this.clearWorkflowGrant(latest)
          this.creationGuard.invalidateExecutionLease(exec.agent)
          await this.host.releaseManagedSource?.(latest, exec as WorkflowExec).catch(() => undefined)
          await this.issueRecoveryInterrupt(latest, exec)
          this.syncGuard(latest, exec, undefined)
          const interruptedResolution = latest.resolutionId ? await this.host.getResolution(latest.resolutionId) : undefined
          return await this.view(latest, interruptedResolution, { status: 'parked', alreadyWaiting: true })
        }
        if (latest.bootId !== this.creationGuard.bootId && latest.status === 'interrupted' && latest.interrupt) {
          this.creationGuard.invalidateExecutionLease(exec.agent)
          await this.reissueInterrupt(latest, exec)
        }
        let resolution = latest.resolutionId ? await this.host.getResolution(latest.resolutionId) : undefined
        return await this.view(latest, resolution)
      })
    }

    return await this.startFresh(requirement, normalized, sessionId, cwd, exec)
  }

  private async startFresh(
    requirement: string,
    normalized: string,
    sessionId: string,
    cwd: string,
    exec: ToolRunContext,
    recoveredFromWorkflowId?: string,
    workflowId = newWorkflowId(requirement),
  ): Promise<WorkflowView> {
    const now = new Date().toISOString()
    const workflow: WorkflowRecord = {
      schemaVersion: 2,
      id: workflowId,
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
      ...(recoveredFromWorkflowId ? { recoveredFromWorkflowId } : {}),
    }
    this.creationGuard.invalidateExecutionLease(exec.agent)
    const guardGeneration = this.creationGuard.beginResolution(exec.agent)
    return await this.withLock(workflow.id, () => this.runUntilPark(workflow, exec, guardGeneration))
  }

  async recover(input: WorkflowRecoveryInput, exec: ToolRunContext): Promise<WorkflowView> {
    let restart: { requirement: string; normalized: string; sessionId: string; cwd: string; oldWorkflowId: string; workflowId: string } | undefined
    const lockedView = await this.withLock(input.workflowId, async () => {
      const workflow = await this.store.getWorkflow(input.workflowId)
      this.assertOwner(workflow, exec)
      if (this.isSealedRecovery(workflow)) {
        return await this.recoverSealedInterrupt(workflow, input, exec, (next) => { restart = next })
      }
      if (this.isCompletedCleanup(workflow)) {
        return await this.recoverCompletedInstallation(workflow, input, exec, (next) => { restart = next })
      }
      throw new EvolutionError('invalid_input', 'Workflow is not waiting for a recovery decision')
    })
    if (!restart) return lockedView
    return await this.startFresh(
      restart.requirement,
      restart.normalized,
      restart.sessionId,
      restart.cwd,
      exec,
      restart.oldWorkflowId,
      restart.workflowId,
    )
  }

  private isSealedRecovery(workflow: WorkflowRecord): boolean {
    return workflow.cursor === 'recovery_required'
      && workflow.status === 'interrupted'
      && workflow.interrupt?.kind === 'await_recovery'
  }

  private isCompletedCleanup(workflow: WorkflowRecord): boolean {
    return workflow.status === 'completed'
      && COMPLETED_CLEANUP_NODES.has(workflow.cursor)
      && !workflow.recovery
  }

  private async recoverSealedInterrupt(
    workflow: WorkflowRecord,
    input: WorkflowRecoveryInput,
    exec: ToolRunContext,
    setRestart: (restart: {
      requirement: string
      normalized: string
      sessionId: string
      cwd: string
      oldWorkflowId: string
      workflowId: string
    }) => void,
  ): Promise<WorkflowView> {
    const interrupt = workflow.interrupt
    if (!interrupt || interrupt.kind !== 'await_recovery') {
      throw new EvolutionError('invalid_input', 'Workflow is not waiting for a recovery decision')
    }
    if (!input.interruptId || interrupt.interruptId !== input.interruptId) {
      throw new EvolutionError('invalid_input', 'interrupt_id does not match the current recovery interrupt')
    }
    const expectedRecoveryDigest = this.recoverySnapshotDigest(workflow)
    if (interrupt.snapshotDigest !== expectedRecoveryDigest) {
      throw new EvolutionError('invalid_input', 'Recovery control no longer matches the sealed workflow state; no cleanup was attempted')
    }
    if (interrupt.bootId !== this.creationGuard.bootId || workflow.bootId !== this.creationGuard.bootId) {
      await this.reissueInterrupt(workflow, exec)
      throw new EvolutionError('invalid_input', 'Recovery interrupt was invalidated by a service restart; present the reissued recovery choice and obtain a fresh user confirmation', {
        workflowId: workflow.id,
        interruptId: workflow.interrupt?.interruptId,
      })
    }
    if (this.creationGuard.isAwaitingFreshUserTurn(exec.agent, interrupt)) {
      return await this.view(workflow, undefined, { status: 'parked', alreadyWaiting: true })
    }
    this.creationGuard.previewDecisionTurn(exec.agent, interrupt)
    const linkedInstallation = workflow.lastInstallationId
      ? await this.host.getInstallation(workflow.lastInstallationId)
      : undefined
    if (linkedInstallation?.workflowId !== workflow.id) {
      throw new EvolutionError('invalid_input', 'Linked installation is not owned by this recovery workflow; no cleanup was attempted')
    }
    if (linkedInstallation && !linkedInstallation.removed && !this.host.cleanupInstallation) {
      throw new EvolutionError('invalid_input', 'This workflow host does not support owned installation cleanup')
    }
    const turn = this.creationGuard.consumeDecisionTurn(exec.agent, interrupt)
    const { cleanup, restartRequired } = await this.cleanupOwnedInstallation(workflow, linkedInstallation, exec)
    return await this.finishCleanupAndRestart(workflow, exec, {
      hostTurnId: turn.turnId,
      cleanup,
      restartRequired,
      consumeInterruptId: interrupt.interruptId,
    }, setRestart)
  }

  private async recoverCompletedInstallation(
    workflow: WorkflowRecord,
    input: WorkflowRecoveryInput,
    exec: ToolRunContext,
    setRestart: (restart: {
      requirement: string
      normalized: string
      sessionId: string
      cwd: string
      oldWorkflowId: string
      workflowId: string
    }) => void,
  ): Promise<WorkflowView> {
    if (input.interruptId) {
      throw new EvolutionError(
        'invalid_input',
        'Completed-install restart is driven by a fresh explicit user request; omit interrupt_id and do not reuse a recovery interrupt',
      )
    }
    const turnId = this.creationGuard.currentTurnId(exec.agent)
    if (!turnId || turnId === workflow.completionTurnId) {
      return await this.view(workflow, undefined, { status: 'parked', alreadyWaiting: true })
    }
    if (!workflow.lastInstallationId) {
      throw new EvolutionError('invalid_input', 'Completed-install restart requires the workflow-linked installation receipt; no cleanup was attempted')
    }
    const linkedInstallation = await this.requireOwnedLinkedInstallation(workflow)
    if (!linkedInstallation) {
      throw new EvolutionError('invalid_input', 'Completed-install restart requires the workflow-linked installation receipt; no cleanup was attempted')
    }
    if (!(INSTALL_SUCCESS_OUTCOMES as readonly string[]).includes(linkedInstallation.installOutcome ?? '')) {
      throw new EvolutionError('invalid_input', 'Completed-install restart requires an unreplaced success receipt; no cleanup was attempted')
    }
    if (!linkedInstallation.removed && !this.host.cleanupInstallation) {
      throw new EvolutionError('invalid_input', 'This workflow host does not support owned installation cleanup')
    }
    const { cleanup, restartRequired } = await this.cleanupOwnedInstallation(workflow, linkedInstallation, exec)
    return await this.finishCleanupAndRestart(workflow, exec, {
      hostTurnId: turnId,
      cleanup,
      restartRequired,
    }, setRestart)
  }

  private async requireOwnedLinkedInstallation(workflow: WorkflowRecord) {
    if (!workflow.lastInstallationId) return undefined
    const linkedInstallation = await this.host.getInstallation(workflow.lastInstallationId)
    if (linkedInstallation.workflowId !== workflow.id || linkedInstallation.id !== workflow.lastInstallationId) {
      throw new EvolutionError('invalid_input', 'Linked installation is not owned by this recovery workflow; no cleanup was attempted')
    }
    return linkedInstallation
  }

  private async cleanupOwnedInstallation(
    workflow: WorkflowRecord,
    linkedInstallation: Awaited<ReturnType<WorkflowHost['getInstallation']>> | undefined,
    exec: ToolRunContext,
  ): Promise<{ cleanup: 'not_required' | 'already_removed' | 'removed'; restartRequired: boolean }> {
    let cleanup: 'not_required' | 'already_removed' | 'removed' = 'not_required'
    let restartRequired = false
    if (linkedInstallation && workflow.lastInstallationId) {
      if (linkedInstallation.removed) {
        cleanup = 'already_removed'
        restartRequired = linkedInstallation.retention === 'persistent'
      } else {
        const removal = await this.host.cleanupInstallation!(workflow.lastInstallationId, exec as WorkflowExec)
        if (!removal.removed || removal.installationId !== workflow.lastInstallationId) {
          throw new EvolutionError('command_failed', 'Host cleanup did not remove the exact linked installation receipt')
        }
        cleanup = 'removed'
        restartRequired = removal.restartRequired
      }
    }
    return { cleanup, restartRequired }
  }

  private async finishCleanupAndRestart(
    workflow: WorkflowRecord,
    exec: ToolRunContext,
    input: {
      hostTurnId: string
      cleanup: 'not_required' | 'already_removed' | 'removed'
      restartRequired: boolean
      consumeInterruptId?: string
    },
    setRestart: (restart: {
      requirement: string
      normalized: string
      sessionId: string
      cwd: string
      oldWorkflowId: string
      workflowId: string
    }) => void,
  ): Promise<WorkflowView> {
    const sessionId = ownerSessionId(exec.agent)!
    const normalized = workflow.requirementNormalized ?? normalizeRequirement(workflow.requirement)
    const cwd = workflow.cwd ?? sessionCwd(exec.agent)
    const restartedAsWorkflowId = newWorkflowId(workflow.requirement)
    workflow.status = 'completed'
    workflow.generation += 1
    if (input.consumeInterruptId) {
      workflow.consumedInterruptIds = [...(workflow.consumedInterruptIds ?? []), input.consumeInterruptId]
    }
    delete workflow.interrupt
    workflow.recovery = {
      action: 'cleanup_and_restart',
      hostTurnId: input.hostTurnId,
      cleanup: input.cleanup,
      ...(workflow.lastInstallationId ? { installationId: workflow.lastInstallationId } : {}),
      restartRequired: input.restartRequired,
      restartedAsWorkflowId,
      completedAt: new Date().toISOString(),
    }
    await this.checkpoint(workflow)
    setRestart({
      requirement: workflow.requirement,
      normalized,
      sessionId,
      cwd,
      oldWorkflowId: workflow.id,
      workflowId: restartedAsWorkflowId,
    })
    return await this.view(workflow)
  }

  async refine(input: DiscoveryRefineInput, exec: ToolRunContext): Promise<WorkflowView> {
    return await this.withLock(input.workflowId, async () => {
      const workflow = await this.store.getWorkflow(input.workflowId)
      this.assertDiscoveryControl(workflow, exec)
      if (!workflow.resolutionId) throw new EvolutionError('invalid_input', 'Discovery workflow has no resolution')
      if (!this.host.refineRemote) throw new EvolutionError('invalid_input', 'This workflow host does not support autonomous refinement')
      const budget = workflow.discoveryBudget ?? discoveryBudget()
      if (budget.refinementRoundsUsed >= budget.maxRefinementRounds) {
        throw new EvolutionError('invalid_input', 'Discovery refinement round budget is exhausted')
      }
      const usedQueries = new Set(budget.refinementQueriesUsed.map((item) => item.toLowerCase()))
      const queries = [...new Set((input.queries ?? [])
        .map(normalizeRefinementQuery)
        .filter((item) => item.length >= 2 && !usedQueries.has(item.toLowerCase())))]
      if (budget.refinementQueriesUsed.length + queries.length > budget.maxRefinementQueries) {
        throw new EvolutionError('invalid_input', 'Discovery refinement query budget would be exceeded', {
          remaining: budget.maxRefinementQueries - budget.refinementQueriesUsed.length,
        })
      }
      const usedRepositories = new Set(budget.explicitRepositories.map((item) => item.toLowerCase()))
      const repositories = [...new Set((input.repositories ?? [])
        .map((item) => item.normalize('NFKC').trim())
        .filter((item) => item && !usedRepositories.has(item.toLowerCase())))]
        .slice(0, 5)
      if (queries.length === 0 && repositories.length === 0) {
        throw new EvolutionError('invalid_input', 'Refinement requires at least one new query or repository')
      }
      const resolution = await this.host.getResolution(workflow.resolutionId)
      const nextResolution = await this.host.refineRemote(resolution, { queries, repositories }, exec as WorkflowExec)
      delete workflow.lastDiagnosis
      workflow.discoveryBudget = {
        ...budget,
        refinementRoundsUsed: budget.refinementRoundsUsed + 1,
        refinementQueriesUsed: [...budget.refinementQueriesUsed, ...queries],
        explicitRepositories: [...budget.explicitRepositories, ...repositories],
      }
      workflow.discoveryPool = candidateSnapshotFor(
        nextResolution,
        excludedCandidateIds(workflow),
        DISCOVERY_POOL_MAX,
      )
      const refinementExhausted = workflow.discoveryBudget.refinementRoundsUsed
        >= workflow.discoveryBudget.maxRefinementRounds
      const hasReviewableCandidate = workflow.discoveryPool.some((candidate) => (
        candidate.kind === 'remote' || (candidate.kind === 'local' && candidate.fit === 'full')
      ))
      workflow.generation += 1
      if (refinementExhausted && !hasReviewableCandidate) {
        workflow.cursor = 'await_confirmation'
        workflow.status = 'running'
        workflow.candidateSnapshot = []
        delete workflow.interrupt
        await this.checkpoint(workflow)
        return await this.runUntilPark(workflow, exec, undefined, nextResolution)
      }
      await this.checkpoint(workflow)
      this.syncGuard(workflow, exec, undefined, nextResolution)
      return await this.view(workflow, nextResolution)
    })
  }

  async present(input: DiscoveryPresentInput, exec: ToolRunContext): Promise<WorkflowView> {
    return await this.withLock(input.workflowId, async () => {
      const workflow = await this.store.getWorkflow(input.workflowId)
      this.assertDiscoveryControl(workflow, exec)
      const ids = [...new Set(input.candidateIds)]
      if (ids.length !== input.candidateIds.length) {
        throw new EvolutionError('invalid_input', 'Presented candidate_ids must be unique')
      }
      if (ids.length < 1 || ids.length > SEALED_SHORTLIST_MAX) {
        throw new EvolutionError('invalid_input', 'Present requires one to five discovery candidate_ids')
      }
      const pool = workflow.discoveryPool ?? []
      const selected = ids.map((id) => pool.find((item) => item.id === id))
      if (selected.some((item) => !item)) {
        throw new EvolutionError('invalid_input', 'Presented candidate is outside the Host discovery pool')
      }
      workflow.candidateSnapshot = selected.map((item, index) => ({ ...item!, index: index + 1 }))
      workflow.cursor = 'await_selection'
      workflow.status = 'running'
      workflow.generation += 1
      delete workflow.interrupt
      delete workflow.invalidResumeAttempt
      delete workflow.lastDiagnosis
      return await this.runUntilPark(workflow, exec)
    })
  }

  async diagnose(input: WorkflowDiagnoseInput, exec: ToolRunContext): Promise<WorkflowView> {
    return await this.withLock(input.workflowId, async () => {
      const workflow = await this.store.getWorkflow(input.workflowId)
      this.assertOwner(workflow, exec)
      const probes = [...new Set(input.probes)].slice(0, 8)
      if (probes.length === 0) throw new EvolutionError('invalid_input', 'Diagnose requires at least one probe')
      const priorDiagnosis = workflow.lastDiagnosis
      const priorCalls = priorDiagnosis?.budget.usedCalls ?? 0
      const priorProbeUses = priorDiagnosis?.budget.usedProbes ?? 0
      if (priorCalls >= 2) {
        throw new EvolutionError('invalid_input', 'Diagnostic call budget is exhausted for this failure episode')
      }
      if (priorProbeUses + probes.length > 8) {
        throw new EvolutionError('invalid_input', 'Diagnostic probe budget would be exceeded', {
          remaining: Math.max(0, 8 - priorProbeUses),
        })
      }
      const resolution = workflow.resolutionId
        ? await this.host.getResolution(workflow.resolutionId).catch(() => undefined)
        : undefined
      const reviews = await this.reviewsForWorkflow(workflow)
      const installation = workflow.lastInstallationId
        ? await this.host.getInstallation(workflow.lastInstallationId).catch(() => undefined)
        : undefined
      const diagnosticAvailable = Boolean(
        workflow.lastFailure
        || workflow.reviewFailures?.length
        || (resolution && !resolution.remoteDiscoveryComplete)
        || (installation
          && !installation.verified
          && !(INSTALL_SUCCESS_OUTCOMES as readonly string[]).includes(installation.installOutcome ?? '')),
      )
      if (!diagnosticAvailable) {
        throw new EvolutionError('invalid_input', 'No failed or incomplete workflow stage is available for diagnosis')
      }
      const facts: DiagnosticFact[] = []
      for (const probe of probes) {
        if (probe === 'discovery') {
          facts.push({
            probe,
            status: !resolution ? 'unknown' : resolution.remoteDiscoveryComplete ? 'pass' : 'failed',
            code: !resolution ? 'discovery_missing' : resolution.remoteDiscoveryComplete ? 'search_complete' : 'search_incomplete',
            summary: boundedDiagnosticText((resolution?.reasons ?? []).at(-1) ?? 'No discovery result is linked.'),
            observed: Boolean(resolution),
            facts: {
              queries: (resolution?.queries ?? []).map((query) => boundedDiagnosticText(query, 120)).slice(0, 10),
              candidateCount: resolution?.remoteCandidates.length ?? 0,
            },
          })
        } else if (probe === 'review') {
          const failures = workflow.reviewFailures ?? []
          facts.push({
            probe,
            status: failures.length > 0 ? 'failed' : reviews.length > 0 ? 'pass' : 'unknown',
            code: failures[0]?.code ?? (reviews.length > 0 ? 'review_available' : 'review_missing'),
            summary: boundedDiagnosticText(failures[0]?.message ?? (reviews.length > 0
              ? `${reviews.length} bounded review record(s) are linked.`
              : 'No review record is linked.')),
            observed: failures.length > 0 || reviews.length > 0,
            facts: { reviewCount: reviews.length, failureCount: failures.length },
          })
        } else if (probe === 'installation') {
          facts.push({
            probe,
            status: !installation
              ? 'unknown'
              : (INSTALL_SUCCESS_OUTCOMES as readonly string[]).includes(installation.installOutcome ?? '')
                ? 'pass'
                : 'failed',
            code: installation?.installFailure?.code ?? installation?.installOutcome ?? 'installation_missing',
            summary: boundedDiagnosticText(installation?.installFailure?.message
              ?? installation?.verification.reason
              ?? 'No installation record is linked.'),
            observed: Boolean(installation),
            ...(installation?.installFailure?.diagnosticHash
              ? { evidenceHash: installation.installFailure.diagnosticHash }
              : {}),
            ...(installation ? { facts: {
              installState: installation.installState ?? 'unknown',
              removed: installation.removed,
              loaded: installation.loaded,
              verified: installation.verified,
            } } : {}),
          })
        } else if (probe === 'verification') {
          const verification = installation?.verification
          facts.push({
            probe,
            status: !verification ? 'unknown' : installation?.verified ? 'pass' : 'failed',
            code: !verification ? 'verification_missing' : installation?.verified ? 'verified' : 'verification_failed',
            summary: boundedDiagnosticText(verification?.reason ?? 'No verification record is linked.'),
            observed: Boolean(verification),
            ...(verification?.launchEvidence?.diagnosticHash
              ? { evidenceHash: verification.launchEvidence.diagnosticHash }
              : {}),
            ...(verification ? { facts: {
              exitCode: verification.exitCode ?? -1,
              taskResultObserved: verification.taskResultObserved,
              calledTools: verification.calledTools.slice(0, 16),
              failedTools: verification.failedTools.slice(0, 16),
              routeMatchedExpectation: verification.routeMatchedExpectation ?? true,
              processOutcome: verification.launchEvidence?.processOutcome ?? 'unknown',
              observerEventCount: verification.launchEvidence?.observerEventCount ?? 0,
            } } : {}),
          })
        } else if (probe === 'cleanup') {
          facts.push({
            probe,
            status: !installation ? 'unknown' : installation.removed ? 'pass' : 'failed',
            code: !installation ? 'cleanup_unknown' : installation.removed ? 'cleanup_recorded' : 'target_may_remain',
            summary: installation?.removed
              ? 'The linked installation record reports cleanup completed.'
              : 'The linked installation record does not prove cleanup completed.',
            observed: Boolean(installation),
            ...(installation ? { facts: {
              removed: installation.removed,
              installState: installation.installState ?? 'unknown',
            } } : {}),
          })
        } else {
          const failure = workflow.lastFailure
          facts.push({
            probe,
            status: failure?.stage === 'managed_child' ? 'failed' : 'unknown',
            code: failure?.code ?? 'managed_child_unknown',
            summary: boundedDiagnosticText(failure?.message ?? 'No managed-child failure is linked.'),
            observed: failure?.stage === 'managed_child',
            ...(failure?.diagnosticHash ? { evidenceHash: failure.diagnosticHash } : {}),
          })
        }
      }
      const priorFacts = new Map((priorDiagnosis?.facts ?? []).map((fact) => [fact.probe, fact] as const))
      for (const fact of facts) priorFacts.set(fact.probe, fact)
      const diagnosis: WorkflowDiagnosis = {
        createdAt: new Date().toISOString(),
        probes: [...new Set([...(priorDiagnosis?.probes ?? []), ...probes])],
        facts: [...priorFacts.values()],
        budget: {
          maxCalls: 2,
          usedCalls: priorCalls + 1,
          maxProbes: 8,
          usedProbes: priorProbeUses + probes.length,
          maxRecordReads: 4,
          usedRecordReads: 1 + (reviews.length > 0 ? 1 : 0) + (installation ? 1 : 0),
        },
      }
      workflow.lastDiagnosis = diagnosis
      await this.checkpoint(workflow)
      return await this.view(workflow, resolution, { diagnosis, skipLinkedReads: true })
    })
  }

  private async invalidResumeView(
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

  async resume(input: ResumeInput, exec: ToolRunContext): Promise<WorkflowView> {
    return await this.withLock(input.workflowId, async () => {
      assertResumeDoesNotForgeHostFacts(input)
      const workflow = await this.store.getWorkflow(input.workflowId)
      const callerSessionId = ownerSessionId(exec.agent)
      if (!callerSessionId || callerSessionId !== workflow.ownerSessionId) {
        throw new EvolutionError('invalid_input', 'Workflow belongs to a different owner session', {
          expected: workflow.ownerSessionId,
          actual: callerSessionId,
        })
      }
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

      const sessionId = callerSessionId
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

      if (this.creationGuard.isAwaitingFreshUserTurn(exec.agent, workflow.interrupt)) {
        return await this.view(workflow, resolution, {
          status: 'parked',
          alreadyWaiting: true,
        })
      }

      const currentTurnId = this.creationGuard.currentTurnId(exec.agent)
      const invalidAttempt = workflow.invalidResumeAttempt
      if (invalidAttempt && invalidAttempt.hostTurnId === currentTurnId && invalidAttempt.count >= 2) {
        return await this.view(workflow, resolution, {
          status: 'invalid_resume',
          resumeHint: 'Repeated invalid action is blocked until a fresh user turn.',
        })
      }
      if (workflow.invalidResumeAttempt && workflow.invalidResumeAttempt.hostTurnId !== currentTurnId) {
        delete workflow.invalidResumeAttempt
        await this.checkpoint(workflow)
      }

      if (input.navigation && input.decision) {
        return await this.invalidResumeView(workflow, resolution, exec, input, 'Provide either navigation or decision, not both')
      }
      const coercedNavigation = !input.navigation
        ? selectionNavigationFromMisplacedDecision(workflow, input.decision)
        : undefined
      if (coercedNavigation) {
        try {
          return await this.resumeNavigation(workflow, resolution, coercedNavigation, input.interruptId, exec)
        } catch (error) {
          const hint = retryableResumeHint(error)
          if (hint) return await this.invalidResumeView(workflow, resolution, exec, input, hint)
          throw error
        }
      }
      if (input.navigation) {
        try {
          return await this.resumeNavigation(workflow, resolution, input.navigation, input.interruptId, exec)
        } catch (error) {
          const hint = retryableResumeHint(error)
          if (hint) return await this.invalidResumeView(workflow, resolution, exec, input, hint)
          throw error
        }
      }
      if (workflow.cursor !== 'await_confirmation') {
        return await this.invalidResumeView(
          workflow,
          resolution,
          exec,
          input,
          'This gate accepts read-only navigation rather than a final authorization action',
        )
      }
      if (!input.decision) {
        return await this.invalidResumeView(
          workflow,
          resolution,
          exec,
          input,
          'Final confirmation requires a model-interpreted decision bound to the fresh user turn',
        )
      }
      let decisionReview
      let resume
      try {
        resolveDecisionTarget(input.decision, workflow.interrupt)
        decisionReview = input.decision.action === 'use_this' || input.decision.action === 'modify_this'
          ? await this.reviewForAuthorization(workflow, reviews, input.decision.candidateId)
          : undefined
        resume = resolveDecisionFromModel({
          guard: this.creationGuard,
          agent: exec.agent,
          interrupt: workflow.interrupt,
          decision: input.decision,
          requirement: workflow.requirement,
          ...(decisionReview ? { reviewId: decisionReview.id } : {}),
          ...(decisionReview?.runtimeSurface?.verificationLayer
            ? { verificationLayer: decisionReview.runtimeSurface.verificationLayer }
            : {}),
        })
      } catch (error) {
        const hint = retryableResumeHint(error)
        if (hint) return await this.invalidResumeView(workflow, resolution, exec, input, hint)
        throw error
      }

      const latest = await this.store.getWorkflow(workflow.id)
      if (latest.generation !== workflow.generation || latest.status !== 'interrupted') {
        throw new EvolutionError('invalid_input', 'This workflow is already running or has moved on')
      }
      latest.generation += 1
      latest.status = 'running'
      delete latest.lastFailure
      delete latest.lastDiagnosis
      delete latest.invalidResumeAttempt
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
    delete latest.lastDiagnosis
    delete latest.invalidResumeAttempt

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
      delete latest.discoveryPool
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

  private assertOwner(workflow: WorkflowRecord, exec: ToolRunContext): void {
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

  private assertDiscoveryControl(workflow: WorkflowRecord, exec: ToolRunContext): void {
    this.assertOwner(workflow, exec)
    if (workflow.status !== 'interrupted' || workflow.cursor !== 'await_discovery' || workflow.interrupt) {
      throw new EvolutionError('invalid_input', 'Workflow is not at the autonomous discovery checkpoint', {
        status: workflow.status,
        cursor: workflow.cursor,
      })
    }
    workflow.bootId = this.creationGuard.bootId
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
      stage: 'workflow',
      code: 'policy_restart_required',
      message: 'This workflow predates Policy V8. Call capability_workflow again to start a fresh discovery. Previous interrupts, decisions, receipts, verdicts, commitments, and leases are not executable.',
      retryable: false,
    }
    await this.checkpoint(workflow)
  }

  private async reissueInterrupt(workflow: WorkflowRecord, exec: ToolRunContext): Promise<void> {
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

  private async issueRecoveryInterrupt(workflow: WorkflowRecord, exec: ToolRunContext): Promise<void> {
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

  private recoverySnapshotDigest(workflow: WorkflowRecord): string {
    return hashObject({
      workflowId: workflow.id,
      policyVersion: workflow.policyVersion,
      generation: workflow.generation,
      lastInstallationId: workflow.lastInstallationId ?? null,
      lastFailure: workflow.lastFailure ?? null,
    })
  }

  private markInstallCompletion(workflow: WorkflowRecord, exec: ToolRunContext): void {
    if (!COMPLETED_CLEANUP_NODES.has(workflow.cursor)) return
    const turnId = this.creationGuard.currentTurnId(exec.agent)
    if (turnId) workflow.completionTurnId = turnId
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

        if (MODEL_CONTROL_NODES.has(workflow.cursor)) {
          if (!resolution && workflow.resolutionId) {
            resolution = await this.host.getResolution(workflow.resolutionId)
          }
          if (!resolution) throw new EvolutionError('invalid_input', 'Discovery checkpoint is missing a resolution')
          workflow.discoveryPool = candidateSnapshotFor(
            resolution,
            excludedCandidateIds(workflow),
            DISCOVERY_POOL_MAX,
          )
          workflow.discoveryBudget ??= discoveryBudget()
          workflow.status = 'interrupted'
          delete workflow.interrupt
          delete workflow.candidateSnapshot
          this.clearWorkflowGrant(workflow)
          this.creationGuard.invalidateExecutionLease(exec.agent)
          await this.checkpoint(workflow)
          this.syncGuard(workflow, exec, guardGeneration, resolution)
          return await this.view(workflow, resolution)
        }

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
          if (workflow.cursor === 'recovery_required') {
            await this.issueRecoveryInterrupt(workflow, exec)
            this.syncGuard(workflow, exec, guardGeneration, resolution)
            return await this.view(workflow, resolution, { status: 'parked', alreadyWaiting: true })
          }
          this.markInstallCompletion(workflow, exec)
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
        if (result.node === 'await_discovery' && result.resolution) {
          workflow.discoveryPool = candidateSnapshotFor(
            result.resolution,
            excludedCandidateIds(workflow),
            DISCOVERY_POOL_MAX,
          )
          workflow.discoveryBudget ??= discoveryBudget()
        } else if (result.node === 'review_github' && result.resolution && !workflow.candidateSnapshot) {
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
        if (workflow.cursor === 'recovery_required') {
          await this.issueRecoveryInterrupt(workflow, exec)
          this.syncGuard(workflow, exec, guardGeneration, resolution)
          return await this.view(workflow, resolution, { status: 'parked', alreadyWaiting: true })
        }
        this.markInstallCompletion(workflow, exec)
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
    this.creationGuard.setWaiting(
      exec.agent,
      workflow.cursor === 'await_discovery'
        ? 'await_discovery'
        : isInterruptKind(workflow.cursor) ? workflow.cursor : undefined,
      workflow.interrupt?.validAfterTurnId,
    )
  }

  private async view(
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
}
