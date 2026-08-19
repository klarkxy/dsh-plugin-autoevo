/** Receipt policy. New resolution/review/workflow records use this value. */
export const POLICY_VERSION = '5'

export const TOOL_NAMES = [
  'capability_workflow',
  'capability_workflow_resume',
  'plugin_remove',
] as const

export type ToolName = (typeof TOOL_NAMES)[number]

export type ResolutionDecision = 'use_local' | 'inspect_remote' | 'none'
/** Evidence states wait; action states are minted only after a recorded human answer. */
export type AuthorizationState =
  | 'selection_required'
  | 'confirmation_required'
  | 'market_required'
  | 'stopped'
  | 'reuse_local'
  | 'use_review'
  | 'modify_review'
  | 'create_authorized'
export type CandidateAvailability = 'available' | 'available_via_tool_search'
export type RemoteCandidateSource = 'dsh-find-plugin' | 'marketplace-setup'
/** `gate1` remains readable for legacy receipts; current policy mints only gate2. */
export type DecisionPhase = 'gate1' | 'gate2'
export type AuthorizationAction =
  | 'create_new'
  | 'stop'
  | 'use_this'
  | 'modify_this'
export type NavigationKind =
  | 'review_candidates'
  | 'search_more'
  | 'reuse_local'
  | 'stop'
export type ReviewMode = 'fixed' | 'adaptive'
export type WorkflowOptionId = AuthorizationAction | NavigationKind

export interface NavigationInput {
  kind: NavigationKind
  candidateIds?: string[]
  reviewMode?: ReviewMode
}

export interface DecisionReceipt {
  id: string
  phase: DecisionPhase
  action: AuthorizationAction
  selectedRepositories: string[]
  reviewId?: string
  reviewIdentity?: string
  userMessage?: string
  optionId?: WorkflowOptionId
  interruptId?: string
  hostTurnId?: string
  candidateId?: string
  retention?: InstallationRetention
  targetProfile?: string
  snapshotDigest?: string
  createdAt: string
}

export interface ResolutionAuthorization {
  state: AuthorizationState
  resolutionId: string
  reason: string
  selectedRepositories?: string[]
  reviewId?: string
  reviewIdentity?: string
}

export interface LocalCapabilityCandidate {
  kind: 'tool' | 'skill' | 'plugin'
  name: string
  description: string
  availability: CandidateAvailability
  confidence: number
  /** Retrieval is broad; only `full` may suppress remote discovery. */
  fit?: 'full' | 'partial' | 'none'
  matchedFacets?: string[]
  missingFacets?: string[]
}

export interface RemotePluginCandidate {
  repository: string
  name: string
  description: string
  stars: number
  updatedAt: string | null
  topics: string[]
  packageName?: string
  defaultBranch?: string
  matchedTerms?: string[]
  matchReason?: string
}

export interface ResolutionRecord {
  /** V1 records remain readable but never restore a create grant. */
  schemaVersion: 1 | 2
  id: string
  policyVersion: string
  createdAt: string
  requirement: string
  cwd: string
  decision: ResolutionDecision
  localCandidates: LocalCapabilityCandidate[]
  remoteCandidates: RemotePluginCandidate[]
  remoteCandidateSource?: RemoteCandidateSource
  /** Whether every configured discovery fallback completed successfully. */
  remoteDiscoveryComplete?: boolean
  /** Present on V2 records created by the current policy. */
  authorization?: ResolutionAuthorization
  selectedRepositories?: string[]
  decisions?: DecisionReceipt[]
  queries: string[]
  reasons: string[]
  /** Instruction for the Agent: present in chat, then call capability_workflow_resume. */
  nextStep?: string
}

export type ReviewFit = 'full' | 'partial' | 'none'
export type SecurityRisk = 'low' | 'medium' | 'high'
export type ReviewRecommendation = 'use' | 'modify' | 'skip'
export type CompatibilityStatus = 'compatible' | 'incompatible' | 'unknown'

export interface ReviewFinding {
  code: string
  severity: 'info' | 'warning' | 'block'
  source: string
  detail: string
  evidenceHash?: string
}

export interface ManifestFacts {
  kind: 'bundle' | 'skill' | 'legacy' | 'unknown'
  packageName?: string
  packageVersion?: string
  bundlePatch?: string
  license?: string
  scripts: string[]
  dependencies: string[]
  peerDependencies: Record<string, string>
  expectedTools: string[]
  /** Route declared by an agent-default-model patch, when statically derivable. */
  expectedRoute?: { provider: string; model?: string }
}

export interface InspectedFile {
  path: string
  blobId?: string
  sha256: string
  bytes: number
}

export type ReviewSourceSnapshot =
  | {
      kind: 'github'
      repository: string
      requestedRef: string
      commit: string
      defaultBranch: string
    }
  | {
      kind: 'local'
      path: string
      baseReviewId: string
      baseCommit: string
      statusHash: string
    }

export interface MechanicalFacts {
  fit: ReviewFit
  missingCapabilities: string[]
  staticRisk: SecurityRisk
  compatibility: {
    status: CompatibilityStatus
    reason: string
    runtimeVersion: string | null
  }
  manifest: {
    kind: ManifestFacts['kind']
    packageName?: string
    packageVersion?: string
    bundlePatch?: string
    materializable: boolean
    installSpec: string | null
  }
  truncated: boolean
  findings: Array<Pick<ReviewFinding, 'code' | 'severity' | 'source' | 'evidenceHash'>>
  evidenceHashes: string[]
  semanticContextRequired: boolean
  /** Host still hard-rejects direct use_this when set; not a reviewer authorization. */
  directUseHostBoundary?: 'incompatible' | 'not_materializable'
}

export type ReviewerRequestStatus = 'pending' | 'running' | 'completed' | 'cancelled' | 'timed_out'

/** Host-owned reviewer job. Must not carry authorization or an install spec. */
export interface ReviewerRequest {
  id: string
  workflowId: string
  resolutionId: string
  reviewId: string
  requirement: string
  snapshotDigest: string
  candidateDigest: string
  status: ReviewerRequestStatus
  createdAt: string
  startedAt?: string
  completedAt?: string
}

export type ReviewerVerdictDecision = 'approved' | 'rejected' | 'uncertain'

/** Reviewer semantic verdict. Must not carry authorization, lease, endpoint, or install spec. */
export interface ReviewerVerdict {
  requestId: string
  reviewId: string
  requirementHash: string
  snapshotDigest: string
  candidateDigest: string
  reviewerSessionId: string
  reviewerVersion: string
  decision: ReviewerVerdictDecision
  evidence: string[]
  conditions: string[]
  semanticCoverage: ReviewFit
  createdAt: string
}

export interface ReviewRecord {
  schemaVersion: 1
  id: string
  policyVersion: string
  createdAt: string
  resolutionId: string
  requirement: string
  sourceSnapshot: ReviewSourceSnapshot
  inspectedFiles: InspectedFile[]
  manifest: ManifestFacts
  fit: ReviewFit
  confidence: number
  securityRisk: SecurityRisk
  maintained: boolean
  license: string | null
  compatibility: {
    status: CompatibilityStatus
    reason: string
    runtimeVersion: string | null
  }
  missingCapabilities: string[]
  findings: ReviewFinding[]
  recommendation: ReviewRecommendation
  installSpec: string | null
  /** Present on current reviews. Absent on old readable records, which are never a reviewer approval. */
  mechanicalFacts?: MechanicalFacts
  reviewerRequestId?: string
  reviewerRequest?: ReviewerRequest
  reviewerVerdict?: ReviewerVerdict
}

export interface ReviewResult extends ReviewRecord {
  authorization: ResolutionAuthorization
  nextStep?: string
}

export type InstallationRetention = 'temporary' | 'persistent'
export type InstallationState = 'installed' | 'not_installed' | 'unknown'
/** Public install outcome: success only after Loader/runtime verification. */
export type InstallOutcome = 'pending' | 'verified' | 'failed_absent' | 'recovery_required'

export interface HotReloadEvidence {
  attempted: boolean
  loaded: boolean
  method: 'already-loaded' | 'loader' | 'direct-import' | 'unsupported' | 'failed'
  reason: string
}

export interface VerificationEvidence {
  attempted: boolean
  task?: string
  exitCode?: number | null
  expectedTools: string[]
  calledTools: string[]
  resultTools: string[]
  failedTools: string[]
  sessionFiles: string[]
  receiptPath?: string
  taskResultObserved: boolean
  taskResultSha256?: string
  /** Diagnostic substring observation only. Never Host verified truth. */
  taskResultMatchedExpectation?: boolean
  observedProvider?: string
  observedModel?: string
  routeMatchedExpectation?: boolean
  reason: string
}

export type VerifierRequestStatus = 'pending' | 'running' | 'completed' | 'cancelled' | 'timed_out'
export type VerificationVerdictDecision = 'verified' | 'rejected' | 'uncertain'

/** Host-owned semantic verification job. Must not carry authorization or an install spec. */
export interface VerifierRequest {
  id: string
  installationId: string
  reviewId: string
  requirement: string
  evidenceDigest: string
  status: VerifierRequestStatus
  createdAt: string
  startedAt?: string
  completedAt?: string
}

/** Independent semantic completion verdict. Must not carry authorization, lease, endpoint, or install spec. */
export interface VerificationVerdict {
  requestId: string
  installationId: string
  reviewId: string
  requirementHash: string
  evidenceDigest: string
  verifierSessionId: string
  verifierVersion: string
  decision: VerificationVerdictDecision
  evidence: string[]
  conditions: string[]
  createdAt: string
}

export interface InstallationRecord {
  schemaVersion: 1
  id: string
  createdAt: string
  reviewId: string
  targetProfile: string
  retention: InstallationRetention
  dshHome: string
  packageName: string | null
  installSpec: string
  ownedArtifactRoot?: string
  artifactSha256?: string
  /** Present on v0.1.1+ receipts. Older v0.1.0 receipts are inferred from `installed`. */
  installState?: InstallationState
  /** Fail-closed public outcome. Success is only `verified`. */
  installOutcome?: InstallOutcome
  installed: boolean
  loaded: boolean
  verified: boolean
  restartRequired: boolean
  hotReload?: HotReloadEvidence
  removed: boolean
  verification: VerificationEvidence
  verifierRequestId?: string
  verifierRequest?: VerifierRequest
  verificationVerdict?: VerificationVerdict
  /** Redacted structured facts for a failed install command. Raw stderr is never persisted. */
  installFailure?: {
    code: string
    message: string
    exitCode?: number | null
    diagnosticHash?: string
  }
  contributionAdvice?: {
    eligible: boolean
    reason: string
  }
}

export interface InstallInput {
  reviewId: string
  targetProfile: string
  retention: InstallationRetention
  verificationTask?: string
  verificationExpectedText?: string
  /** Host-derived managed-source artifact hash; never accepted from model tool arguments. */
  expectedArtifactSha256?: string
}

export interface RemoveInput {
  installationId: string
}

/** Model-interpreted final authorization intent, bounded by the current interrupt. */
export interface AuthorizationDecisionInput {
  action: AuthorizationAction
  /** Required for use_this / modify_this; must belong to the action's interrupt-bound candidate set. */
  candidateId?: string
  /** Optional for use_this. Defaults to temporary when the user did not express a preference. */
  retention?: InstallationRetention
}

/** Public resume input keeps model interpretation separate from Host-owned facts. */
export interface ResumeInput {
  workflowId: string
  interruptId: string
  /** Model-interpreted read-only navigation. Never grants a side effect. */
  navigation?: NavigationInput
  /** Model-interpreted final action. Host validates it against the current interrupt and fresh user turn. */
  decision?: AuthorizationDecisionInput
}

/**
 * Host-owned selection evidence. Minted only after a fresh user turn is consumed.
 * ResumeInput must not accept a model-forged copy of this object.
 */
export interface SelectionReceipt {
  id: string
  workflowId: string
  interruptId: string
  snapshotDigest: string
  kind: NavigationKind | AuthorizationAction
  candidateIds: string[]
  candidateDigests: Record<string, string>
  hostTurnId: string
  ownerSessionId: string
  bootId: string
  createdAt: string
}

export type ExecutionEndpoint =
  | { kind: 'none' }
  | { kind: 'exact_tool'; name: string }
  | { kind: 'bridge'; tools: readonly string[]; target: string }

export interface FrozenCandidateIdentity {
  kind: 'local' | 'remote'
  localKind?: LocalCapabilityCandidate['kind']
  name: string
  identity: string
  availability?: CandidateAvailability
  fit?: 'full' | 'partial' | 'none'
  repository?: string
}

/** Host-derived from SelectionReceipt + the interrupt-bound candidate snapshot. */
export interface ActionCommitment {
  id: string
  selectionReceiptId: string
  snapshotDigest: string
  candidateId?: string
  candidateDigest?: string
  frozenIdentity: FrozenCandidateIdentity | { kind: 'none' }
  requestedAction: NavigationKind | AuthorizationAction
  retention?: InstallationRetention
  endpoint: ExecutionEndpoint
  allowedParameterConstraints: {
    /** Exact bridge/tool target; tool_search/tool_call may not widen past this name. */
    exactTarget?: string
  }
  createdAt: string
  /** Host-frozen review identity. Reviewer output cannot mint these fields. */
  reviewId?: string
  reviewSnapshotDigest?: string
  reviewerRequestId?: string
  reviewerVerdictDigest?: string
  frozenManifestDigest?: string
  frozenInstallSpec?: string | null
  targetProfile?: string
}

/**
 * Current-turn execution grant. Bound to commitment + session/boot/workflow + turn watermark.
 * Host may silently re-sign the next continuation only when receipt, commitment, and endpoint are unchanged.
 */
export interface ExecutionLease {
  id: string
  commitmentId: string
  selectionReceiptId: string
  workflowId: string
  ownerSessionId: string
  bootId: string
  hostTurnId: string
  interruptId: string
  snapshotDigest: string
  candidateId?: string
  candidateDigest?: string
  requestedAction: ActionCommitment['requestedAction']
  endpoint: ExecutionEndpoint
  allowedParameterConstraints: ActionCommitment['allowedParameterConstraints']
  createdAt: string
}

export const BRIDGE_EXECUTION_TOOLS = ['tool_search', 'tool_describe', 'tool_call'] as const
export const FORGED_RESUME_HOST_KEYS = [
  'selectionReceipt',
  'actionCommitment',
  'executionLease',
  'commitment',
  'lease',
  'endpoint',
  'reviewerVerdict',
  'verificationVerdict',
  'verifierVerdict',
  'verifierRequest',
] as const
