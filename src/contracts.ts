export const POLICY_VERSION = '1'

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
  | 'scratch_ready'
export type CandidateAvailability = 'available' | 'available_via_tool_search'
export type RemoteCandidateSource = 'dsh-find-plugin' | 'github' | 'marketplace-setup'
export type CommunityQualityClass = 'good' | 'repairable' | 'broken' | 'junk' | 'unknown'
export type DecisionPhase = 'gate1' | 'gate2'
export type DecisionAction =
  | 'inspect'
  | 'create_new'
  | 'stop'
  | 'use_this'
  | 'modify_this'
  | 'use_local'
  | 'search_more'
  | 'resume_modify'
export type WorkflowOptionId = DecisionAction

export interface DecisionReceipt {
  id: string
  phase: DecisionPhase
  action: DecisionAction
  selectedRepositories: string[]
  reviewId?: string
  reviewIdentity?: string
  userMessage?: string
  optionId?: WorkflowOptionId
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
  communityQuality?: CommunityQualityAssessment
}

export interface CommunityQualityAssessment {
  classification: CommunityQualityClass
  repairability: number | null
  evolutionValue: number | null
  confidence: number | null
  observationCount: number
  reasonCodes: string[]
  updatedAt: string | null
}

export interface CommunityQualityScreening {
  enabled: true
  complete: boolean
  assessedCandidates: number
  filtered: Array<{
    repository: string
    classification: 'broken' | 'junk'
    reasonCodes: string[]
  }>
  reason: string
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
  /** Opt-in community quality result. Filtered repositories are retained here for audit, not selection. */
  communityQualityScreening?: CommunityQualityScreening
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

export interface ResumeInput {
  workflowId: string
  userMessage: string
  optionId: WorkflowOptionId
  repositories?: string[]
  path?: string
  ref?: string
  reviewId?: string
  targetProfile?: string
  retention?: InstallationRetention
  verificationTask?: string
  verificationExpectedText?: string
}
