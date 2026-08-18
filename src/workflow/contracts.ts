import type {
  InstallationRecord,
  InstallationRetention,
  ResolutionRecord,
  ReviewRecord,
  WorkflowOptionId,
} from '../contracts.js'

export type WorkflowStatus = 'running' | 'interrupted' | 'completed' | 'failed'

export type WorkflowNodeId =
  | 'resolve_local'
  | 'discover_remote'
  | 'ensure_market'
  | 'await_selection'
  | 'review_github'
  | 'await_confirmation'
  | 'prepare_modify'
  | 'await_modify_work'
  | 'review_local'
  | 'install_verify'
  | 'prepare_create'
  | 'reuse_local'
  | 'stopped'
  | 'market_restart_required'
  | 'installed'
  | 'recovery_required'
  | 'create_authorized'
  | 'modify_authorized'

export type InterruptKind = 'await_selection' | 'await_confirmation' | 'await_modify_work'

export interface WorkflowOption {
  id: WorkflowOptionId
  labelEn: string
  labelZh: string
}

export interface InterruptPayload {
  kind: InterruptKind
  interruptId: string
  ownerSessionId: string
  bootId: string
  validAfterTurnId: string
  snapshotDigest: string
  options: WorkflowOption[]
  facts: Record<string, unknown>
}

export interface WorkflowPendingInstall {
  targetProfile: string
  retention: InstallationRetention
  verificationTask?: string
  verificationExpectedText?: string
}

export interface WorkflowRecord {
  schemaVersion: 1
  id: string
  policyVersion: string
  createdAt: string
  updatedAt: string
  requirement: string
  requirementNormalized?: string
  cwd?: string
  ownerSessionId?: string
  bootId?: string
  resolutionId?: string
  status: WorkflowStatus
  cursor: WorkflowNodeId
  generation: number
  interrupt?: InterruptPayload
  consumedInterruptIds?: string[]
  lineageTipReviewId?: string
  lastReviewId?: string
  lastInstallationId?: string
  forceRemoteDiscovery?: boolean
  pendingRepositories?: string[]
  pendingRef?: string
  pendingPath?: string
  pendingInstall?: WorkflowPendingInstall
  managedSourceId?: string
  lastFailure?: { code: string; message: string }
  error?: { code: string; message: string }
}

export interface WorkflowView {
  workflow: WorkflowRecord
  resolution?: ResolutionRecord
  review?: ReviewRecord
  installation?: InstallationRecord
  nextStep?: string
}

export interface ValidatedResume {
  optionId: WorkflowOptionId
  userMessage: string
  hostTurnId: string
  interruptId: string
  repositories: string[]
  path?: string
  ref?: string
  reviewId?: string
  install?: WorkflowPendingInstall
}

export interface MarketplaceStepResult {
  status: 'loaded' | 'restart' | 'empty'
  reason: string
}

export interface WorkflowHost {
  bootstrapResolution(requirement: string, exec: WorkflowExec): Promise<ResolutionRecord>
  discoverRemote(resolution: ResolutionRecord, exec: WorkflowExec): Promise<ResolutionRecord>
  ensureMarket(resolution: ResolutionRecord, exec: WorkflowExec): Promise<{
    resolution: ResolutionRecord
    market: MarketplaceStepResult
  }>
  reviewGithub(
    resolution: ResolutionRecord,
    repository: string,
    ref: string | undefined,
    exec: WorkflowExec,
  ): Promise<{ resolution: ResolutionRecord; review: ReviewRecord }>
  reviewLocal(
    resolution: ResolutionRecord,
    path: string,
    baseReviewId: string,
    exec: WorkflowExec,
  ): Promise<{ resolution: ResolutionRecord; review: ReviewRecord }>
  installReviewed(
    review: ReviewRecord,
    input: WorkflowPendingInstall,
    exec: WorkflowExec,
  ): Promise<InstallationRecord>
  prepareModify?(
    resolution: ResolutionRecord,
    review: ReviewRecord,
    exec: WorkflowExec,
    workflow: WorkflowRecord,
  ): Promise<{ resolution: ResolutionRecord; path?: string; review?: ReviewRecord }>
  prepareCreate?(
    resolution: ResolutionRecord,
    exec: WorkflowExec,
    workflow: WorkflowRecord,
  ): Promise<{ resolution: ResolutionRecord; path?: string; review?: ReviewRecord }>
  applyDecision(
    resolution: ResolutionRecord,
    resume: ValidatedResume,
    review?: ReviewRecord,
  ): Promise<ResolutionRecord>
  latestReview(resolutionId: string, reviewId?: string): Promise<ReviewRecord | undefined>
  getResolution(id: string): Promise<ResolutionRecord>
  getReview(id: string): Promise<ReviewRecord>
  getInstallation(id: string): Promise<InstallationRecord>
  listInstallProfiles?(): Promise<string[]>
  releaseManagedSource?(workflow: WorkflowRecord, exec: WorkflowExec): Promise<void>
}

export interface WorkflowExec {
  agent?: import('@deepseek-ai/dsh-agent').Agent
  signal?: AbortSignal
  callId?: string
}

export const INTERRUPT_NODES: ReadonlySet<WorkflowNodeId> = new Set([
  'await_selection',
  'await_confirmation',
  'await_modify_work',
])

export const TERMINAL_NODES: ReadonlySet<WorkflowNodeId> = new Set([
  'reuse_local',
  'stopped',
  'market_restart_required',
  'installed',
  'recovery_required',
  'create_authorized',
  'modify_authorized',
])

export const WORKFLOW_OPTIONS: Record<WorkflowOptionId, WorkflowOption> = {
  inspect: { id: 'inspect', labelEn: 'Inspect this repository', labelZh: '审查这个仓库' },
  search_more: { id: 'search_more', labelEn: 'Search for plugins anyway', labelZh: '继续找插件' },
  use_local: { id: 'use_local', labelEn: 'Use existing local capability', labelZh: '用已有的本地能力' },
  create_new: { id: 'create_new', labelEn: 'Create new', labelZh: '新建' },
  stop: { id: 'stop', labelEn: 'Stop for now', labelZh: '先停' },
  use_this: { id: 'use_this', labelEn: 'Use this plugin', labelZh: '用这个' },
  modify_this: { id: 'modify_this', labelEn: 'Improve this plugin', labelZh: '在这个上改' },
}

export function isWorkflowOptionId(value: string): value is WorkflowOptionId {
  return Object.hasOwn(WORKFLOW_OPTIONS, value)
}

export function isInterruptKind(value: string | undefined): value is InterruptKind {
  return value === 'await_selection' || value === 'await_confirmation' || value === 'await_modify_work'
}

export function selectionFacts(resolution: ResolutionRecord): Record<string, unknown> {
  return {
    localCandidates: resolution.localCandidates,
    remoteCandidates: resolution.remoteCandidates,
    reasons: resolution.reasons,
    queries: resolution.queries,
    remoteDiscoveryComplete: resolution.remoteDiscoveryComplete,
    ...(resolution.remoteCandidateSource ? { remoteCandidateSource: resolution.remoteCandidateSource } : {}),
  }
}

export function confirmationFacts(
  resolution: ResolutionRecord,
  review: ReviewRecord,
  extras: { lastFailure?: WorkflowRecord['lastFailure']; installProfiles?: string[] } = {},
): Record<string, unknown> {
  return {
    reviewId: review.id,
    fit: review.fit,
    securityRisk: review.securityRisk,
    recommendation: review.recommendation,
    missingCapabilities: review.missingCapabilities,
    findings: review.findings,
    sourceSnapshot: review.sourceSnapshot,
    selectedRepositories: resolution.selectedRepositories ?? [],
    license: review.license,
    compatibility: review.compatibility,
    ...(extras.lastFailure ? { lastFailure: extras.lastFailure } : {}),
    ...(extras.installProfiles && extras.installProfiles.length > 0
      ? { installProfiles: extras.installProfiles }
      : {}),
  }
}

export function modifyWorkFacts(review: ReviewRecord): Record<string, unknown> {
  const source = review.sourceSnapshot
  return {
    reviewId: review.id,
    commit: source.kind === 'github' ? source.commit : source.baseCommit,
    instruction: 'Modification continues in a managed workspace-write child session. Wait for the next confirmation interrupt; do not supply a local path.',
    ...(source.kind === 'github' ? { repository: source.repository } : { path: source.path }),
  }
}

export function createWorkFacts(path: string): Record<string, unknown> {
  return {
    path,
    instruction: 'Creation continues in a managed workspace-write child session on the trusted scaffold. Wait for the next confirmation interrupt; do not call cordis_define on the parent session.',
  }
}

export function optionsFor(kind: InterruptKind, resolution: ResolutionRecord): WorkflowOption[] {
  if (kind === 'await_modify_work') {
    return [WORKFLOW_OPTIONS.stop]
  }
  const options: WorkflowOption[] = []
  if (kind === 'await_selection' && resolution.remoteCandidates.length > 0) options.push(WORKFLOW_OPTIONS.inspect)
  if (kind === 'await_confirmation') {
    options.push(WORKFLOW_OPTIONS.use_this, WORKFLOW_OPTIONS.modify_this)
    if (resolution.remoteCandidates.length > 0) options.push(WORKFLOW_OPTIONS.inspect)
  }
  if (resolution.localCandidates.length > 0) options.push(WORKFLOW_OPTIONS.use_local)
  options.push(WORKFLOW_OPTIONS.search_more, WORKFLOW_OPTIONS.create_new, WORKFLOW_OPTIONS.stop)
  return options
}
