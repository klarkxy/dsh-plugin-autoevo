import type { ResolutionRecord, ReviewRecord } from './contracts.js'
import {
  appendCreatorRecord,
  assertCreatorReceipt,
  assertWorkOrderScope,
  createCreatorWorkOrder,
  mintCreatorReceipt,
  type CreatorFoundation,
  type CreatorFoundationPreflight,
  type CreatorFoundationReceipt,
  type CreatorOperation,
} from './creator-foundation.js'
import { EvolutionError } from './errors.js'
import { reviewLocalPlugin } from './review/index.js'
import {
  authenticatedModificationInstruction,
  hasMeaningfulModificationInstruction,
  modificationAcceptance,
  modificationBlockers,
  modificationWorkOrder,
} from './service-modification.js'
import {
  dshRuntimeVersion,
  reviewAndFreezeManagedSource,
  type ReviewOrchestrationDeps,
} from './service-review.js'
import {
  sourceIdForCreate,
  sourceIdForRepository,
  type SourceReceipt,
} from './source-manager.js'
import { hashObject } from './state/hashes.js'
import type {
  ModificationAttemptEvidence,
  ModificationOutcome,
  WorkflowExec,
  WorkflowRecord,
} from './workflow/contracts.js'

export interface ManagedWorkDeps extends ReviewOrchestrationDeps {
  creatorFoundation: CreatorFoundation
}

export function requireParentAgent(exec: WorkflowExec): NonNullable<WorkflowExec['agent']> {
  if (!exec.agent) {
    throw new EvolutionError('invalid_input', 'A live parent Agent session is required for managed modify/create')
  }
  return exec.agent
}

export function rememberCreator(
  workflow: WorkflowRecord,
  operation: CreatorOperation,
  status: 'verified' | 'unavailable',
  receipt?: CreatorFoundationReceipt,
): void {
  workflow.creatorRecords = appendCreatorRecord(workflow.creatorRecords, {
    operation,
    status,
    createdAt: new Date().toISOString(),
    ...(receipt ? { receipt } : {}),
  })
}

export async function preflightCreator(
  deps: Pick<ManagedWorkDeps, 'creatorFoundation' | 'store'>,
  workflow: WorkflowRecord,
  operation: CreatorOperation,
  exec: WorkflowExec,
): Promise<CreatorFoundationPreflight> {
  try {
    const parent = requireParentAgent(exec)
    return await deps.creatorFoundation.preflight({
      ...(exec.signal ? { signal: exec.signal } : {}),
      parentCtx: parent.ctx,
      parentScope: parent,
    })
  } catch (error) {
    rememberCreator(workflow, operation, 'unavailable')
    workflow.updatedAt = new Date().toISOString()
    await deps.store.put('workflows', workflow)
    throw error
  }
}

export async function preserveCancelledManagedWork(
  deps: Pick<ManagedWorkDeps, 'sources'>,
  input: {
    sourceId: string
    workflowId: string
    reviewId: string
    cause: unknown
  },
): Promise<never> {
  let checkpoint: SourceReceipt
  try {
    // Cancellation belongs to the user turn, not to Host cleanup.  Checkpoint
    // with the runner's own bounded timeout so an already-aborted signal
    // cannot strand a dirty tree behind a live workflow lock.
    checkpoint = await deps.sources.preserveInterruptedChild({
      sourceId: input.sourceId,
      workflowId: input.workflowId,
      reviewId: input.reviewId,
    })
  } catch (preserveError) {
    throw new EvolutionError(
      'command_failed',
      'Managed child was cancelled and its edits require explicit source recovery',
      {
        recoveryRequired: true,
        cancelled: true,
        sourceId: input.sourceId,
        childDiagnostic: hashObject({ cause: input.cause instanceof Error ? input.cause.message : String(input.cause) }),
        preserveDiagnostic: hashObject({ cause: preserveError instanceof Error ? preserveError.message : String(preserveError) }),
      },
    )
  }
  throw new EvolutionError(
    'command_failed',
    'Managed child was cancelled; its bounded edits were checkpointed for recovery',
    {
      recoveryRequired: true,
      cancelled: true,
      sourceId: input.sourceId,
      branch: checkpoint.branch,
      headCommit: checkpoint.headCommit,
    },
  )
}

export async function prepareManagedModification(
  deps: ManagedWorkDeps,
  resolution: ResolutionRecord,
  review: ReviewRecord,
  exec: WorkflowExec,
  workflow: WorkflowRecord,
): Promise<{ resolution: ResolutionRecord; path?: string; review?: ReviewRecord }> {
  const preflight = await preflightCreator(deps, workflow, 'modify', exec)
  let sourceKey = workflow.managedSourceId
  if (!sourceKey && review.sourceSnapshot.kind === 'local') {
    const managed = await deps.sources.receiptForManagedPath(review.sourceSnapshot.path)
    if (!managed || managed.reviewId !== review.id) {
      throw new EvolutionError('invalid_input', 'Local review is not the current tip of a managed source')
    }
    sourceKey = managed.sourceId
  }
  let receipt: SourceReceipt
  if (sourceKey) {
    const completed = await deps.sources.inspectCompletedSource(sourceKey, exec.signal)
    if (completed) {
      if (completed.reviewId !== review.id) {
        throw new EvolutionError('invalid_input', 'Completed managed source is not the current reviewed tip')
      }
      receipt = await deps.sources.claimCompletedSourceForWorkflow(sourceKey, workflow.id, exec.signal)
    } else {
      receipt = await deps.sources.resumeWorkflowSource(sourceKey, workflow.id, exec.signal)
    }
  } else if (review.sourceSnapshot.kind === 'github') {
    sourceKey = sourceIdForRepository(review.sourceSnapshot.repository)
    const completed = await deps.sources.inspectCompletedSource(sourceKey, exec.signal)
    const reuseHere = Boolean(completed
      && completed.repository?.toLowerCase() === review.sourceSnapshot.repository.toLowerCase()
      && completed.headCommit.toLowerCase() === review.sourceSnapshot.commit.toLowerCase()
      && deps.sources.pathUnderSourceRoot(completed.path, resolution.cwd))
    if (reuseHere && completed) {
      receipt = await deps.sources.claimCompletedSourceForWorkflow(sourceKey, workflow.id, exec.signal)
    } else {
      receipt = await deps.sources.materializeReviewedGithub({
        review,
        workflowId: workflow.id,
        workspaceCwd: resolution.cwd,
        ...(exec.signal ? { signal: exec.signal } : {}),
      })
    }
  } else {
    throw new EvolutionError('invalid_input', 'Local modification requires a managed source receipt')
  }
  workflow.managedSourceId = sourceKey
  const parent = requireParentAgent(exec)
  const workOrder = modificationWorkOrder(
    resolution,
    review,
    receipt.path,
    undefined,
    false,
    workflow.candidateSnapshot?.find((item) => item.evolutionTarget)?.evolutionTarget?.kind,
  )
  await deps.store.put('reviews', review)
  workflow.pendingPath = receipt.path
  workflow.pendingWorkOrder = workOrder
  rememberCreator(workflow, workOrder.operation, 'verified', mintCreatorReceipt(preflight, parent.id))
  workflow.updatedAt = new Date().toISOString()
  await deps.store.put('workflows', workflow)
  return { resolution, path: receipt.path }
}

export async function prepareManagedCreation(
  deps: ManagedWorkDeps,
  resolution: ResolutionRecord,
  exec: WorkflowExec,
  workflow: WorkflowRecord,
): Promise<{ resolution: ResolutionRecord; path?: string; review?: ReviewRecord }> {
  const preflight = await preflightCreator(deps, workflow, 'create', exec)
  const sourceKey = sourceIdForCreate(resolution.id)
  const receipt = await deps.sources.initializeCreateSource({
    resolutionId: resolution.id,
    workflowId: workflow.id,
    workspaceCwd: resolution.cwd,
    ...(exec.signal ? { signal: exec.signal } : {}),
  })
  workflow.managedSourceId = sourceKey
  let reviewId = `scaffold_${hashObject({ sourceId: sourceKey, head: receipt.baseCommit }).slice(0, 24)}`
  try {
    const scaffoldBaseId = `review_${hashObject({ sourceId: sourceKey, head: receipt.baseCommit }).slice(0, 64)}`
    const runtimeVersion = await dshRuntimeVersion(deps, resolution.cwd, exec.signal)
    const scaffold = await reviewLocalPlugin({
      runner: deps.runner,
      config: deps.config,
      workspaceRoot: deps.sources.sourceRootFor(resolution.cwd),
      path: receipt.path,
      baseReviewId: scaffoldBaseId,
      lineageRootCommit: receipt.baseCommit,
      resolutionId: resolution.id,
      requirement: resolution.requirement,
      ...(runtimeVersion ? { runtimeVersion } : {}),
    })
    reviewId = scaffold.record.id
    await deps.store.put('reviews', scaffold.record)
    workflow.lastReviewId = scaffold.record.id
    workflow.lineageTipReviewId = scaffold.record.id
    const workOrder = createCreatorWorkOrder({
      operation: 'create',
      requirement: resolution.requirement,
      cwd: receipt.path,
      acceptanceTargets: [
        'Implement the requirement on the trusted scaffold as a complete DSH plugin bundle',
        'Add focused tests or self-checks where practical',
        'Do not install, publish, or claim success from this construction phase',
      ],
    })
    const parent = requireParentAgent(exec)
    workflow.pendingPath = receipt.path
    workflow.pendingWorkOrder = workOrder
    rememberCreator(workflow, 'create', 'verified', mintCreatorReceipt(preflight, parent.id))
    workflow.updatedAt = new Date().toISOString()
    await deps.store.put('workflows', workflow)
    return { resolution, path: receipt.path }
  } catch (error) {
    rememberCreator(workflow, 'create', 'unavailable')
    workflow.updatedAt = new Date().toISOString()
    await deps.store.put('workflows', workflow)
    if (!exec.signal?.aborted) throw error
    return await preserveCancelledManagedWork(deps, {
      sourceId: sourceKey,
      workflowId: workflow.id,
      reviewId,
      cause: error,
    })
  }
}

export async function finishManagedWork(
  deps: ManagedWorkDeps,
  resolution: ResolutionRecord,
  exec: WorkflowExec,
  workflow: WorkflowRecord,
): Promise<{ resolution: ResolutionRecord; path?: string; review?: ReviewRecord; continueConstruction?: boolean }> {
  const sourceKey = workflow.managedSourceId
  const cwd = workflow.pendingPath
  const workOrder = workflow.pendingWorkOrder
  if (!sourceKey || !cwd || !workOrder) {
    throw new EvolutionError('invalid_input', 'In-session construction is missing a Host-managed source and work order')
  }
  if (exec.signal?.aborted) {
    rememberCreator(workflow, workOrder.operation, 'unavailable')
    workflow.updatedAt = new Date().toISOString()
    await deps.store.put('workflows', workflow)
    return await preserveCancelledManagedWork(deps, {
      sourceId: sourceKey,
      workflowId: workflow.id,
      reviewId: workOrder.baselineReview?.reviewId ?? workflow.lineageTipReviewId ?? workflow.lastReviewId ?? 'unknown',
      cause: new EvolutionError('command_failed', 'Managed construction was cancelled'),
    })
  }
  assertWorkOrderScope(workOrder, cwd)
  const parent = requireParentAgent(exec)
  const preflight = await preflightCreator(deps, workflow, workOrder.operation, exec)
  const receipt = mintCreatorReceipt(preflight, parent.id)
  assertCreatorReceipt(receipt, preflight)
  rememberCreator(workflow, workOrder.operation, 'verified', receipt)
  const baselineReviewId = workOrder.baselineReview?.reviewId
    ?? workflow.lineageTipReviewId
    ?? workflow.lastReviewId
  if (!baselineReviewId) {
    throw new EvolutionError('invalid_input', 'In-session construction is missing a baseline review')
  }
  const baselineReview = await deps.store.getReview(baselineReviewId)
  const source = await deps.sources.readReceipt(sourceKey)
  if (!source || source.activeWorkflowId !== workflow.id) {
    throw new EvolutionError('invalid_input', 'Managed source is not owned by this workflow')
  }
  try {
    const committed = await deps.sources.finalizeChildCommit({
      sourceId: sourceKey,
      workflowId: workflow.id,
      reviewId: baselineReview.id,
      message: workOrder.operation === 'create'
        ? `feat: implement AutoEvo workflow ${workflow.id}`
        : workOrder.operation === 'correct'
          ? `fix: complete AutoEvo workflow ${workflow.id}`
          : `fix: satisfy AutoEvo workflow ${workflow.id}`,
      ...(exec.signal ? { signal: exec.signal } : {}),
    })
    const finalized = await reviewAndFreezeManagedSource(deps, {
      resolution,
      sourceId: sourceKey,
      path: source.path,
      baseReviewId: baselineReview.id,
      lineageRootCommit: source.baseCommit,
      workflowId: workflow.id,
      exec,
    })
    const attempt = (workflow.modificationOutcome?.attempts.length ?? 0) + 1
    if (workOrder.operation === 'create') {
      delete workflow.pendingWorkOrder
      workflow.lastReviewId = finalized.review.id
      workflow.lineageTipReviewId = finalized.review.id
      workflow.updatedAt = new Date().toISOString()
      await deps.store.put('workflows', workflow)
      return { ...finalized, path: source.path }
    }
    const baselineBlockers = modificationBlockers(
      workflow.modificationOutcome
        ? await deps.store.getReview(workflow.modificationOutcome.baselineReviewId)
        : baselineReview,
    )
    const outcomeBaseline = workflow.modificationOutcome
      ? await deps.store.getReview(workflow.modificationOutcome.baselineReviewId)
      : baselineReview
    const instruction = authenticatedModificationInstruction(resolution, outcomeBaseline)
    const meaningfulInstruction = hasMeaningfulModificationInstruction(instruction)
    const attempts: ModificationAttemptEvidence[] = [
      ...(workflow.modificationOutcome?.attempts ?? []),
      {
        attempt,
        childSessionId: parent.id,
        commit: committed.headCommit,
        changedFiles: committed.changedFiles,
        changedFilesTruncated: committed.changedFilesTruncated,
        postReviewId: finalized.review.id,
        completionMarkerObserved: true,
        checks: {
          source: 'unknown',
          status: 'unknown',
          summary: 'Host did not independently observe a test command result.',
        },
      },
    ]
    const acceptance = modificationAcceptance({
      baselineReview: outcomeBaseline,
      baselineBlockers,
      postReview: finalized.review,
      meaningfulInstruction,
      attempt,
    })
    const outcome: ModificationOutcome = {
      contractVersion: 1,
      policyVersion: outcomeBaseline.policyVersion,
      baselineReviewId: outcomeBaseline.id,
      ...(meaningfulInstruction ? { instructionHash: hashObject(instruction) } : {}),
      baselineRuntimeVersion: outcomeBaseline.compatibility.runtimeVersion,
      maxAttempts: 2,
      automaticCorrectionUsed: attempt > 1,
      status: acceptance.status,
      attempts,
      resolvedBlockers: acceptance.resolved,
      unresolvedBlockers: acceptance.unresolved,
      introducedBlockers: acceptance.introduced,
    }
    workflow.modificationOutcome = outcome
    workflow.lastReviewId = finalized.review.id
    workflow.lineageTipReviewId = finalized.review.id
    if (outcome.status === 'unresolved' && !acceptance.canCorrect) {
      workflow.lastFailure = {
        stage: 'review',
        code: acceptance.introduced.length > 0 ? 'modify_introduced_blocker' : 'modify_targets_unresolved',
        message: acceptance.introduced.length > 0
          ? `Host re-review found ${acceptance.introduced.length} new blocking modification target(s); automatic correction stopped without expanding scope.`
          : `Host re-review still reports ${acceptance.unresolved.length} original modification target(s) after one focused correction.`,
        retryable: false,
      }
    } else {
      delete workflow.lastFailure
    }
    if (acceptance.canCorrect) {
      workflow.pendingWorkOrder = modificationWorkOrder(
        finalized.resolution,
        outcomeBaseline,
        source.path,
        acceptance.unresolved,
        true,
      )
      workflow.pendingPath = source.path
      workflow.updatedAt = new Date().toISOString()
      await deps.store.put('workflows', workflow)
      return { ...finalized, path: source.path, continueConstruction: true }
    }
    delete workflow.pendingWorkOrder
    workflow.updatedAt = new Date().toISOString()
    await deps.store.put('workflows', workflow)
    return { ...finalized, path: source.path }
  } catch (error) {
    rememberCreator(workflow, workOrder.operation, 'unavailable')
    workflow.updatedAt = new Date().toISOString()
    await deps.store.put('workflows', workflow)
    if (!exec.signal?.aborted) throw error
    return await preserveCancelledManagedWork(deps, {
      sourceId: sourceKey,
      workflowId: workflow.id,
      reviewId: baselineReviewId,
      cause: error,
    })
  }
}
