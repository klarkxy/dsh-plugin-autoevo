import type { InstallationRecord, ResolutionRecord, ReviewMode, ReviewRecord, WorkflowOptionId } from '../contracts.js'
import { EvolutionError } from '../errors.js'
import {
  confirmationFacts,
  createWorkFacts,
  modificationAttemptsExhausted,
  modifyWorkFacts,
  optionsFor,
  reviewSourceIdentity,
  sameVerificationAttempt,
  selectionFacts,
  type ConsumedVerificationAttempt,
  type InterruptKind,
  type InterruptPayload,
  type WorkflowExec,
  type WorkflowHost,
  type WorkflowNodeId,
  type WorkflowRecord,
} from './contracts.js'
import { remoteCandidateId } from './candidates.js'

export interface GraphContext {
  host: WorkflowHost
  workflow: WorkflowRecord
  exec: WorkflowExec
  resolution?: ResolutionRecord
}

export interface NodeExecutionResult {
  kind: 'next' | 'done'
  node: WorkflowNodeId
  resolution?: ResolutionRecord
  review?: ReviewRecord
  reviews?: ReviewRecord[]
  reviewFailures?: Array<{ repository: string; code: string; message: string }>
  installation?: InstallationRecord
}

function managedWorkFailureStage(error: unknown): 'managed_child' | 'review' {
  return error instanceof EvolutionError && error.details.managedChildCompleted === true
    ? 'review'
    : 'managed_child'
}

const TRANSITIONS: Partial<Record<WorkflowNodeId, Partial<Record<WorkflowOptionId, WorkflowNodeId>>>> = {
  await_clarification: {
    clarify_requirement: 'resolve_local',
    stop: 'stopped',
  },
  await_confirmation: {
    use_this: 'install_verify',
    apply_recovery: 'install_verify',
    modify_this: 'prepare_modify',
    create_new: 'prepare_create',
    stop: 'stopped',
  },
  await_selection: {
    create_new: 'prepare_create',
    stop: 'stopped',
  },
  await_modify_work: {
    stop: 'stopped',
    finish_managed_work: 'complete_managed_work',
  },
}

export function transition(cursor: WorkflowNodeId, optionId: WorkflowOptionId): WorkflowNodeId {
  const next = TRANSITIONS[cursor]?.[optionId]
  if (!next) {
    throw new EvolutionError('invalid_input', 'This option cannot resume the current workflow node', {
      cursor,
      optionId,
    })
  }
  return next
}

export function interruptPayload(
  cursor: WorkflowNodeId,
  resolution: ResolutionRecord | undefined,
  reviews: ReviewRecord[] = [],
  extras: {
    lastFailure?: WorkflowRecord['lastFailure']
    installProfiles?: string[]
    pendingPath?: string
    workflow?: WorkflowRecord
    managedActionsAvailable?: boolean
    retryableInstall?: import('./contracts.js').RetryableInstallContext
  } = {},
): Omit<InterruptPayload, 'interruptId' | 'ownerSessionId' | 'bootId' | 'validAfterTurnId' | 'snapshotDigest'> {
  if (cursor === 'await_clarification') {
    return {
      kind: 'await_clarification',
      options: optionsFor('await_clarification', undefined, reviews, extras.workflow),
      facts: {
        originalRequirement: extras.workflow?.requirement ?? '',
        clarificationQuestion: extras.workflow?.clarificationQuestion ?? '',
      },
    }
  }
  if (!resolution) throw new EvolutionError('invalid_input', 'Workflow interrupt is missing a resolution')
  if (cursor === 'await_selection') {
    return {
      kind: 'await_selection',
      options: optionsFor(
        'await_selection',
        resolution,
        reviews,
        extras.workflow,
        [],
        extras.managedActionsAvailable ?? true,
      ),
      facts: selectionFacts(resolution, extras.workflow),
    }
  }
  if (cursor === 'await_confirmation') {
    return {
      kind: 'await_confirmation',
      options: optionsFor('await_confirmation', resolution, reviews, extras.workflow, extras.installProfiles,
        extras.managedActionsAvailable ?? true, extras.retryableInstall),
      facts: confirmationFacts(resolution, reviews, extras.workflow, extras),
    }
  }
  if (cursor === 'await_modify_work') {
    const review = reviews[0]
    if (review) {
      return {
        kind: 'await_modify_work',
        options: optionsFor('await_modify_work', resolution, reviews, extras.workflow),
        facts: modifyWorkFacts(review, extras.workflow),
      }
    }
    if (!extras.pendingPath) {
      throw new EvolutionError('invalid_input', 'Create-work interrupt requires a managed source path')
    }
    return {
      kind: 'await_modify_work',
      options: optionsFor('await_modify_work', resolution, reviews, extras.workflow),
      facts: createWorkFacts(extras.workflow),
    }
  }
  throw new EvolutionError('invalid_input', 'Not an interrupt node', { cursor })
}

export function interruptKind(cursor: WorkflowNodeId): InterruptKind | undefined {
  if (cursor === 'await_selection' || cursor === 'await_confirmation') {
    return cursor
  }
  return undefined
}

export async function executeNode(node: WorkflowNodeId, ctx: GraphContext): Promise<NodeExecutionResult> {
  if (node === 'resolve_local') return executeResolveLocal(ctx)
  if (node === 'discover_remote') return executeDiscoverRemote(ctx)
  if (node === 'ensure_market') return executeEnsureMarket(ctx)
  if (node === 'review_github') return executeReviewGithub(ctx)
  if (node === 'review_existing') return executeReviewExisting(ctx)
  if (node === 'review_local') return executeReviewLocal(ctx)
  if (node === 'install_verify') return executeInstallVerify(ctx)
  if (node === 'enable_builtin') return executeEnableBuiltin(ctx)
  if (node === 'prepare_modify') return executePrepareModify(ctx)
  if (node === 'prepare_create') return executePrepareCreate(ctx)
  if (node === 'complete_managed_work') return executeCompleteManagedWork(ctx)
  throw new EvolutionError('invalid_input', 'No automatic implementation for this workflow node', { node })
}

async function executeCompleteManagedWork(ctx: GraphContext): Promise<NodeExecutionResult> {
  const current = await requireResolution(ctx)
  if (!ctx.host.finishManagedWork) {
    throw new EvolutionError('invalid_input', 'This workflow host does not support managed construction')
  }
  try {
    const finished = await ctx.host.finishManagedWork(current, ctx.exec, ctx.workflow)
    delete ctx.workflow.lastFailure
    if (finished.path) ctx.workflow.pendingPath = finished.path
    if (finished.continueConstruction) {
      return { kind: 'next', node: 'await_modify_work', resolution: finished.resolution, ...(finished.review ? { review: finished.review } : {}) }
    }
    if (finished.review) {
      return { kind: 'next', node: 'await_confirmation', resolution: finished.resolution, review: finished.review }
    }
    return { kind: 'done', node: 'modify_authorized', resolution: finished.resolution }
  } catch (error) {
    if (error instanceof EvolutionError && error.details.recoveryRequired === true) {
      const review = ctx.workflow.lastReviewId
        ? await ctx.host.getReview(ctx.workflow.lastReviewId).catch(() => undefined)
        : undefined
      ctx.workflow.lastFailure = {
        stage: 'managed_child',
        code: error.code,
        message: error.message,
        retryable: false,
      }
      return { kind: 'done', node: 'recovery_required', resolution: current, ...(review ? { review } : {}) }
    }
    if (ctx.exec.signal?.aborted
      || !(error instanceof EvolutionError)
      || (error.code !== 'command_failed'
        && error.code !== 'review_rejected')) throw error
    const review = ctx.workflow.lastReviewId
      ? await ctx.host.getReview(ctx.workflow.lastReviewId).catch(() => undefined)
      : undefined
    ctx.workflow.lastFailure = {
      stage: managedWorkFailureStage(error),
      code: error instanceof EvolutionError ? error.code : 'command_failed',
      message: error instanceof Error ? error.message : String(error),
      retryable: true,
    }
    // A failed seal/re-review is still managed construction work. Keep the
    // same source root available so the model can repair ordinary build,
    // provenance, or review failures and ask Host to review the result again.
    // Presenting an older review here would expose an install action that can
    // no longer be bound to the current source bytes.
    return { kind: 'next', node: 'await_modify_work', resolution: current, ...(review ? { review } : {}) }
  }
}

async function executeResolveLocal(ctx: GraphContext): Promise<NodeExecutionResult> {
  const resolution = await ctx.host.bootstrapResolution(
    ctx.workflow.searchRequirement ?? ctx.workflow.requirement,
    ctx.exec,
    ctx.workflow.clarifiedIntent ?? ctx.workflow.intent,
  )
  ctx.workflow.resolutionId = resolution.id
  ctx.workflow.cwd = resolution.cwd
  const shouldDiscover = ctx.workflow.forceRemoteDiscovery || resolution.decision !== 'use_local'
  return {
    kind: 'next',
    node: shouldDiscover ? 'discover_remote' : 'await_discovery',
    resolution,
  }
}

function nextUnseenRemote(resolution: ResolutionRecord, workflow: WorkflowRecord) {
  const excluded = new Set([...(workflow.seenCandidateIds ?? []), ...(workflow.rejectedCandidateIds ?? [])])
  return resolution.remoteCandidates.find((item) => !excluded.has(remoteCandidateId(item)))
}

function discoveryCheckpoint(resolution: ResolutionRecord, workflow: WorkflowRecord): WorkflowNodeId {
  const hasSatisfyingLocal = resolution.localCandidates.some((item) => item.fit === 'full' && item.surfaceMatch !== false)
  if (nextUnseenRemote(resolution, workflow) || hasSatisfyingLocal) return 'await_discovery'
  // Reuse the existing selection gate for both an exhausted search and an
  // incomplete one. Its option policy keeps creation unavailable until Host
  // marks remote discovery complete, while still allowing retry and stop.
  return 'await_selection'
}

async function executeDiscoverRemote(ctx: GraphContext): Promise<NodeExecutionResult> {
  const current = await requireResolution(ctx)
  let resolution: ResolutionRecord
  try {
    const baselineQueries = current.queries.length === 0 ? ctx.workflow.discoveryQueries : undefined
    resolution = await ctx.host.discoverRemote(current, ctx.exec, {
      ...(baselineQueries ? { queries: baselineQueries } : {}),
    })
    if (ctx.workflow.lastFailure?.stage === 'discovery') delete ctx.workflow.lastFailure
  } catch (error) {
    ctx.workflow.lastFailure = {
      stage: 'discovery',
      code: error instanceof EvolutionError ? error.code : 'command_failed',
      message: error instanceof Error ? error.message : String(error),
      retryable: true,
    }
    resolution = { ...current, remoteDiscoveryComplete: false }
  }
  ctx.workflow.forceRemoteDiscovery = false
  return { kind: 'next', node: discoveryCheckpoint(resolution, ctx.workflow), resolution }
}

async function executeEnsureMarket(ctx: GraphContext): Promise<NodeExecutionResult> {
  const current = await requireResolution(ctx)
  const { resolution, market } = await ctx.host.ensureMarket(current, ctx.exec)
  if (market.status === 'loaded') return { kind: 'next', node: 'discover_remote', resolution }
  if (market.status === 'empty') {
    return { kind: 'next', node: discoveryCheckpoint(resolution, ctx.workflow), resolution }
  }
  if (market.status === 'blocked') return { kind: 'done', node: 'market_setup_required', resolution }
  return { kind: 'done', node: 'market_restart_required', resolution }
}

async function executeReviewGithub(ctx: GraphContext): Promise<NodeExecutionResult> {
  const current = await requireResolution(ctx)
  const selected = ctx.workflow.pendingRepositories?.length
    ? ctx.workflow.pendingRepositories
    : current.selectedRepositories ?? []
  if (selected.length < 1 || selected.length > 3) {
    throw new EvolutionError('invalid_input', 'candidate review requires between one and three repositories')
  }
  if (ctx.host.reviewGithubBatch) {
    const result = await ctx.host.reviewGithubBatch(
      current,
      selected,
      ctx.workflow.reviewPlan?.mode ?? 'fixed',
      ctx.exec,
      ctx.workflow,
    )
    if (result.reviews.length === 0) {
      return {
        kind: 'next',
        node: 'await_confirmation',
        resolution: result.resolution,
        reviews: [],
        reviewFailures: result.failures,
      }
    }
    const primary = result.reviews[0]!
    return {
      kind: 'next',
      node: 'await_confirmation',
      resolution: result.resolution,
      review: primary,
      reviews: result.reviews,
      reviewFailures: result.failures,
    }
  }
  const repository = selected[0]!
  const { resolution, review } = await ctx.host.reviewGithub(
    current,
    repository,
    ctx.workflow.pendingRef,
    ctx.exec,
    ctx.workflow,
  )
  return { kind: 'next', node: 'await_confirmation', resolution, review }
}

async function executeReviewExisting(ctx: GraphContext): Promise<NodeExecutionResult> {
  const current = await requireResolution(ctx)
  const snapshot = ctx.workflow.candidateSnapshot ?? []
  const candidate = snapshot.find((item) => item.id === ctx.workflow.pendingReviewedCandidateId)
    ?? snapshot.find((item) => item.evolutionTarget && ctx.workflow.pendingRepositories?.includes(item.evolutionTarget.repository))
  const target = candidate?.evolutionTarget
  if (!target) {
    throw new EvolutionError('invalid_input', 'review_existing requires a frozen installed evolution target')
  }
  if (!ctx.host.reviewExisting) {
    throw new EvolutionError('invalid_input', 'This workflow host does not support installed-source review')
  }
  const { resolution, review } = await ctx.host.reviewExisting(current, target, ctx.exec, ctx.workflow)
  return { kind: 'next', node: 'await_confirmation', resolution, review }
}

async function executeReviewLocal(ctx: GraphContext): Promise<NodeExecutionResult> {
  const current = await requireResolution(ctx)
  const path = ctx.workflow.pendingPath
  const baseReviewId = ctx.workflow.lineageTipReviewId ?? ctx.workflow.lastReviewId
  if (!path || !baseReviewId) {
    throw new EvolutionError('invalid_input', 'Local re-review requires a checkout path and a lineage tip')
  }
  const { resolution, review } = await ctx.host.reviewLocal(current, path, baseReviewId, ctx.exec, ctx.workflow)
  return { kind: 'next', node: 'await_confirmation', resolution, review }
}

const CLOSED_VERIFICATION_STATUSES = new Set(['failed', 'blocked_precondition', 'uncertain'])

function recordVerificationAttempt(
  workflow: WorkflowRecord,
  review: ReviewRecord,
  installation?: InstallationRecord,
): void {
  const layer = review.runtimeSurface?.verificationLayer
    ?? installation?.verification?.layer
    ?? 'unspecified'
  const fixtureDigest = installation?.verification?.fixtureDigest
  const attempt: ConsumedVerificationAttempt = {
    reviewId: review.id,
    sourceIdentity: reviewSourceIdentity(review),
    layer,
    ...(fixtureDigest ? { fixtureDigest } : {}),
  }
  const existing = workflow.consumedVerificationAttempts ?? []
  if (existing.some((item) => sameVerificationAttempt(item, review, {
    layer,
    ...(fixtureDigest ? { fixtureDigest } : {}),
  }))) {
    return
  }
  workflow.consumedVerificationAttempts = [...existing, attempt]
}

function alreadyAttemptedVerification(workflow: WorkflowRecord, review: ReviewRecord): boolean {
  return (workflow.consumedVerificationAttempts ?? []).some((item) => sameVerificationAttempt(item, review))
}

function successTerminalNode(installation: InstallationRecord): WorkflowNodeId | undefined {
  if (installation.installOutcome === 'verified' && installation.verified === true && installation.installed) {
    return installation.restartRequired ? 'restart_required' : 'installed'
  }
  if (installation.installOutcome === 'activated' && installation.installed && installation.verified !== true) {
    return installation.restartRequired ? 'restart_required' : 'activated'
  }
  if (installation.installOutcome === 'awaiting_user_test' && installation.installed && installation.verified !== true) {
    return 'awaiting_user_test'
  }
  return undefined
}

function installFailureCode(installation: InstallationRecord): string {
  const status = installation.verification.status
  if (status && CLOSED_VERIFICATION_STATUSES.has(status)) return status
  return installation.installOutcome ?? 'recovery_required'
}

function workflowFailureStage(installation: InstallationRecord): 'install' | 'verification' | 'hot_load' {
  switch (installation.installFailure?.stage) {
    case 'load': return 'hot_load'
    case 'verify': return 'verification'
    default: return installation.installFailure ? 'install' : 'verification'
  }
}

function assertPendingInstallReceipt(
  workflow: WorkflowRecord,
  review: ReviewRecord,
  install: NonNullable<WorkflowRecord['pendingInstall']>,
  installation: InstallationRecord,
): void {
  const installSpecMatches = installation.installSpec === review.installSpec
  if (installation.id !== workflow.pendingInstallationId
    || installation.workflowId !== workflow.id
    || installation.reviewId !== review.id
    || installation.targetProfile !== install.targetProfile
    || installation.retention !== install.retention
    || !installSpecMatches) {
    throw new EvolutionError('invalid_input', 'Pending installation receipt is not bound to the current workflow, review, and install target')
  }
}

function builtinTerminalNode(installation: InstallationRecord | undefined): WorkflowNodeId {
  return installation?.restartRequired === false ? 'installed' : 'restart_required'
}

function projectLinkedInstallation(
  ctx: GraphContext,
  current: ResolutionRecord,
  review: ReviewRecord,
  installation: InstallationRecord,
): NodeExecutionResult {
  if (installation.verification?.attempted) {
    recordVerificationAttempt(ctx.workflow, review, installation)
  }
  const successNode = successTerminalNode(installation)
  if (successNode) {
    return { kind: 'done', node: successNode, resolution: current, review, installation }
  }
  ctx.workflow.lastFailure = {
    stage: workflowFailureStage(installation),
    code: installation.installFailure?.code ?? installFailureCode(installation),
    message: installation.installFailure?.summary ?? installation.verification.reason,
    retryable: installation.installFailure?.retryable ?? installation.installOutcome === 'failed_absent',
    ...(installation.installFailure?.diagnosticHash
      ? { diagnosticHash: installation.installFailure.diagnosticHash }
      : installation.verification.fixtureDigest
        ? { diagnosticHash: installation.verification.fixtureDigest }
        : {}),
  }
  if (installation.installOutcome === 'failed_absent') {
    return { kind: 'next', node: 'await_confirmation', resolution: current, review, installation }
  }
  return { kind: 'done', node: 'recovery_required', resolution: current, review, installation }
}

async function executeInstallVerify(ctx: GraphContext): Promise<NodeExecutionResult> {
  const current = await requireResolution(ctx)
  const review = await ctx.host.latestReview(
    current.id,
    ctx.workflow.lastReviewId ?? ctx.workflow.lineageTipReviewId,
  )
  const install = ctx.workflow.pendingInstall
  if (!review || !install) {
    throw new EvolutionError('invalid_input', 'Install requires a review and target profile')
  }
  if (alreadyAttemptedVerification(ctx.workflow, review)) {
    const priorInstallationId = ctx.workflow.lastInstallationId ?? ctx.workflow.pendingInstallationId
    const prior = priorInstallationId
      ? await ctx.host.getInstallation(priorInstallationId).catch(() => undefined)
      : undefined
    ctx.workflow.lastFailure = {
      stage: 'verification',
      code: 'verification_already_attempted',
      message: 'This review, source, layer, and fixture digest were already executed in this workflow; Host will not repeat install or verify.',
      retryable: false,
      ...(ctx.workflow.lastFailure?.diagnosticHash
        ? { diagnosticHash: ctx.workflow.lastFailure.diagnosticHash }
        : prior?.verification?.fixtureDigest
          ? { diagnosticHash: prior.verification.fixtureDigest }
          : prior?.installFailure?.diagnosticHash
            ? { diagnosticHash: prior.installFailure.diagnosticHash }
            : {}),
    }
    if (prior && !prior.removed && prior.installOutcome !== 'failed_absent') {
      return { kind: 'done', node: 'recovery_required', resolution: current, review, installation: prior }
    }
    return { kind: 'next', node: 'await_confirmation', resolution: current, review, ...(prior ? { installation: prior } : {}) }
  }
  if (ctx.workflow.pendingInstallationId) {
    const linked = await ctx.host.getInstallation(ctx.workflow.pendingInstallationId).catch((error: unknown) => {
      if (error instanceof EvolutionError && error.code === 'not_found') return undefined
      throw error
    })
    if (linked) {
      assertPendingInstallReceipt(ctx.workflow, review, install, linked)
      return projectLinkedInstallation(ctx, current, review, linked)
    }
  }
  delete ctx.workflow.lastFailure
  try {
    const installation = await ctx.host.installReviewed(review, install, ctx.exec, ctx.workflow)
    return projectLinkedInstallation(ctx, current, review, installation)
  } catch (error) {
    if (error instanceof EvolutionError && error.code === 'invalid_input') throw error
    const recoveryInstallationId = error instanceof EvolutionError
      && error.details.recoveryRequired === true
      && typeof error.details.installationId === 'string'
      && /^installation_[a-f0-9]{16,64}$/u.test(error.details.installationId)
      ? error.details.installationId
      : undefined
    const retryable = !recoveryInstallationId
      && error instanceof EvolutionError
      && error.code === 'command_failed'
    ctx.workflow.lastFailure = {
      stage: 'install',
      code: error instanceof EvolutionError ? error.code : 'command_failed',
      message: error instanceof Error ? error.message : String(error),
      retryable,
      ...(error instanceof EvolutionError
        && typeof error.details.diagnosticHash === 'string'
        && /^[a-f0-9]{64}$/u.test(error.details.diagnosticHash)
        ? { diagnosticHash: error.details.diagnosticHash }
        : {}),
    }
    if (recoveryInstallationId) {
      const installation = await ctx.host.getInstallation(recoveryInstallationId)
      if (installation.workflowId !== ctx.workflow.id) {
        throw new EvolutionError('invalid_input', 'Recovery receipt is not owned by the current workflow')
      }
      if (installation.verification?.attempted) {
        recordVerificationAttempt(ctx.workflow, review, installation)
      }
      return { kind: 'done', node: 'recovery_required', resolution: current, review, installation }
    }
    if (!retryable) recordVerificationAttempt(ctx.workflow, review)
    return { kind: 'next', node: 'await_confirmation', resolution: current, review }
  }
}

async function executeEnableBuiltin(ctx: GraphContext): Promise<NodeExecutionResult> {
  const current = await requireResolution(ctx)
  if (!ctx.host.enableBuiltin) {
    throw new EvolutionError('invalid_input', 'This workflow host does not support built-in capability enablement')
  }
  try {
    if (ctx.workflow.pendingInstallationId) {
      const linked = await ctx.host.getInstallation(ctx.workflow.pendingInstallationId).catch((error: unknown) => {
        if (error instanceof EvolutionError && error.code === 'not_found') return undefined
        throw error
      })
      if (linked) {
        if (linked.workflowId !== ctx.workflow.id) {
          throw new EvolutionError('invalid_input', 'Built-in receipt is not owned by the current workflow')
        }
        if (linked.installPhase === 'completed' && linked.installed) {
          return { kind: 'done', node: builtinTerminalNode(linked), resolution: current, installation: linked }
        }
      }
    }
    const result = await ctx.host.enableBuiltin(ctx.workflow, ctx.exec)
    const installation = result
      ?? await ctx.host.findInstallationForWorkflow?.(ctx.workflow.id)
    return {
      kind: 'done',
      node: builtinTerminalNode(installation),
      resolution: current,
      ...(installation ? { installation } : {}),
    }
  } catch (error) {
    if (ctx.exec.signal?.aborted) throw error
    const linked = ctx.workflow.pendingInstallationId
      ? await ctx.host.getInstallation(ctx.workflow.pendingInstallationId).catch((readError: unknown) => {
          if (readError instanceof EvolutionError && readError.code === 'not_found') return undefined
          throw readError
        })
      : undefined
    if (linked && linked.workflowId !== ctx.workflow.id) {
      throw new EvolutionError('invalid_input', 'Built-in receipt is not owned by the current workflow')
    }
    ctx.workflow.lastFailure = linked?.installFailure ? {
      stage: 'install',
      code: linked.installFailure.code,
      message: linked.installFailure.summary ?? linked.installFailure.message,
      retryable: linked.installFailure.retryable ?? linked.installOutcome === 'failed_absent',
      ...(linked.installFailure.diagnosticHash ? { diagnosticHash: linked.installFailure.diagnosticHash } : {}),
    } : {
      stage: 'install',
      code: error instanceof EvolutionError ? error.code : 'command_failed',
      message: error instanceof Error ? error.message : String(error),
      retryable: error instanceof EvolutionError && error.code === 'command_failed',
      ...(error instanceof EvolutionError
        && typeof error.details.diagnosticHash === 'string'
        && /^[a-f0-9]{64}$/u.test(error.details.diagnosticHash)
        ? { diagnosticHash: error.details.diagnosticHash }
        : {}),
    }
    if (linked?.installOutcome === 'failed_absent') {
      return { kind: 'next', node: 'await_confirmation', resolution: current, installation: linked }
    }
    return {
      kind: 'done',
      node: 'recovery_required',
      resolution: current,
      ...(linked ? { installation: linked } : {}),
    }
  }
}

async function executePrepareModify(ctx: GraphContext): Promise<NodeExecutionResult> {
  const current = await requireResolution(ctx)
  const review = await ctx.host.latestReview(
    current.id,
    ctx.workflow.lastReviewId ?? ctx.workflow.lineageTipReviewId,
  )
  if (!review) {
    throw new EvolutionError('invalid_input', 'modify_this requires a review')
  }
  if (modificationAttemptsExhausted(ctx.workflow.modificationOutcome)) {
    ctx.workflow.lastFailure = {
      stage: 'managed_child',
      code: ctx.workflow.modificationOutcome?.introducedBlockers.length
        ? 'modify_introduced_blocker'
        : 'modify_attempts_exhausted',
      message: ctx.workflow.modificationOutcome?.introducedBlockers.length
        ? 'Host re-review found new blocking modification targets; another construction round will not be started.'
        : 'Modification already used its two Host-bounded attempts. Diagnose or choose a different reviewed action; Host will not start another construction round.',
      retryable: false,
    }
    return { kind: 'next', node: 'await_confirmation', resolution: current, review }
  }
  if (ctx.host.prepareModify) {
    let prepared: Awaited<ReturnType<NonNullable<WorkflowHost['prepareModify']>>>
    try {
      prepared = await ctx.host.prepareModify(current, review, ctx.exec, ctx.workflow)
    } catch (error) {
      if (error instanceof EvolutionError && error.details.recoveryRequired === true) {
        ctx.workflow.lastFailure = {
          stage: 'managed_child',
          code: error.code,
          message: error.message,
          retryable: false,
        }
        const preservedReview = await ctx.host.latestReview(
          current.id,
          ctx.workflow.lineageTipReviewId ?? ctx.workflow.lastReviewId,
        ).catch(() => review) ?? review
        const preservedResolution = await Promise.resolve()
          .then(() => ctx.host.getResolution(current.id))
          .catch(() => current)
        return { kind: 'done', node: 'recovery_required', resolution: preservedResolution, review: preservedReview }
      }
      if (ctx.exec.signal?.aborted
        || (error instanceof EvolutionError
          && error.code !== 'command_failed'
          && error.code !== 'review_rejected')) throw error
      ctx.workflow.lastFailure = {
        stage: managedWorkFailureStage(error),
        code: error instanceof EvolutionError ? error.code : 'command_failed',
        message: error instanceof Error ? error.message : String(error),
        retryable: error instanceof EvolutionError
          && (error.code === 'command_failed' || error.details.managedChildCompleted === true),
      }
      const preservedReview = await ctx.host.latestReview(
        current.id,
        ctx.workflow.lineageTipReviewId ?? ctx.workflow.lastReviewId,
      ).catch(() => review) ?? review
      const preservedResolution = await Promise.resolve()
        .then(() => ctx.host.getResolution(current.id))
        .catch(() => current)
      return error instanceof EvolutionError && error.details.managedChildCompleted === true
        ? { kind: 'next', node: 'await_modify_work', resolution: preservedResolution, review: preservedReview }
        : { kind: 'next', node: 'await_confirmation', resolution: preservedResolution, review: preservedReview }
    }
    if (prepared.path) {
      ctx.workflow.pendingPath = prepared.path
    }
    if (prepared.review) {
      return { kind: 'next', node: 'await_confirmation', resolution: prepared.resolution, review: prepared.review }
    }
    if (prepared.path) {
      return { kind: 'next', node: 'await_modify_work', resolution: prepared.resolution, review }
    }
    return { kind: 'done', node: 'modify_authorized', resolution: prepared.resolution, review }
  }
  return { kind: 'done', node: 'modify_authorized', resolution: current, review }
}

async function executePrepareCreate(ctx: GraphContext): Promise<NodeExecutionResult> {
  const current = await requireResolution(ctx)
  if (ctx.host.prepareCreate) {
    let prepared: Awaited<ReturnType<NonNullable<WorkflowHost['prepareCreate']>>>
    try {
      prepared = await ctx.host.prepareCreate(current, ctx.exec, ctx.workflow)
    } catch (error) {
      if (error instanceof EvolutionError && error.details.recoveryRequired === true) {
        const review = ctx.workflow.lastReviewId
          ? await ctx.host.getReview(ctx.workflow.lastReviewId)
          : undefined
        ctx.workflow.lastFailure = {
          stage: 'managed_child',
          code: error.code,
          message: error.message,
          retryable: false,
        }
        return { kind: 'done', node: 'recovery_required', resolution: current, ...(review ? { review } : {}) }
      }
      if (ctx.exec.signal?.aborted
        || (error instanceof EvolutionError
          && error.code !== 'command_failed'
          && error.code !== 'review_rejected')) throw error
      const review = ctx.workflow.lastReviewId
        ? await ctx.host.getReview(ctx.workflow.lastReviewId)
        : undefined
      if (!review) {
        ctx.workflow.lastFailure = {
          stage: 'managed_child',
          code: error instanceof EvolutionError ? error.code : 'command_failed',
          message: error instanceof Error ? error.message : String(error),
          retryable: error instanceof EvolutionError && error.code === 'command_failed',
        }
        throw error
      }
      ctx.workflow.lastFailure = {
        stage: managedWorkFailureStage(error),
        code: error instanceof EvolutionError ? error.code : 'command_failed',
        message: error instanceof Error ? error.message : String(error),
        retryable: error instanceof EvolutionError
          && (error.code === 'command_failed' || error.details.managedChildCompleted === true),
      }
      return error instanceof EvolutionError && error.details.managedChildCompleted === true
        ? { kind: 'next', node: 'await_modify_work', resolution: current, review }
        : { kind: 'next', node: 'await_confirmation', resolution: current, review }
    }
    if (prepared.path) {
      ctx.workflow.pendingPath = prepared.path
    }
    if (prepared.review) {
      return { kind: 'next', node: 'await_confirmation', resolution: prepared.resolution, review: prepared.review }
    }
    if (prepared.path) {
      return { kind: 'next', node: 'await_modify_work', resolution: prepared.resolution }
    }
    return { kind: 'done', node: 'create_authorized', resolution: prepared.resolution }
  }
  return { kind: 'done', node: 'create_authorized', resolution: current }
}

async function requireResolution(ctx: GraphContext): Promise<ResolutionRecord> {
  if (ctx.resolution) return ctx.resolution
  if (!ctx.workflow.resolutionId) {
    throw new EvolutionError('invalid_input', 'Workflow is missing a resolution')
  }
  return ctx.host.getResolution(ctx.workflow.resolutionId)
}
