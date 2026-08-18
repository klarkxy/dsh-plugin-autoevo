import type { InstallationRecord, ResolutionRecord, ReviewRecord, WorkflowOptionId } from '../contracts.js'
import { EvolutionError } from '../errors.js'
import {
  confirmationFacts,
  modifyWorkFacts,
  optionsFor,
  selectionFacts,
  type InterruptKind,
  type InterruptPayload,
  type WorkflowExec,
  type WorkflowHost,
  type WorkflowNodeId,
  type WorkflowRecord,
} from './contracts.js'

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
  installation?: InstallationRecord
}

const TRANSITIONS: Partial<Record<WorkflowNodeId, Partial<Record<WorkflowOptionId, WorkflowNodeId>>>> = {
  await_selection: {
    inspect: 'review_github',
    search_more: 'discover_remote',
    use_local: 'reuse_local',
    create_new: 'prepare_create',
    stop: 'stopped',
  },
  await_confirmation: {
    use_this: 'install_verify',
    modify_this: 'prepare_modify',
    inspect: 'review_github',
    search_more: 'discover_remote',
    use_local: 'reuse_local',
    create_new: 'prepare_create',
    stop: 'stopped',
  },
  await_modify_work: {
    stop: 'stopped',
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
  resolution: ResolutionRecord,
  review?: ReviewRecord,
  extras: { lastFailure?: WorkflowRecord['lastFailure']; installProfiles?: string[] } = {},
): Omit<InterruptPayload, 'interruptId' | 'ownerSessionId' | 'bootId' | 'validAfterTurnId' | 'snapshotDigest'> {
  if (cursor === 'await_selection') {
    return {
      kind: 'await_selection',
      options: optionsFor('await_selection', resolution),
      facts: selectionFacts(resolution),
    }
  }
  if (cursor === 'await_confirmation') {
    if (!review) {
      throw new EvolutionError('invalid_input', 'Confirmation interrupt requires a review')
    }
    return {
      kind: 'await_confirmation',
      options: optionsFor('await_confirmation', resolution),
      facts: confirmationFacts(resolution, review, extras),
    }
  }
  if (cursor === 'await_modify_work') {
    if (!review) {
      throw new EvolutionError('invalid_input', 'Modify-work interrupt requires a review')
    }
    return {
      kind: 'await_modify_work',
      options: optionsFor('await_modify_work', resolution),
      facts: modifyWorkFacts(review),
    }
  }
  throw new EvolutionError('invalid_input', 'Not an interrupt node', { cursor })
}

export function interruptKind(cursor: WorkflowNodeId): InterruptKind | undefined {
  if (cursor === 'await_selection' || cursor === 'await_confirmation' || cursor === 'await_modify_work') {
    return cursor
  }
  return undefined
}

export async function executeNode(node: WorkflowNodeId, ctx: GraphContext): Promise<NodeExecutionResult> {
  if (node === 'resolve_local') return executeResolveLocal(ctx)
  if (node === 'discover_remote') return executeDiscoverRemote(ctx)
  if (node === 'ensure_market') return executeEnsureMarket(ctx)
  if (node === 'review_github') return executeReviewGithub(ctx)
  if (node === 'review_local') return executeReviewLocal(ctx)
  if (node === 'install_verify') return executeInstallVerify(ctx)
  if (node === 'prepare_modify') return executePrepareModify(ctx)
  if (node === 'prepare_create') return executePrepareCreate(ctx)
  throw new EvolutionError('invalid_input', 'No automatic implementation for this workflow node', { node })
}

async function executeResolveLocal(ctx: GraphContext): Promise<NodeExecutionResult> {
  const resolution = await ctx.host.bootstrapResolution(ctx.workflow.requirement, ctx.exec)
  ctx.workflow.resolutionId = resolution.id
  ctx.workflow.cwd = resolution.cwd
  const shouldDiscover = ctx.workflow.forceRemoteDiscovery || resolution.decision !== 'use_local'
  return {
    kind: 'next',
    node: shouldDiscover ? 'discover_remote' : 'await_selection',
    resolution,
  }
}

async function executeDiscoverRemote(ctx: GraphContext): Promise<NodeExecutionResult> {
  const current = await requireResolution(ctx)
  const resolution = await ctx.host.discoverRemote(current, ctx.exec)
  ctx.workflow.forceRemoteDiscovery = false
  if (resolution.remoteCandidateSource === 'marketplace-setup') {
    return { kind: 'next', node: 'ensure_market', resolution }
  }
  return { kind: 'next', node: 'await_selection', resolution }
}

async function executeEnsureMarket(ctx: GraphContext): Promise<NodeExecutionResult> {
  const current = await requireResolution(ctx)
  const { resolution, market } = await ctx.host.ensureMarket(current, ctx.exec)
  if (market.status === 'loaded') return { kind: 'next', node: 'discover_remote', resolution }
  if (market.status === 'empty') return { kind: 'next', node: 'await_selection', resolution }
  return { kind: 'done', node: 'market_restart_required', resolution }
}

async function executeReviewGithub(ctx: GraphContext): Promise<NodeExecutionResult> {
  const current = await requireResolution(ctx)
  const selected = ctx.workflow.pendingRepositories?.length
    ? ctx.workflow.pendingRepositories
    : current.selectedRepositories ?? []
  if (selected.length !== 1 || !selected[0]) {
    throw new EvolutionError('invalid_input', 'inspect requires exactly one repository')
  }
  const repository = selected[0]
  const { resolution, review } = await ctx.host.reviewGithub(
    current,
    repository,
    ctx.workflow.pendingRef,
    ctx.exec,
  )
  return { kind: 'next', node: 'await_confirmation', resolution, review }
}

async function executeReviewLocal(ctx: GraphContext): Promise<NodeExecutionResult> {
  const current = await requireResolution(ctx)
  const path = ctx.workflow.pendingPath
  const baseReviewId = ctx.workflow.lineageTipReviewId ?? ctx.workflow.lastReviewId
  if (!path || !baseReviewId) {
    throw new EvolutionError('invalid_input', 'Local re-review requires a checkout path and a lineage tip')
  }
  const { resolution, review } = await ctx.host.reviewLocal(current, path, baseReviewId, ctx.exec)
  return { kind: 'next', node: 'await_confirmation', resolution, review }
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
  delete ctx.workflow.lastFailure
  try {
    const installation = await ctx.host.installReviewed(review, install, ctx.exec)
    return { kind: 'done', node: 'installed', resolution: current, review, installation }
  } catch (error) {
    if (error instanceof EvolutionError && error.code === 'invalid_input') throw error
    ctx.workflow.lastFailure = {
      code: error instanceof EvolutionError ? error.code : 'command_failed',
      message: error instanceof Error ? error.message : String(error),
    }
    return { kind: 'next', node: 'await_confirmation', resolution: current, review }
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
  if (ctx.host.prepareModify) {
    const prepared = await ctx.host.prepareModify(current, review, ctx.exec, ctx.workflow)
    if (prepared.path) {
      ctx.workflow.pendingPath = prepared.path
      ctx.workflow.managedSourceId = prepared.path
    }
    if (prepared.deferred) {
      return { kind: 'next', node: 'await_modify_work', resolution: prepared.resolution, review }
    }
    if (prepared.path) {
      return { kind: 'next', node: 'review_local', resolution: prepared.resolution, review }
    }
    return { kind: 'done', node: 'modify_authorized', resolution: prepared.resolution, review }
  }
  return { kind: 'done', node: 'modify_authorized', resolution: current, review }
}

async function executePrepareCreate(ctx: GraphContext): Promise<NodeExecutionResult> {
  const current = await requireResolution(ctx)
  if (ctx.host.prepareCreate) {
    const prepared = await ctx.host.prepareCreate(current, ctx.exec, ctx.workflow)
    if (prepared.path) {
      ctx.workflow.pendingPath = prepared.path
      ctx.workflow.managedSourceId = prepared.path
    }
    if (prepared.deferred) {
      return { kind: 'next', node: 'await_modify_work', resolution: prepared.resolution }
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
