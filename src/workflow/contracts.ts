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
  VerificationLayerKind,
  WorkflowOptionId,
} from '../contracts.js'
import { creatorAgentFacts, type CreatorRecord } from '../creator-foundation.js'
import { isDirectlyUsableReview } from '../review/direct-use.js'
import { needsSemanticReviewer } from '../review/review.js'
import { hashObject } from '../state/hashes.js'
import { boundedAgentText } from './sanitize.js'
import type { WorkflowLifecycleState } from './lifecycle.js'

export type { CreatorRecord }

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
  | 'await_discovery'
  | 'await_selection'
  | 'review_github'
  | 'await_confirmation'
  | 'prepare_modify'
  | 'await_modify_work'
  | 'complete_managed_work'
  | 'review_local'
  | 'install_verify'
  | 'prepare_create'
  | 'reuse_local'
  | 'stopped'
  | 'market_restart_required'
  | 'market_setup_required'
  | 'installed'
  | 'activated'
  | 'awaiting_user_test'
  | 'restart_required'
  | 'recovery_required'
  | 'create_authorized'
  | 'modify_authorized'

export type InterruptKind = 'await_selection' | 'await_confirmation' | 'await_modify_work' | 'await_recovery'

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
  availability?: 'available' | 'available_via_tool_search' | 'installed_in_profile'
  fit?: 'full' | 'partial' | 'none'
  installation?: {
    source: 'host_profile_manifest'
    profile: string
    package_name: string
    dependency_spec: string
    configured_bundle: boolean
  }
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

export interface DiscoveryBudget {
  refinementRoundsUsed: number
  refinementQueriesUsed: string[]
  explicitRepositories: string[]
  maxRefinementRounds: 2
  maxRefinementQueries: 5
  maxCandidates: 20
}

export interface DiscoveryRefineInput {
  workflowId: string
  queries?: string[]
  repositories?: string[]
}

export interface DiscoveryPresentInput {
  workflowId: string
  candidateIds: string[]
}

export type DiagnosticProbe =
  | 'discovery'
  | 'review'
  | 'installation'
  | 'verification'
  | 'managed_child'
  | 'cleanup'

export interface WorkflowDiagnoseInput {
  workflowId: string
  probes: DiagnosticProbe[]
}

export interface DiagnosticFact {
  probe: DiagnosticProbe
  status: 'pass' | 'failed' | 'unknown' | 'skipped'
  code: string
  summary: string
  observed: boolean
  evidenceHash?: string
  facts?: Record<string, boolean | number | string | string[]>
}

export interface WorkflowDiagnosis {
  createdAt: string
  probes: DiagnosticProbe[]
  facts: DiagnosticFact[]
  budget: {
    maxCalls: 2
    usedCalls: number
    maxProbes: 8
    usedProbes: number
    maxRecordReads: 4
    usedRecordReads: number
  }
}

export interface InvalidResumeAttempt {
  hostTurnId: string
  fingerprint: string
  count: number
}

export interface WorkflowRecoveryInput {
  workflowId: string
  /** Required for sealed recovery_required interrupts. Omit for completed-install restart. */
  interruptId?: string
}

export interface WorkflowRecoveryRecord {
  action: 'cleanup_and_restart'
  hostTurnId: string
  cleanup: 'not_required' | 'already_removed' | 'removed'
  installationId?: string
  restartRequired: boolean
  restartedAsWorkflowId: string
  completedAt: string
}

export type WorkflowFailureStage =
  | 'discovery'
  | 'review'
  | 'managed_child'
  | 'install'
  | 'verification'
  | 'hot_load'
  | 'workflow'

export interface WorkflowFailure {
  stage: WorkflowFailureStage
  code: string
  message: string
  retryable: boolean
  diagnosticHash?: string
}

export interface ModificationBlocker {
  key: string
  kind: 'compatibility' | 'missing_capability' | 'security_finding' | 'host_boundary'
  summary: string
}

export type ModificationCheckStatus = 'passed' | 'failed' | 'skipped' | 'unknown' | 'unavailable'

export interface ModificationCheckEvidence {
  source: 'host_observed' | 'child_reported' | 'unknown'
  status: ModificationCheckStatus
  summary: string
}

export interface ModificationAttemptEvidence {
  attempt: number
  childSessionId: string
  commit: string
  changedFiles: string[]
  changedFilesTruncated: boolean
  postReviewId: string
  completionMarkerObserved: boolean
  checks: ModificationCheckEvidence
}

/** Compact/interrupt facts for a child or Host check. Distinguishes unavailable tools from assertion failure. */
export function modificationCheckModelFacts(
  checks: ModificationCheckEvidence | undefined,
): Record<string, unknown> | undefined {
  if (!checks) return undefined
  return {
    source: checks.source,
    status: checks.status,
    summary: boundedAgentText(checks.summary, 300),
    ...(checks.status === 'unavailable' ? {
      meaning: 'Checks could not run because the local toolchain was unavailable; the plugin is not verified.',
    } : {}),
  }
}

export interface ModificationOutcome {
  contractVersion: 1
  policyVersion: string
  baselineReviewId: string
  instructionHash?: string
  baselineRuntimeVersion: string | null
  maxAttempts: 2
  automaticCorrectionUsed: boolean
  status: 'resolved' | 'unresolved' | 'indeterminate'
  attempts: ModificationAttemptEvidence[]
  resolvedBlockers: ModificationBlocker[]
  unresolvedBlockers: ModificationBlocker[]
  introducedBlockers: ModificationBlocker[]
}

export interface ConsumedVerificationAttempt {
  reviewId: string
  sourceIdentity: string
  layer: string
  fixtureDigest?: string
}

export const INSTALL_SUCCESS_OUTCOMES = ['verified', 'activated', 'awaiting_user_test'] as const

export const COMPLETED_CLEANUP_NODES: ReadonlySet<WorkflowNodeId> = new Set([
  'installed',
  'activated',
  'awaiting_user_test',
  'restart_required',
])

export function reviewSourceIdentity(review: Pick<ReviewRecord, 'sourceSnapshot'>): string {
  const source = review.sourceSnapshot
  return source.kind === 'github'
    ? `github:${source.repository.toLowerCase()}#${source.commit}`
    : `local:${source.statusHash}`
}

export function verificationAttemptKey(
  review: Pick<ReviewRecord, 'id' | 'sourceSnapshot' | 'runtimeSurface'>,
  extras: { layer?: string; fixtureDigest?: string } = {},
): string {
  return hashObject({
    reviewId: review.id,
    sourceIdentity: reviewSourceIdentity(review),
    layer: extras.layer ?? review.runtimeSurface?.verificationLayer ?? 'unspecified',
    ...(extras.fixtureDigest ? { fixtureDigest: extras.fixtureDigest } : {}),
  })
}

export function sameVerificationAttempt(
  attempt: ConsumedVerificationAttempt,
  review: Pick<ReviewRecord, 'id' | 'sourceSnapshot' | 'runtimeSurface'>,
  extras: { layer?: VerificationLayerKind | string; fixtureDigest?: string } = {},
): boolean {
  if (attempt.reviewId !== review.id) return false
  if (attempt.sourceIdentity !== reviewSourceIdentity(review)) return false
  const layer = extras.layer ?? review.runtimeSurface?.verificationLayer
  if (layer && attempt.layer !== 'unspecified' && layer !== 'unspecified' && attempt.layer !== layer) {
    return false
  }
  if (attempt.fixtureDigest && extras.fixtureDigest && attempt.fixtureDigest !== extras.fixtureDigest) {
    return false
  }
  return true
}

export function modificationAttemptsExhausted(outcome: ModificationOutcome | undefined): boolean {
  if (!outcome || outcome.status === 'resolved') return false
  return outcome.attempts.length >= outcome.maxAttempts || outcome.introducedBlockers.length > 0
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
  /** Host-verified candidates available for model curation before Gate 1. */
  discoveryPool?: CandidateSnapshotItem[]
  discoveryBudget?: DiscoveryBudget
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
  pendingWorkOrder?: import('../creator-foundation.js').CreatorWorkOrder
  pendingInstall?: WorkflowPendingInstall
  managedSourceId?: string
  modificationOutcome?: ModificationOutcome
  /** Optional bounded Creator foundation records. Absent on schemaVersion 1/2 legacy JSON. */
  creatorRecords?: CreatorRecord[]
  lastFailure?: WorkflowFailure
  lastDiagnosis?: WorkflowDiagnosis
  invalidResumeAttempt?: InvalidResumeAttempt
  consumedVerificationAttempts?: ConsumedVerificationAttempt[]
  completionTurnId?: string
  recovery?: WorkflowRecoveryRecord
  recoveredFromWorkflowId?: string
  error?: { code: string; message: string }
}

export type WorkflowViewStatus = 'progressed' | 'parked' | 'invalid_resume'

export interface AgentShortlistItem {
  index: number
  candidate_id: string
  name: string
  repository?: string
  why?: string
  fit?: string
  recommendation?: string
}

export interface AgentLegalActions {
  navigation: WorkflowOptionId[]
  decision: WorkflowOptionId[]
}

export interface WorkflowView {
  workflow: WorkflowRecord
  /** Public lifecycle presentation. Internal `workflow.cursor` remains the graph cursor. */
  lifecycleState: WorkflowLifecycleState
  resolution?: ResolutionRecord
  review?: ReviewRecord
  reviews?: ReviewRecord[]
  installation?: InstallationRecord
  diagnosis?: WorkflowDiagnosis
  nextStep?: string
  /** Model-facing outcome. `parked` and `invalid_resume` are successful tool results, not errors. */
  status?: WorkflowViewStatus
  phase?: InterruptKind | WorkflowNodeId
  shortlist?: AgentShortlistItem[]
  legal?: AgentLegalActions
  agentDirective?: string
  alreadyWaiting?: boolean
  resumeHint?: string
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
  refineRemote?(
    resolution: ResolutionRecord,
    input: { queries: string[]; repositories: string[] },
    exec: WorkflowExec,
  ): Promise<ResolutionRecord>
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
  finishManagedWork?(
    resolution: ResolutionRecord,
    exec: WorkflowExec,
    workflow: WorkflowRecord,
  ): Promise<{ resolution: ResolutionRecord; path?: string; review?: ReviewRecord; continueConstruction?: boolean }>
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
  cleanupInstallation?(installationId: string, exec: WorkflowExec): Promise<{
    installationId: string
    removed: boolean
    restartRequired: boolean
  }>
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
])

/** Model-controlled checkpoints. They are not user decision gates. */
export const MODEL_CONTROL_NODES: ReadonlySet<WorkflowNodeId> = new Set([
  'await_discovery',
  'await_modify_work',
])

export const TERMINAL_NODES: ReadonlySet<WorkflowNodeId> = new Set([
  'reuse_local',
  'stopped',
  'market_restart_required',
  'market_setup_required',
  'installed',
  'activated',
  'awaiting_user_test',
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
  finish_managed_work: { id: 'finish_managed_work', labelEn: 'Finish in-session construction', labelZh: '完成当前会话中的修改', placement: 'primary' },
}

export function isWorkflowOptionId(value: string): value is WorkflowOptionId {
  return Object.hasOwn(WORKFLOW_OPTIONS, value)
}

export function isInterruptKind(value: string | undefined): value is InterruptKind {
  return value === 'await_selection'
    || value === 'await_confirmation'
    || value === 'await_recovery'
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

function compactConfirmationFindings(review: ReviewRecord): {
  findings: ReturnType<typeof securityFindingFacts>
  findingDetails: ReturnType<typeof securityFindingFacts>
} {
  const grouped = securityFindingFacts(review.findings)
  const top = grouped.find((item) => item.severity === 'block') ?? grouped[0]
  return {
    findings: top ? [top] : [],
    findingDetails: grouped,
  }
}

export function confirmationFacts(
  resolution: ResolutionRecord,
  reviews: ReviewRecord[],
  workflow?: WorkflowRecord,
  extras: { lastFailure?: WorkflowRecord['lastFailure']; installProfiles?: string[] } = {},
): Record<string, unknown> {
  const review = reviews[0]
  const compact = review ? compactConfirmationFindings(review) : undefined
  const reviewLayer = review?.runtimeSurface?.verificationLayer
  const lastChecks = workflow?.modificationOutcome?.attempts.at(-1)?.checks
  const modificationChecks = modificationCheckModelFacts(lastChecks)
  return {
    ...(review ? {
      reviewId: review.id,
      fit: review.fit,
      securityRisk: review.securityRisk,
      recommendation: review.recommendation,
      canInstall: isDirectlyUsableReview(review, workflow),
      missingCapabilities: review.missingCapabilities,
      verificationLayer: reviewLayer ?? 'manual_runtime',
      ...(reviewLayer === 'manual_runtime' ? {
        installRetentionRule: 'This candidate verifies only at manual_runtime: install requires retention persistent, skips the sandboxed trial, and ends awaiting a manual user test in the target client or profile.',
      } : {}),
      findings: compact?.findings ?? [],
      findingDetails: compact?.findingDetails ?? [],
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
      verificationLayer: item.runtimeSurface?.verificationLayer ?? 'manual_runtime',
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
    verificationAlreadyAttempted: Boolean(
      review && (workflow?.consumedVerificationAttempts ?? []).some((item) => sameVerificationAttempt(item, review)),
    ),
    modificationAttemptsExhausted: modificationAttemptsExhausted(workflow?.modificationOutcome),
    ...(modificationChecks ? { modificationChecks } : {}),
    ...(creatorAgentFacts(workflow?.creatorRecords) ? { creator: creatorAgentFacts(workflow?.creatorRecords) } : {}),
    ...(extras.installProfiles && extras.installProfiles.length > 0
      ? { installProfiles: extras.installProfiles }
      : {}),
  }
}

export function modifyWorkFacts(review: ReviewRecord, workflow?: WorkflowRecord): Record<string, unknown> {
  const source = review.sourceSnapshot
  return {
    reviewId: review.id,
    commit: source.kind === 'github' ? source.commit : source.baseCommit,
    instruction: 'Modification continues in this session on the Host-managed source. Edit files there, then finish construction; do not install or commit.',
    ...(source.kind === 'github' ? { repository: source.repository } : {}),
    ...(creatorAgentFacts(workflow?.creatorRecords) ? { creator: creatorAgentFacts(workflow?.creatorRecords) } : {}),
  }
}

export function createWorkFacts(workflow?: WorkflowRecord): Record<string, unknown> {
  return {
    instruction: 'Creation continues in this session on the Host-managed scaffold. Edit files there, then finish construction; do not call cordis_define or install.',
    ...(creatorAgentFacts(workflow?.creatorRecords) ? { creator: creatorAgentFacts(workflow?.creatorRecords) } : {}),
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
    const consumed = workflow?.consumedVerificationAttempts ?? []
    const usableIds = reviews.filter((item) => isDirectlyUsableReview(item, workflow)
      && !consumed.some((attempt) => sameVerificationAttempt(attempt, item)))
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
    if (repairableIds.length > 0 && !modificationAttemptsExhausted(workflow?.modificationOutcome)) {
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
