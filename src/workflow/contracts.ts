import type {
  ActionCommitment,
  AuthorizationAction,
  ExecutionLease,
  InstallationRecord,
  InstallationRetention,
  NavigationInput,
  ResolutionRecord,
  ReviewFinding,
  ReviewMode,
  ReviewRecord,
  SelectionReceipt,
  WorkflowOptionId,
} from '../contracts.js'
import { isDirectlyUsableReview } from '../review/direct-use.js'
import { needsSemanticReviewer } from '../review/review.js'
import type { WorkflowLifecycleState } from './lifecycle.js'

export type { WorkflowLifecycleState }

export interface SecurityFindingFact {
  code: string
  severity: ReviewFinding['severity']
  detail: string
  sources: string[]
  evidenceHashes: string[]
  evidenceKind: 'static_review'
  observed: true
  notEstablished: string[]
}

/**
 * Group repeated source/build observations for Agent presentation only.
 * Raw ReviewRecord findings remain untouched for fail-closed policy and audit.
 */
export function securityFindingFacts(findings: readonly ReviewFinding[]): SecurityFindingFact[] {
  const grouped = new Map<string, SecurityFindingFact>()
  for (const item of findings) {
    const key = `${item.code}\u0000${item.severity}\u0000${item.detail}`
    const current = grouped.get(key) ?? {
      code: item.code,
      severity: item.severity,
      detail: item.detail,
      sources: [],
      evidenceHashes: [],
      evidenceKind: 'static_review' as const,
      observed: true as const,
      notEstablished: item.code === 'process_execution' || item.code === 'child_process'
        ? ['command target', 'purpose', 'necessity', 'runtime execution', 'callback server behavior']
        : [],
    }
    if (!current.sources.includes(item.source)) current.sources.push(item.source)
    if (item.evidenceHash && !current.evidenceHashes.includes(item.evidenceHash)) {
      current.evidenceHashes.push(item.evidenceHash)
    }
    grouped.set(key, current)
  }
  return [...grouped.values()].map((item) => ({
    ...item,
    sources: item.sources.sort((left, right) => left.localeCompare(right)),
    evidenceHashes: item.evidenceHashes.sort((left, right) => left.localeCompare(right)),
  })).sort((left, right) => left.code.localeCompare(right.code) || left.detail.localeCompare(right.detail))
}

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
  | 'market_setup_required'
  | 'installed'
  | 'restart_required'
  | 'recovery_required'
  | 'create_authorized'
  | 'modify_authorized'

export type InterruptKind = 'await_selection' | 'await_confirmation' | 'await_modify_work'

export type WorkflowOptionPlacement = 'primary' | 'advanced' | 'recovery'

export interface WorkflowOption {
  id: WorkflowOptionId
  labelEn: string
  labelZh: string
  /** When present, the action is valid only for these interrupt-bound snapshot candidates. */
  candidateIds?: string[]
  /** Presentation group only. Does not change Host authorization. */
  placement?: WorkflowOptionPlacement
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

export interface CandidateSnapshotItem {
  id: string
  index: number
  kind: 'local' | 'remote'
  name: string
  identity: string
  digest: string
  repository?: string
  localName?: string
  localKind?: 'tool' | 'skill' | 'plugin'
  availability?: 'available' | 'available_via_tool_search'
  fit?: 'full' | 'partial' | 'none'
}

export interface ReviewPlan {
  mode: ReviewMode
  candidateIds: string[]
  maxReviews: 1 | 2 | 3
}

export interface ReviewFailure {
  candidateId: string
  code: string
  message: string
}

export interface WorkflowRecord {
  schemaVersion: 1 | 2
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
  candidateSnapshot?: CandidateSnapshotItem[]
  seenCandidateIds?: string[]
  rejectedCandidateIds?: string[]
  selectionReceipt?: SelectionReceipt
  actionCommitment?: ActionCommitment
  executionLease?: ExecutionLease
  reviewPlan?: ReviewPlan
  reviewQueue?: string[]
  reviewedCandidateIds?: string[]
  reviewIdsByCandidate?: Record<string, string>
  reviewFailures?: ReviewFailure[]
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
  /** Public lifecycle presentation. Internal `workflow.cursor` remains the graph cursor. */
  lifecycleState: WorkflowLifecycleState
  resolution?: ResolutionRecord
  review?: ReviewRecord
  reviews?: ReviewRecord[]
  installation?: InstallationRecord
  nextStep?: string
}

export interface ValidatedResume {
  optionId: AuthorizationAction
  userMessage: string
  hostTurnId: string
  interruptId: string
  snapshotDigest: string
  candidateId?: string
  repositories: string[]
  path?: string
  ref?: string
  reviewId?: string
  install?: WorkflowPendingInstall
}

export interface MarketplaceStepResult {
  status: 'loaded' | 'restart' | 'blocked' | 'empty'
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
    workflow?: WorkflowRecord,
  ): Promise<{ resolution: ResolutionRecord; review: ReviewRecord }>
  reviewGithubBatch?(
    resolution: ResolutionRecord,
    repositories: string[],
    mode: ReviewMode,
    exec: WorkflowExec,
    workflow?: WorkflowRecord,
  ): Promise<{
    resolution: ResolutionRecord
    reviews: ReviewRecord[]
    failures: Array<{ repository: string; code: string; message: string }>
  }>
  reviewLocal(
    resolution: ResolutionRecord,
    path: string,
    baseReviewId: string,
    exec: WorkflowExec,
    workflow?: WorkflowRecord,
  ): Promise<{ resolution: ResolutionRecord; review: ReviewRecord }>
  installReviewed(
    review: ReviewRecord,
    input: WorkflowPendingInstall,
    exec: WorkflowExec,
    workflow?: WorkflowRecord,
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
    workflow?: WorkflowRecord,
  ): Promise<ResolutionRecord>
  applyNavigation?(
    resolution: ResolutionRecord,
    navigation: NavigationInput,
    repositories: string[],
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
  'market_setup_required',
  'installed',
  'restart_required',
  'recovery_required',
  'create_authorized',
  'modify_authorized',
])

export const WORKFLOW_OPTIONS: Record<WorkflowOptionId, WorkflowOption> = {
  review_candidates: { id: 'review_candidates', labelEn: 'Review selected candidates', labelZh: '审查选中的候选', placement: 'primary' },
  search_more: { id: 'search_more', labelEn: 'Search for plugins anyway', labelZh: '继续找插件', placement: 'primary' },
  reuse_local: { id: 'reuse_local', labelEn: 'Use existing local capability', labelZh: '用已有的本地能力', placement: 'primary' },
  create_new: { id: 'create_new', labelEn: 'Create new', labelZh: '新建', placement: 'advanced' },
  stop: { id: 'stop', labelEn: 'Stop for now', labelZh: '先停', placement: 'recovery' },
  use_this: { id: 'use_this', labelEn: 'Use this plugin', labelZh: '用这个', placement: 'primary' },
  modify_this: { id: 'modify_this', labelEn: 'Improve this plugin', labelZh: '在这个上改', placement: 'advanced' },
}

export function isWorkflowOptionId(value: string): value is WorkflowOptionId {
  return Object.hasOwn(WORKFLOW_OPTIONS, value)
}

export function isInterruptKind(value: string | undefined): value is InterruptKind {
  return value === 'await_selection' || value === 'await_confirmation' || value === 'await_modify_work'
}

export function selectionFacts(resolution: ResolutionRecord, workflow?: WorkflowRecord): Record<string, unknown> {
  return {
    candidateSnapshot: workflow?.candidateSnapshot ?? [],
    seenCandidateIds: workflow?.seenCandidateIds ?? [],
    rejectedCandidateIds: workflow?.rejectedCandidateIds ?? [],
    recommendedReviewPlan: {
      mode: 'adaptive',
      maxReviews: Math.min(3, workflow?.candidateSnapshot?.filter((item) => item.kind === 'remote').length ?? 0),
    },
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
  reviews: ReviewRecord[],
  workflow?: WorkflowRecord,
  extras: { lastFailure?: WorkflowRecord['lastFailure']; installProfiles?: string[] } = {},
): Record<string, unknown> {
  const review = reviews[0]
  return {
    ...(review ? {
      reviewId: review.id,
      fit: review.fit,
      securityRisk: review.securityRisk,
      recommendation: review.recommendation,
      missingCapabilities: review.missingCapabilities,
      findings: securityFindingFacts(review.findings),
      securityInterpretationRule: 'Security findings are static review observations only. Treat sources and details as observed facts; purpose, necessity, command target, runtime execution, and callback-server behavior are unknown unless separately verified. Never invent a justification for a finding.',
      sourceSnapshot: review.sourceSnapshot,
    } : {}),
    reviews: reviews.map((item) => ({
      reviewId: item.id,
      repository: item.sourceSnapshot.kind === 'github' ? item.sourceSnapshot.repository : undefined,
      fit: item.fit,
      securityRisk: item.securityRisk,
      recommendation: item.recommendation,
      compatibility: item.compatibility,
      installable: Boolean(item.installSpec),
      missingCapabilities: item.missingCapabilities,
      semanticReviewRequired: needsSemanticReviewer(item),
      directUseEligible: isDirectlyUsableReview(item, workflow),
      ...(item.reviewerVerdict ? { reviewerDecision: item.reviewerVerdict.decision } : {}),
    })),
    candidateSnapshot: workflow?.candidateSnapshot ?? [],
    reviewedCandidateIds: workflow?.reviewedCandidateIds ?? [],
    remainingCandidateIds: (workflow?.candidateSnapshot ?? [])
      .filter((item) => item.kind === 'remote' && !(workflow?.reviewedCandidateIds ?? []).includes(item.id))
      .map((item) => item.id),
    reviewFailures: workflow?.reviewFailures ?? [],
    selectedRepositories: resolution.selectedRepositories ?? [],
    ...(review ? { license: review.license, compatibility: review.compatibility } : {}),
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

export function optionsFor(
  kind: InterruptKind,
  resolution: ResolutionRecord,
  reviews: ReviewRecord[] = [],
  workflow?: WorkflowRecord,
  installProfiles: string[] = [],
): WorkflowOption[] {
  if (kind === 'await_modify_work') {
    return [WORKFLOW_OPTIONS.stop]
  }
  const options: WorkflowOption[] = []
  const snapshot = workflow?.candidateSnapshot ?? []
  const remoteSnapshot = snapshot.filter((item) => item.kind === 'remote')
  const remainingIds = remoteSnapshot
    .filter((item) => !(workflow?.reviewedCandidateIds ?? []).includes(item.id))
    .map((item) => item.id)
  const fullLocalIds = snapshot
    .filter((item) => item.kind === 'local' && item.fit === 'full')
    .map((item) => item.id)
  if (kind === 'await_selection' && remoteSnapshot.length > 0) {
    options.push({ ...WORKFLOW_OPTIONS.review_candidates, candidateIds: remoteSnapshot.map((item) => item.id) })
  }
  if (kind === 'await_confirmation') {
    const candidateIdFor = (review: ReviewRecord): string | undefined => {
      const mapped = Object.entries(workflow?.reviewIdsByCandidate ?? {})
        .find(([, reviewId]) => reviewId === review.id)?.[0]
      if (mapped) return mapped
      const source = review.sourceSnapshot
      return source.kind === 'github'
        ? remoteSnapshot.find((item) => item.repository?.toLowerCase() === source.repository.toLowerCase())?.id
        : undefined
    }
    const usableIds = reviews.filter((item) => isDirectlyUsableReview(item, workflow))
      .map(candidateIdFor).filter((id): id is string => Boolean(id))
    const repairableIds = reviews.filter((item) => item.fit !== 'none' && item.license !== null)
      .map(candidateIdFor).filter((id): id is string => Boolean(id))
    if (usableIds.length > 0 && installProfiles.length > 0) {
      options.push({ ...WORKFLOW_OPTIONS.use_this, candidateIds: usableIds })
    }
    options.push(WORKFLOW_OPTIONS.search_more)
    if (remainingIds.length > 0) {
      options.push({ ...WORKFLOW_OPTIONS.review_candidates, candidateIds: remainingIds })
    }
    if (fullLocalIds.length > 0) {
      options.push({ ...WORKFLOW_OPTIONS.reuse_local, candidateIds: fullLocalIds })
    }
    if (repairableIds.length > 0) {
      options.push({ ...WORKFLOW_OPTIONS.modify_this, candidateIds: repairableIds })
    }
    if (resolution.remoteDiscoveryComplete) options.push(WORKFLOW_OPTIONS.create_new)
    options.push(WORKFLOW_OPTIONS.stop)
    return options
  }
  if (fullLocalIds.length > 0) {
    options.push({ ...WORKFLOW_OPTIONS.reuse_local, candidateIds: fullLocalIds })
  }
  options.push(WORKFLOW_OPTIONS.search_more)
  options.push(WORKFLOW_OPTIONS.stop)
  return options
}
