export const POLICY_VERSION = 'v2-2026-08-15'

export const TOOL_NAMES = [
  'capability_resolve',
  'plugin_review',
  'plugin_install',
  'plugin_remove',
] as const

export type ToolName = (typeof TOOL_NAMES)[number]

export type ResolutionDecision = 'use_local' | 'inspect_remote' | 'none'
export type CandidateAvailability = 'available' | 'available_via_tool_search'
export type RemoteCandidateSource = 'dsh-find-plugin' | 'github'

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
}

export interface ResolutionRecord {
  schemaVersion: 1
  id: string
  policyVersion: string
  createdAt: string
  requirement: string
  cwd: string
  decision: ResolutionDecision
  localCandidates: LocalCapabilityCandidate[]
  remoteCandidates: RemotePluginCandidate[]
  remoteCandidateSource?: RemoteCandidateSource
  queries: string[]
  reasons: string[]
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
  contributionAdvice?: {
    eligible: boolean
    reason: string
  }
}

export interface ResolveInput {
  requirement: string
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
