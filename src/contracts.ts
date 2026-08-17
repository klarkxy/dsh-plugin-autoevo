export const POLICY_VERSION = 'v5-2026-08-17'

export const TOOL_NAMES = [
  'capability_resolve',
  'capability_decide',
  'plugin_review',
  'plugin_install',
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
  | 'scratch_ready'
export type CandidateAvailability = 'available' | 'available_via_tool_search'
export type RemoteCandidateSource = 'dsh-find-plugin' | 'github' | 'marketplace-setup'
export type DecisionPhase = 'gate1' | 'gate2'
export type DecisionAction = 'inspect' | 'create_new' | 'stop' | 'use_this' | 'modify_this' | 'use_local'

export interface DecisionReceipt {
  id: string
  phase: DecisionPhase
  action: DecisionAction
  selectedRepositories: string[]
  reviewId?: string
  reviewIdentity?: string
  userMessage?: string
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
  kind: 'tool' | 'skill'
  name: string
  description: string
  availability: CandidateAvailability
  confidence: number
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
  /** V1 records remain readable but never restore a scratch-build grant. */
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
  /** Instruction for the Agent: present in chat, then call capability_decide. */
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
}

export interface ReviewResult extends ReviewRecord {
  authorization: ResolutionAuthorization
  nextStep?: string
}

export type InstallationRetention = 'temporary' | 'persistent'
export type InstallationState = 'installed' | 'not_installed' | 'unknown'

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
  taskResultMatchedExpectation?: boolean
  reason: string
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
  installed: boolean
  loaded: boolean
  verified: boolean
  restartRequired: boolean
  removed: boolean
  verification: VerificationEvidence
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

export interface ResolveInput {
  requirement: string
}

export interface DecideInput {
  resolutionId: string
  userMessage: string
  action?: DecisionAction | 'search_more'
  repositories?: string[]
  reviewId?: string
}

export interface ReviewInput {
  resolutionId: string
  sourceKind: 'github' | 'local'
  repository?: string
  ref?: string
  path?: string
  baseReviewId?: string
}

export interface InstallInput {
  reviewId: string
  targetProfile: string
  retention: InstallationRetention
  verificationTask?: string
  verificationExpectedText?: string
}

export interface RemoveInput {
  installationId: string
}
