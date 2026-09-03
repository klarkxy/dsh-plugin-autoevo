import type {
  ActionCommitment,
  AuthorizationAction,
  EvolutionTarget,
  InstallationRecord,
  InstallFailureRecovery,
  InstallRecoveryPlan,
  InstallationRetention,
  NavigationInput,
  RequestIntent,
  ResolutionRecord,
  ReviewFinding,
  ReviewMode,
  ReviewRecord,
  SelectionReceipt,
  VerificationLayerKind,
  WorkflowOptionId,
} from '../contracts.js'
import { creatorAgentFacts, type CreatorRecord, type HostObservedCheck } from '../creator-foundation.js'
import { EvolutionError } from '../errors.js'
import { isDirectlyUsableReview, isManagedModificationEligibleReview } from '../review/direct-use.js'
import { requiresSemanticContext } from '../review/review.js'
import { hashObject } from '../state/hashes.js'
import { boundedAgentText } from './sanitize.js'
import type { WorkflowLifecycleState } from './lifecycle.js'

export type { CreatorRecord, HostObservedCheck }

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
  | 'await_clarification'
  | 'resolve_local'
  | 'discover_remote'
  | 'ensure_market'
  | 'await_discovery'
  | 'await_selection'
  | 'review_github'
  | 'review_existing'
  | 'await_confirmation'
  | 'prepare_modify'
  | 'await_modify_work'
  | 'complete_managed_work'
  | 'review_local'
  | 'install_verify'
  | 'prepare_create'
  | 'reuse_local'
  | 'enable_builtin'
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
  | 'superseded'

export type InterruptKind = 'await_clarification' | 'await_selection' | 'await_confirmation' | 'await_modify_work' | 'await_recovery'

export type WorkflowOptionPlacement = 'primary' | 'advanced' | 'recovery'

export interface WorkflowOption {
  id: WorkflowOptionId
  labelEn: string
  labelZh: string
  /** When present, the action is valid only for these interrupt-bound snapshot candidates. */
  candidateIds?: string[]
  /** Agent-selectable Host-sealed recovery plans. Only apply_recovery uses these ids. */
  recoveryIds?: string[]
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
  replacement?: import('../contracts.js').ReplacementTarget
  /** Host-derived from the sealed interrupt after the Agent selects its id. */
  recoveryPlan?: InstallRecoveryPlan
}

export interface RetryableInstallContext {
  reviewId: string
  recoveryPlans?: InstallRecoveryPlan[]
  recovery?: InstallFailureRecovery
  /** The previous receipt already consumed a sealed recovery; never offer the same install path again. */
  recoveryExhausted?: true
}

export interface CandidateSnapshotItem {
  id: string
  index: number
  kind: 'local' | 'remote'
  name: string
  identity: string
  digest: string
  repository?: string
  /** Normalized repository-relative package root; empty/absent is the root. */
  packagePath?: string
  commit?: string
  localName?: string
  localKind?: 'tool' | 'skill' | 'plugin'
  availability?: import('../contracts.js').CandidateAvailability
  fit?: 'full' | 'partial' | 'none'
  semanticFit?: 'full' | 'partial' | 'none'
  surfaceMatch?: boolean
  reuseEligible?: boolean
  evolutionTarget?: EvolutionTarget
  hostBundled?: {
    packageName: string
    version: string
    mountId: string
  }
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
  activeTurnId?: string
  activeTurnQueriesUsed: string[]
  maxQueriesPerTurn: 5
  /** Legacy persisted per-turn cap from schemaVersion 3 records that predate maxQueriesPerTurn. */
  maxRefinementQueries?: 5
  /** Bounded rolling window; semantic relevance never removes an eligible result. */
  maxCandidates: 113
}

export interface CandidatePreview {
  candidateId: string
  repository: string
  commit: string
  defaultBranch: string
  packagePath?: string
  inspectedFiles: Array<{ path: string; sha256: string; bytes: number }>
  truncated: boolean
  manifest: {
    kind: 'bundle' | 'skill' | 'legacy' | 'unknown'
    packageName?: string
    packageVersion?: string
    bundlePatch?: string
    license?: string
  }
  packageSummary?: {
    description?: string
    keywords?: string[]
  }
  readmeExcerpt?: string
}

export interface CandidatePreviewFailure {
  candidateId: string
  repository: string
  code: string
  message: string
  /** Normalized repository-relative package roots that may be retried exactly. */
  packagePaths?: string[]
}

export interface DiscoveryRefineInput {
  workflowId: string
  queries?: string[]
  repositories?: string[]
}

export interface DiscoveryPresentInput {
  workflowId: string
  candidateIds: string[]
  /** Optional retry selector for a collection repository with more than five bundles. */
  packageSelectors?: Array<{ candidateId: string; packagePath: string }>
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
  /** Fixed restart plan used to finish child publication after cancellation/crash. */
  restart?: {
    requirement: string
    normalized: string
    cwd: string
    intent: RequestIntent
  }
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
  hostObservedChecks?: HostObservedCheck[]
}

export interface ModificationAttemptEvidence {
  attempt: number
  childSessionId: string
  commit: string
  changedFiles: string[]
  changedFilesTruncated: boolean
  postReviewId?: string
  completionMarkerObserved: boolean
  checks: ModificationCheckEvidence
}

function compactObservedChecks(checks: readonly HostObservedCheck[] | undefined): Record<string, unknown>[] | undefined {
  if (!checks?.length) return undefined
  return checks.slice(0, 8).map((item) => ({
    command: boundedAgentText(item.command, 180),
    exit_code: item.exitCode,
    matches_acceptance: item.matchesAcceptance,
  }))
}

/** Compact/interrupt facts for a child or Host check. Distinguishes unavailable tools from assertion failure. */
export function modificationCheckModelFacts(
  checks: ModificationCheckEvidence | undefined,
): Record<string, unknown> | undefined {
  if (!checks) return undefined
  const observed = compactObservedChecks(checks.hostObservedChecks)
  return {
    source: checks.source,
    status: checks.status,
    summary: boundedAgentText(checks.summary, 300),
    ...(checks.status === 'unavailable' ? {
      meaning: 'Checks could not run because the local toolchain was unavailable; the plugin is not verified.',
    } : {}),
    ...(observed ? { host_observed_checks: observed } : {}),
  }
}

/** Host-minted modification attempt ceiling. Legacy receipts may still store 2. */
export const MODIFICATION_MAX_ATTEMPTS = 3

export interface ModificationOutcome {
  contractVersion: 1
  policyVersion: string
  baselineReviewId: string
  instructionHash?: string
  baselineRuntimeVersion: string | null
  maxAttempts: 2 | 3
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
    ? `github:${source.repository.toLowerCase()}#${source.commit}${source.packagePath ? `:path/${source.packagePath}` : ''}`
    : `local:${source.statusHash}`
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
  schemaVersion: 1 | 2 | 3
  id: string
  policyVersion: string
  createdAt: string
  updatedAt: string
  requirement: string
  requirementNormalized?: string
  /** Non-authoritative model summary retained only for diagnostics/search presentation. */
  requestSummary?: string
  /** Exact Host-owned search input: original requirement plus one searchable clarification answer. Option-only replies and the protocol label are omitted. */
  searchRequirement?: string
  /** Host-normalized LLM search plan for baseline remote discovery. Never part of the authoritative requirement or refinement budget. */
  discoveryQueries?: string[]
  clarificationQuestion?: string
  clarificationAnswer?: string
  clarifiedIntent?: RequestIntent
  startedTurnId?: string
  supersededByWorkflowId?: string
  supersededAt?: string
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
  /** Host-minted installation receipt linked before the external install command starts. */
  pendingInstallationId?: string
  lastInstallationId?: string
  forceRemoteDiscovery?: boolean
  /** Host-verified candidates available for model curation before Gate 1. */
  discoveryPool?: CandidateSnapshotItem[]
  /** Bounded untrusted previews for the shortlist selected by the Agent. */
  candidatePreviews?: Record<string, CandidatePreview>
  candidatePreviewFailures?: CandidatePreviewFailure[]
  discoveryBudget?: DiscoveryBudget
  candidateSnapshot?: CandidateSnapshotItem[]
  seenCandidateIds?: string[]
  rejectedCandidateIds?: string[]
  selectionReceipt?: SelectionReceipt
  actionCommitment?: ActionCommitment
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
  /** A Host-created commit exists and must be re-reviewed before another child edit is requested. */
  managedCommitPendingReview?: boolean
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
  intent?: RequestIntent
  pendingReviewedCandidateId?: string
}

/** Identify one legacy verification entry that was consumed before verification began. */
export function retryablePreVerificationReviewId(
  workflow: WorkflowRecord,
  installation: InstallationRecord,
): string | undefined {
  if (workflow.status !== 'interrupted'
    || workflow.cursor !== 'await_confirmation'
    || workflow.lastFailure?.stage !== 'install'
    || workflow.lastFailure.retryable !== true
    || workflow.lastInstallationId !== installation.id
    || installation.workflowId !== workflow.id
    || !installation.reviewId
    || installation.installOutcome !== 'failed_absent'
    || installation.installed
    || installation.installFailure?.stage !== 'install'
    || installation.installFailure.retryable !== true
    || installation.verification?.attempted !== false) {
    return undefined
  }
  return installation.reviewId
}

export function retryableInstallContext(
  workflow: WorkflowRecord,
  installation: InstallationRecord,
): RetryableInstallContext | undefined {
  const reviewId = retryablePreVerificationReviewId(workflow, installation)
  if (!reviewId) return undefined
  const recovery = installation.installFailure?.recovery
  const diagnosticHash = installation.installFailure?.diagnosticHash
  if (installation.recoveryAttempt) {
    return { reviewId, ...(recovery ? { recovery } : {}), recoveryExhausted: true }
  }
  if (recovery?.kind === 'profile_store_mismatch') {
    if (!recovery.reuseEligible
      || recovery.scope !== 'host_profile'
      || !recovery.profileStoreFingerprint
      || !/^[a-f0-9]{64}$/u.test(recovery.profileStoreFingerprint)
      || !diagnosticHash
      || !/^[a-f0-9]{64}$/u.test(diagnosticHash)) {
      return { reviewId, recovery }
    }
    const plan: InstallRecoveryPlan = {
      id: `recovery_${hashObject({
        workflowId: workflow.id,
        installationId: installation.id,
        reviewId,
        diagnosticHash,
        profileStoreFingerprint: recovery.profileStoreFingerprint,
      }).slice(0, 24)}`,
      operation: 'retry_install',
      strategy: 'profile_store_reuse',
      sourceInstallationId: installation.id,
      diagnosticHash,
      profileStoreFingerprint: recovery.profileStoreFingerprint,
      effectScope: 'single_install_command',
    }
    return { reviewId, recovery, recoveryPlans: [plan] }
  }
  if (recovery?.kind !== 'minimum_release_age') {
    return { reviewId, ...(recovery ? { recovery } : {}) }
  }
  if (!recovery.exceptionEligible
    || recovery.scope !== 'host_profile'
    || !diagnosticHash
    || !/^[a-f0-9]{64}$/u.test(diagnosticHash)) {
    return { reviewId, recovery }
  }
  const plan: InstallRecoveryPlan = {
    id: `recovery_${hashObject({
      workflowId: workflow.id,
      installationId: installation.id,
      reviewId,
      diagnosticHash,
      exactPackages: recovery.entries.map((entry) => `${entry.packageName}@${entry.version}`).sort(),
    }).slice(0, 24)}`,
    operation: 'retry_install',
    strategy: 'minimum_release_age_exception',
    sourceInstallationId: installation.id,
    diagnosticHash,
    exactPackages: recovery.entries.map((entry) => `${entry.packageName}@${entry.version}`).sort(),
    effectScope: 'single_install_command',
  }
  return {
    reviewId,
    recovery,
    recoveryPlans: [plan],
  }
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
  recoveryId?: string
  repositories: string[]
  path?: string
  ref?: string
  reviewId?: string
  install?: WorkflowPendingInstall
}

export interface WorkflowHost {
  bootstrapResolution(requirement: string, exec: WorkflowExec, intent?: RequestIntent): Promise<ResolutionRecord>
  discoverRemote(
    resolution: ResolutionRecord,
    exec: WorkflowExec,
    input?: { queries?: string[] },
  ): Promise<ResolutionRecord>
  refineRemote(
    resolution: ResolutionRecord,
    input: { queries: string[]; repositories: string[] },
    exec: WorkflowExec,
  ): Promise<ResolutionRecord>
  previewGithubCandidates(
    resolution: ResolutionRecord,
    candidates: Array<{ candidateId: string; repository: string; ref?: string; packagePath?: string }>,
    exec: WorkflowExec,
  ): Promise<{ candidates?: CandidateSnapshotItem[]; previews: CandidatePreview[]; failures: CandidatePreviewFailure[] }>
  reviewExisting(
    resolution: ResolutionRecord,
    target: EvolutionTarget,
    exec: WorkflowExec,
    workflow?: WorkflowRecord,
  ): Promise<{ resolution: ResolutionRecord; review: ReviewRecord }>
  reviewGithubBatch(
    resolution: ResolutionRecord,
    candidateIds: string[],
    mode: ReviewMode,
    exec: WorkflowExec,
    workflow?: WorkflowRecord,
  ): Promise<{
    resolution: ResolutionRecord
    reviews: ReviewRecord[]
    failures: Array<{ candidateId: string; repository: string; code: string; message: string }>
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
  prepareModify(
    resolution: ResolutionRecord,
    review: ReviewRecord,
    exec: WorkflowExec,
    workflow: WorkflowRecord,
  ): Promise<{ resolution: ResolutionRecord; path?: string; review?: ReviewRecord }>
  prepareCreate(
    resolution: ResolutionRecord,
    exec: WorkflowExec,
    workflow: WorkflowRecord,
  ): Promise<{ resolution: ResolutionRecord; path?: string; review?: ReviewRecord }>
  finishManagedWork(
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
  applyNavigation(
    resolution: ResolutionRecord,
    navigation: NavigationInput,
    repositories: string[],
  ): Promise<ResolutionRecord>
  /** Active Host profile an enable_builtin commitment targets, when determinable. */
  enableTargetProfile?(exec: WorkflowExec): Promise<string | undefined>
  /** Mount a frozen host-bundled opt-in capability into its target profile patch layer. */
  enableBuiltin?(workflow: WorkflowRecord, exec: WorkflowExec): Promise<InstallationRecord | void>
  latestReview(resolutionId: string, reviewId?: string): Promise<ReviewRecord | undefined>
  getResolution(id: string): Promise<ResolutionRecord>
  getReview(id: string): Promise<ReviewRecord>
  getInstallation(id: string): Promise<InstallationRecord>
  /** Finds one workflow-owned receipt when a crash happened before lastInstallationId was projected. */
  findInstallationForWorkflow?(workflowId: string): Promise<InstallationRecord | undefined>
  listInstallProfiles(): Promise<string[]>
  /** Whether managed child construction (modify/create) is available for this exec. */
  managedWorkAvailable(exec: WorkflowExec): boolean | Promise<boolean>
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
  'await_clarification',
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
  'superseded',
])

export const WORKFLOW_OPTIONS: Record<WorkflowOptionId, WorkflowOption> = {
  clarify_requirement: { id: 'clarify_requirement', labelEn: 'Answer the one clarification before search', labelZh: '回答搜寻前的唯一澄清问题', placement: 'primary' },
  review_candidates: { id: 'review_candidates', labelEn: 'Review selected candidates', labelZh: '审查选中的候选', placement: 'primary' },
  review_existing: { id: 'review_existing', labelEn: 'Review the known plugin source', labelZh: '审查这份插件的已知来源', placement: 'primary' },
  search_more: { id: 'search_more', labelEn: 'Search for plugins anyway', labelZh: '继续找插件', placement: 'primary' },
  reuse_local: { id: 'reuse_local', labelEn: 'Use existing local capability unchanged', labelZh: '原样使用已有本地能力', placement: 'primary' },
  enable_builtin: { id: 'enable_builtin', labelEn: 'Enable the built-in Host capability', labelZh: '直接启用内置能力', placement: 'primary' },
  create_new: { id: 'create_new', labelEn: 'Create new', labelZh: '新建', placement: 'advanced' },
  stop: { id: 'stop', labelEn: 'Stop for now', labelZh: '先停', placement: 'recovery' },
  use_this: { id: 'use_this', labelEn: 'Use this plugin', labelZh: '用这个', placement: 'primary' },
  apply_recovery: {
    id: 'apply_recovery',
    labelEn: 'Apply the selected recovery plan',
    labelZh: '执行所选恢复方案',
    placement: 'primary',
  },
  modify_this: { id: 'modify_this', labelEn: 'Improve this plugin', labelZh: '在这个上改', placement: 'advanced' },
  finish_managed_work: { id: 'finish_managed_work', labelEn: 'Continue managed construction', labelZh: '继续托管施工', placement: 'primary' },
}

export function isInterruptKind(value: string | undefined): value is InterruptKind {
  return value === 'await_clarification'
    || value === 'await_selection'
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

export function lookupBuiltinEnablement(
  workflow: WorkflowRecord | undefined,
  phase: SelectionReceipt['phase'],
): {
  candidate: CandidateSnapshotItem
  endpoint: Extract<ActionCommitment['endpoint'], { kind: 'host_bundled_enable' }>
} | undefined {
  const receipt = workflow?.selectionReceipt
  const commitment = workflow?.actionCommitment
  const candidateId = receipt?.candidateIds.length === 1 ? receipt.candidateIds[0] : undefined
  const candidate = candidateId
    ? workflow?.candidateSnapshot?.find((item) => item.id === candidateId)
    : undefined
  const endpoint = commitment?.endpoint
  const bundled = candidate?.hostBundled
  if (!receipt
    || receipt.phase !== phase
    || receipt.kind !== 'enable_builtin'
    || !candidateId
    || !candidate
    || candidate.kind !== 'local'
    || candidate.availability !== 'host_bundled'
    || !bundled
    || receipt.candidateDigests[candidateId] !== candidate.digest
    || !commitment
    || commitment.selectionReceiptId !== receipt.id
    || commitment.snapshotDigest !== receipt.snapshotDigest
    || commitment.requestedAction !== 'enable_builtin'
    || commitment.candidateId !== candidateId
    || commitment.candidateDigest !== candidate.digest
    || endpoint?.kind !== 'host_bundled_enable'
    || endpoint.packageName !== bundled.packageName
    || endpoint.version !== bundled.version
    || endpoint.mountId !== bundled.mountId
    || !endpoint.targetProfile
    || commitment.targetProfile !== endpoint.targetProfile) {
    return undefined
  }
  return { candidate, endpoint }
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
  extras: {
    lastFailure?: WorkflowRecord['lastFailure']
    installProfiles?: string[]
    retryableInstall?: RetryableInstallContext
  } = {},
): Record<string, unknown> {
  const review = reviews[0]
  const builtinEnablement = lookupBuiltinEnablement(workflow, 'gate1')
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
        installRetentionRule: 'This candidate verifies only at manual_runtime: adoption is persistent, Host still checks that the exact reviewed source is active in the profile, and completion awaits a manual user test in the target client or profile.',
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
      semanticContextRequired: requiresSemanticContext(item),
      directUseEligible: isDirectlyUsableReview(item, workflow),
    })),
    ...(builtinEnablement ? {
      builtinEnablement: {
        candidateId: builtinEnablement.candidate.id,
        name: builtinEnablement.candidate.name,
        packageName: builtinEnablement.endpoint.packageName,
        version: builtinEnablement.endpoint.version,
        mountId: builtinEnablement.endpoint.mountId,
        targetProfile: builtinEnablement.endpoint.targetProfile,
      },
    } : {}),
    candidateSnapshot: workflow?.candidateSnapshot ?? [],
    reviewedCandidateIds: workflow?.reviewedCandidateIds ?? [],
    remainingCandidateIds: (workflow?.candidateSnapshot ?? [])
      .filter((item) => item.kind === 'remote' && !(workflow?.reviewedCandidateIds ?? []).includes(item.id))
      .map((item) => item.id),
    reviewFailures: workflow?.reviewFailures ?? [],
    selectedRepositories: resolution.selectedRepositories ?? [],
    ...(review ? { license: review.license, compatibility: review.compatibility } : {}),
    ...(extras.lastFailure ? { lastFailure: extras.lastFailure } : {}),
    ...(extras.retryableInstall?.recovery ? { installRecovery: extras.retryableInstall.recovery } : {}),
    ...(extras.retryableInstall?.recoveryPlans?.length
      ? { recoveryOptions: extras.retryableInstall.recoveryPlans }
      : {}),
    verificationAlreadyAttempted: Boolean(review
      && review.id !== extras.retryableInstall?.reviewId
      && (workflow?.consumedVerificationAttempts ?? []).some((item) => sameVerificationAttempt(item, review))),
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
    instruction: 'The Host-owned construction child works only inside the managed source, then returns for Host commit and re-review. The parent must not edit, install, or commit.',
    ...(source.kind === 'github' ? { repository: source.repository } : {}),
    ...(creatorAgentFacts(workflow?.creatorRecords) ? { creator: creatorAgentFacts(workflow?.creatorRecords) } : {}),
  }
}

export function createWorkFacts(workflow?: WorkflowRecord): Record<string, unknown> {
  return {
    instruction: 'The Host-owned construction child works only inside the managed scaffold, then returns for Host commit and re-review. The parent must not call cordis_define, edit, or install.',
    ...(creatorAgentFacts(workflow?.creatorRecords) ? { creator: creatorAgentFacts(workflow?.creatorRecords) } : {}),
  }
}

export function optionsFor(
  kind: InterruptKind,
  resolution: ResolutionRecord | undefined,
  reviews: ReviewRecord[] = [],
  workflow?: WorkflowRecord,
  installProfiles: string[] = [],
  managedActionsAvailable = true,
  retryableInstall?: RetryableInstallContext,
): WorkflowOption[] {
  if (kind === 'await_clarification') return [WORKFLOW_OPTIONS.clarify_requirement, WORKFLOW_OPTIONS.stop]
  if (kind === 'await_modify_work') {
    return [WORKFLOW_OPTIONS.stop]
  }
  if (!resolution) throw new EvolutionError('invalid_input', 'Workflow decision gate is missing a resolution')
  const options: WorkflowOption[] = []
  const snapshot = workflow?.candidateSnapshot ?? []
  const remoteSnapshot = snapshot.filter((item) => item.kind === 'remote')
  const remainingIds = remoteSnapshot
    .filter((item) => !(workflow?.reviewedCandidateIds ?? []).includes(item.id))
    .map((item) => item.id)
  const reusableLocalIds = snapshot
    .filter((item) => item.kind === 'local'
      && ['available', 'available_via_tool_search', 'installed_in_profile'].includes(item.availability ?? '')
      && (item.reuseEligible ?? item.fit === 'full'))
    .map((item) => item.id)
  const evolvableLocalIds = snapshot
    .filter((item) => item.kind === 'local' && item.evolutionTarget)
    .map((item) => item.id)
  const builtinIds = snapshot
    .filter((item) => item.kind === 'local' && item.availability === 'host_bundled' && item.hostBundled)
    .map((item) => item.id)
  if (kind === 'await_selection' && builtinIds.length > 0) {
    options.push({ ...WORKFLOW_OPTIONS.enable_builtin, candidateIds: builtinIds })
  }
  if (kind === 'await_selection' && remoteSnapshot.length > 0) {
    options.push({ ...WORKFLOW_OPTIONS.review_candidates, candidateIds: remoteSnapshot.map((item) => item.id) })
  }
  if (kind === 'await_selection' && evolvableLocalIds.length > 0) {
    options.push({ ...WORKFLOW_OPTIONS.review_existing, candidateIds: evolvableLocalIds })
  }
  if (kind === 'await_confirmation') {
    const builtinEnablement = lookupBuiltinEnablement(workflow, 'gate1')
    if (builtinEnablement) {
      return [
        { ...WORKFLOW_OPTIONS.enable_builtin, candidateIds: [builtinEnablement.candidate.id] },
        WORKFLOW_OPTIONS.stop,
      ]
    }
    const candidateIdFor = (review: ReviewRecord): string | undefined => {
      const mapped = Object.entries(workflow?.reviewIdsByCandidate ?? {})
        .find(([, reviewId]) => reviewId === review.id)?.[0]
      if (mapped) return mapped
      const source = review.sourceSnapshot
      if (source.kind !== 'github') return undefined
      return snapshot.find((item) => item.repository?.toLowerCase() === source.repository.toLowerCase()
        || item.evolutionTarget?.repository.toLowerCase() === source.repository.toLowerCase())?.id
    }
    const failedSameSpec = (review: ReviewRecord): boolean => {
      const candidateId = candidateIdFor(review)
      const target = snapshot.find((item) => item.id === candidateId)?.evolutionTarget
      return Boolean(target?.kind === 'failed_install' && review.installSpec === target.dependencySpec)
    }
    const consumed = workflow?.consumedVerificationAttempts ?? []
    const hasRecoveryPlans = Boolean(retryableInstall?.recoveryPlans?.length)
    const suppressRetryReview = hasRecoveryPlans || Boolean(retryableInstall?.recoveryExhausted)
    const ordinaryRetryReviewId = suppressRetryReview
      ? undefined
      : retryableInstall?.reviewId
    const usableIds = reviews.filter((item) => isDirectlyUsableReview(item, workflow)
      && !(suppressRetryReview && item.id === retryableInstall?.reviewId)
      && (item.id === ordinaryRetryReviewId
        || !consumed.some((attempt) => sameVerificationAttempt(attempt, item)))
      && !failedSameSpec(item))
      .map(candidateIdFor).filter((id): id is string => Boolean(id))
    const repairableIds = reviews.filter(isManagedModificationEligibleReview)
      .map(candidateIdFor).filter((id): id is string => Boolean(id))
    if (usableIds.length > 0 && installProfiles.length > 0) {
      options.push({ ...WORKFLOW_OPTIONS.use_this, candidateIds: usableIds })
    }
    if (retryableInstall?.recoveryPlans?.length && installProfiles.length > 0) {
      const recoveryReview = reviews.find((item) => item.id === retryableInstall.reviewId)
      const recoveryCandidateId = recoveryReview ? candidateIdFor(recoveryReview) : undefined
      if (recoveryCandidateId) {
        options.push({
          ...WORKFLOW_OPTIONS.apply_recovery,
          candidateIds: [recoveryCandidateId],
          recoveryIds: retryableInstall.recoveryPlans.map((plan) => plan.id),
        })
      }
    }
    const evolvingInstalled = (workflow?.reviewedCandidateIds ?? []).some((id) => (
      snapshot.find((item) => item.id === id)?.evolutionTarget
    ))
    if (!evolvingInstalled) {
      options.push(WORKFLOW_OPTIONS.search_more)
    }
    if (remainingIds.length > 0 && !evolvingInstalled) {
      options.push({ ...WORKFLOW_OPTIONS.review_candidates, candidateIds: remainingIds })
    }
    if (reusableLocalIds.length > 0) {
      options.push({ ...WORKFLOW_OPTIONS.reuse_local, candidateIds: reusableLocalIds })
    }
    if (managedActionsAvailable
      && repairableIds.length > 0 && !modificationAttemptsExhausted(workflow?.modificationOutcome)) {
      options.push({ ...WORKFLOW_OPTIONS.modify_this, candidateIds: repairableIds })
    }
    if (managedActionsAvailable && resolution.remoteDiscoveryComplete) {
      options.push(WORKFLOW_OPTIONS.create_new)
    }
    options.push(WORKFLOW_OPTIONS.stop)
    return options
  }
  if (reusableLocalIds.length > 0) {
    options.push({ ...WORKFLOW_OPTIONS.reuse_local, candidateIds: reusableLocalIds })
  }
  const lineageOnly = evolvableLocalIds.length > 0
    && remoteSnapshot.length === 0
    && workflow?.intent?.operation === 'evolve_existing'
  if (!lineageOnly) options.push(WORKFLOW_OPTIONS.search_more)
  if (kind === 'await_selection' && snapshot.length === 0 && managedActionsAvailable && resolution.remoteDiscoveryComplete) {
    options.push(WORKFLOW_OPTIONS.create_new)
  }
  options.push(WORKFLOW_OPTIONS.stop)
  return options
}
