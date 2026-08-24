import { t as EVOLUTION_PRESET_ID } from "./evolution-contracts.js";
import { LoadHookContext } from "node:module";
import Schema from "@deepseek-ai/schemastery";
import { SandboxPolicyService } from "@deepseek-ai/dsh-sandbox-policy";
import { Session } from "@deepseek-ai/dsh-session";
import { PreToolDecision, ToolExecution, ToolExecutionResult, ToolRunContext } from "@deepseek-ai/dsh-tools";
import "@deepseek-ai/cordis-plugin-include";
import { Context, Fiber, Inject, Service } from "@deepseek-ai/cordis";
import { Agent } from "@deepseek-ai/dsh-agent";
import "@deepseek-ai/dsh-subprocess";
import { FileSystem } from "@deepseek-ai/dsh-fs";
import { SandboxProvider } from "@deepseek-ai/dsh-sandbox";
//#region src/config.d.ts
interface Config$1 {
  dshHome?: string;
  /** Host receipts and artifacts. Empty uses `<dshHome>/autoevo`. */
  stateDir?: string;
  /** Managed plugin source repositories. Empty uses `<workspace>/.autoevo/sources`. */
  sourceDir?: string;
  ghCommand?: string;
  gitCommand?: string;
  dshCommand?: string;
  dshCommandArgs?: string[];
  maxCandidates?: number;
  maxFiles?: number;
  maxRepositoryBytes?: number;
  commandTimeoutMs?: number;
  forwardedCredentialEnv?: string[];
  verificationPatchPaths?: string[];
  /** When true (default), materialize/upgrade the managed evolution user preset. Never auto-deletes. */
  evolutionPreset?: boolean;
}
interface RuntimeConfig {
  dshHome: string;
  /** Optional override. Normalized config uses `<dshHome>/autoevo`. */
  stateDir?: string;
  /** Optional override. Omitted callers use `<workspace>/.autoevo/sources`. */
  sourceDir?: string;
  ghCommand: string;
  gitCommand: string;
  dshCommand: string;
  dshCommandArgs: string[];
  maxCandidates: number;
  maxFiles: number;
  maxRepositoryBytes: number;
  commandTimeoutMs: number;
  forwardedCredentialEnv: string[];
  verificationPatchPaths: string[];
  evolutionPreset: boolean;
}
declare const Config$1: Schema<Config$1>;
//#endregion
//#region src/contracts.d.ts
/** Receipt policy. New resolution/review/workflow records use this value. */
declare const POLICY_VERSION = "8";
declare const TOOL_NAMES: readonly ["capability_workflow", "capability_workflow_resume", "capability_workflow_recover", "plugin_remove"];
type ResolutionDecision = 'use_local' | 'inspect_remote' | 'none';
/** Evidence states wait; action states are minted only after a recorded human answer. */
type AuthorizationState = 'selection_required' | 'confirmation_required' | 'market_required' | 'stopped' | 'reuse_local' | 'use_review' | 'modify_review' | 'create_authorized';
type CandidateAvailability = 'available' | 'available_via_tool_search' | 'installed_in_profile' | 'known_source';
type RemoteCandidateSource = 'github' | 'dsh-find-plugin' | 'marketplace-setup';
/** `gate1` remains readable for legacy receipts; current policy mints only gate2. */
type DecisionPhase = 'gate1' | 'gate2';
type AuthorizationAction = 'create_new' | 'stop' | 'use_this' | 'modify_this';
type NavigationKind = 'review_candidates' | 'review_existing' | 'search_more' | 'reuse_local' | 'stop' | 'finish_managed_work';
type ReviewMode = 'fixed' | 'adaptive';
type WorkflowOptionId = AuthorizationAction | NavigationKind;
type RequestOperation = 'discover_or_reuse' | 'reuse_existing' | 'evolve_existing';
type RequiredSurface = 'any' | 'native_dsh_plugin';
type EvolveReason = 'repair' | 'upgrade' | 'improve_known_source';
interface RequestIntent {
  operation: RequestOperation;
  requiredSurface: RequiredSurface;
  targetName?: string;
  evolveReason?: EvolveReason;
}
type EvolutionTargetKind = 'github_exact' | 'owned_chain' | 'failed_install' | 'reviewed_snapshot';
interface EvolutionTarget {
  kind: EvolutionTargetKind;
  repository: string;
  commit: string;
  packageName: string;
  profile: string;
  dependencySpec: string;
  specDigest: string;
  installationId?: string;
  reviewId?: string;
  sourceId?: string;
}
type ReplacementJournalState = 'prepared' | 'old_present' | 'new_present' | 'absent' | 'unknown';
interface ReplacementTarget {
  profile: string;
  packageName: string;
  oldSpecDigest: string;
  oldDependencySpec: string;
  predecessorInstallationId?: string;
}
interface ReplacementJournal {
  state: ReplacementJournalState;
  oldSpecDigest: string;
  newInstallSpec: string;
  preparedAt: string;
  reconciledAt?: string;
}
interface NavigationInput {
  kind: NavigationKind;
  candidateIds?: string[];
  reviewMode?: ReviewMode;
}
interface DecisionReceipt {
  id: string;
  phase: DecisionPhase;
  action: AuthorizationAction;
  selectedRepositories: string[];
  reviewId?: string;
  reviewIdentity?: string;
  userMessage?: string;
  optionId?: WorkflowOptionId;
  interruptId?: string;
  hostTurnId?: string;
  candidateId?: string;
  retention?: InstallationRetention;
  targetProfile?: string;
  snapshotDigest?: string;
  createdAt: string;
}
interface ResolutionAuthorization {
  state: AuthorizationState;
  resolutionId: string;
  reason: string;
  selectedRepositories?: string[];
  reviewId?: string;
  reviewIdentity?: string;
}
interface LocalCapabilityCandidate {
  kind: 'tool' | 'skill' | 'plugin';
  name: string;
  description: string;
  availability: CandidateAvailability;
  confidence: number;
  /** Retrieval is broad; only `full` may suppress remote discovery. */
  fit?: 'full' | 'partial' | 'none';
  /** Anchor/name match before intent and surface adjustments. */
  semanticFit?: 'full' | 'partial' | 'none';
  /** Whether this candidate kind satisfies the request's required delivery surface. */
  surfaceMatch?: boolean;
  /** Safe to use unchanged. Distinct from request-satisfaction `fit`. */
  reuseEligible?: boolean;
  matchedFacets?: string[];
  missingFacets?: string[];
  /** Host-owned installed-source provenance for evolve-existing. */
  evolutionTarget?: EvolutionTarget;
  /** Profile-manifest evidence proves install/configuration only, never runtime state. */
  profileEvidence?: {
    source: 'host_profile_manifest';
    profile: string;
    packageName: string;
    dependencySpec: string;
    configuredBundle: boolean;
  };
}
interface RemotePluginCandidate {
  repository: string;
  name: string;
  description: string;
  stars: number;
  updatedAt: string | null;
  topics: string[];
  packageName?: string;
  defaultBranch?: string;
  matchedTerms?: string[];
  matchReason?: string;
}
interface ResolutionRecord {
  /** V1 records remain readable but never restore a create grant. */
  schemaVersion: 1 | 2;
  id: string;
  policyVersion: string;
  createdAt: string;
  requirement: string;
  cwd: string;
  decision: ResolutionDecision;
  localCandidates: LocalCapabilityCandidate[];
  remoteCandidates: RemotePluginCandidate[];
  remoteCandidateSource?: RemoteCandidateSource;
  /** Whether every configured discovery fallback completed successfully. */
  remoteDiscoveryComplete?: boolean;
  /** Present on V2 records created by the current policy. */
  authorization?: ResolutionAuthorization;
  selectedRepositories?: string[];
  decisions?: DecisionReceipt[];
  queries: string[];
  reasons: string[];
  /** Structured start intent. Absent on intentless Policy V8 records. */
  intent?: RequestIntent;
  /** Instruction for the Agent: present in chat, then call capability_workflow_resume. */
  nextStep?: string;
}
type ReviewFit = 'full' | 'partial' | 'none';
type SecurityRisk = 'low' | 'medium' | 'high';
type ReviewRecommendation = 'use' | 'modify' | 'skip';
type CompatibilityStatus = 'compatible' | 'incompatible' | 'unknown';
interface ReviewFinding {
  code: string;
  severity: 'info' | 'warning' | 'block';
  source: string;
  detail: string;
  evidenceHash?: string;
}
interface ActivatedFiber {
  id?: string;
  name: string;
}
interface ManifestFacts {
  kind: 'bundle' | 'skill' | 'legacy' | 'unknown';
  packageName?: string;
  packageVersion?: string;
  bundlePatch?: string;
  /** Loader insert rows this bundle activates. Carrier patches name another package. */
  activatedFibers?: ActivatedFiber[];
  license?: string;
  scripts: string[];
  dependencies: string[];
  peerDependencies: Record<string, string>;
  expectedTools: string[];
  /** Route declared by an agent-default-model patch, when statically derivable. */
  expectedRoute?: {
    provider: string;
    model?: string;
  };
  /** Frozen `package.json` `dsh.client` entry. Path or `declared`; never a secret. */
  client?: string;
  /** Frozen client platform implied by `dsh.client`. */
  clientPlatform?: string;
}
declare const VERIFICATION_LAYER_KINDS: readonly ["bundle_activation", "tool_roundtrip", "manual_runtime"];
type VerificationLayerKind = (typeof VERIFICATION_LAYER_KINDS)[number];
declare const VERIFICATION_STATUSES: readonly ["passed", "pending_user_test", "blocked_precondition", "failed", "uncertain"];
type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];
interface ToolFixtureAvailability {
  tool: string;
  /** Candidate-declared fixture/arguments existence. Not a safety claim. */
  available: boolean;
  /** Host-derived safety fact. Never copied from plugin package.json. */
  safe: boolean;
  /** Host-derived. True only for a Host validator or Host test facts. */
  hostValidated: boolean;
}
/**
 * Frozen non-secret static facts for verification-layer classification.
 * These signals may only downgrade the layer; they never upgrade it.
 * `toolFixtures.available` may come from a candidate declaration.
 * `toolFixtures.safe` and `toolFixtures.hostValidated` are Host-derived.
 */
interface RuntimeSurfaceFacts {
  clientPlatform?: string;
  expectedRoute?: {
    provider: string;
    model?: string;
  };
  llmDependency: boolean;
  llmRegistered: boolean;
  credentialsDependency: boolean;
  credentialsRegistered: boolean;
  networkSignal: boolean;
  environmentSignal: boolean;
  processSignal: boolean;
  skillOnly: boolean;
  unsafeTools: boolean;
  expectedTools: readonly string[];
  toolFixtures: readonly ToolFixtureAvailability[];
  kind?: ManifestFacts['kind'];
  truncated?: boolean;
}
interface RuntimeSurface extends RuntimeSurfaceFacts {
  verificationLayer: VerificationLayerKind;
}
/**
 * Static classification. Risk signals and missing Host-validated fixtures only
 * downgrade; a plugin declaration cannot mint `tool_roundtrip`.
 */
declare function classifyRuntimeSurface(surface: RuntimeSurfaceFacts): VerificationLayerKind;
interface InspectedFile {
  path: string;
  blobId?: string;
  sha256: string;
  bytes: number;
}
type ReviewSourceSnapshot = {
  kind: 'github';
  repository: string;
  requestedRef: string;
  commit: string;
  defaultBranch: string;
} | {
  kind: 'local';
  path: string;
  baseReviewId: string;
  baseCommit: string;
  statusHash: string;
};
interface MechanicalFacts {
  fit: ReviewFit;
  missingCapabilities: string[];
  staticRisk: SecurityRisk;
  compatibility: {
    status: CompatibilityStatus;
    reason: string;
    runtimeVersion: string | null;
  };
  manifest: {
    kind: ManifestFacts['kind'];
    packageName?: string;
    packageVersion?: string;
    bundlePatch?: string;
    materializable: boolean;
    installSpec: string | null;
  };
  truncated: boolean;
  findings: Array<Pick<ReviewFinding, 'code' | 'severity' | 'source' | 'evidenceHash'>>;
  evidenceHashes: string[];
  semanticContextRequired: boolean;
  /** Host still hard-rejects direct use_this when set; not a reviewer authorization. */
  directUseHostBoundary?: 'incompatible' | 'not_materializable';
}
type ReviewerRequestStatus = 'pending' | 'running' | 'completed' | 'cancelled' | 'timed_out';
/** Host-owned reviewer job. Must not carry authorization or an install spec. */
interface ReviewerRequest {
  id: string;
  workflowId: string;
  resolutionId: string;
  reviewId: string;
  requirement: string;
  snapshotDigest: string;
  candidateDigest: string;
  status: ReviewerRequestStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}
type ReviewerVerdictDecision = 'approved' | 'rejected' | 'uncertain';
/** Reviewer semantic verdict. Must not carry authorization, lease, endpoint, or install spec. */
interface ReviewerVerdict {
  requestId: string;
  reviewId: string;
  requirementHash: string;
  snapshotDigest: string;
  candidateDigest: string;
  reviewerSessionId: string;
  reviewerVersion: string;
  decision: ReviewerVerdictDecision;
  evidence: string[];
  conditions: string[];
  semanticCoverage: ReviewFit;
  createdAt: string;
}
interface ReviewRecord {
  schemaVersion: 1;
  id: string;
  policyVersion: string;
  createdAt: string;
  resolutionId: string;
  requirement: string;
  sourceSnapshot: ReviewSourceSnapshot;
  inspectedFiles: InspectedFile[];
  manifest: ManifestFacts;
  fit: ReviewFit;
  confidence: number;
  securityRisk: SecurityRisk;
  maintained: boolean;
  license: string | null;
  compatibility: {
    status: CompatibilityStatus;
    reason: string;
    runtimeVersion: string | null;
  };
  missingCapabilities: string[];
  findings: ReviewFinding[];
  recommendation: ReviewRecommendation;
  installSpec: string | null;
  /** Present on current reviews. Absent on old readable records, which are never a reviewer approval. */
  mechanicalFacts?: MechanicalFacts;
  /** Frozen static runtime surface. Absent on old readable records. */
  runtimeSurface?: RuntimeSurface;
  reviewerRequestId?: string;
  reviewerRequest?: ReviewerRequest;
  reviewerVerdict?: ReviewerVerdict;
}
type InstallationRetention = 'temporary' | 'persistent';
type InstallationState = 'installed' | 'not_installed' | 'unknown';
/**
 * Public install outcome.
 * `verified` remains the only Host-verified success.
 * `activated` and `awaiting_user_test` are non-failure states and are not verified.
 */
type InstallOutcome = 'pending' | 'verified' | 'failed_absent' | 'recovery_required' | 'activated' | 'awaiting_user_test';
interface HotReloadEvidence {
  attempted: boolean;
  loaded: boolean;
  method: 'already-loaded' | 'loader' | 'direct-import' | 'unsupported' | 'failed';
  reason: string;
}
interface VerificationEvidence {
  attempted: boolean;
  task?: string;
  exitCode?: number | null;
  expectedTools: string[];
  calledTools: string[];
  resultTools: string[];
  failedTools: string[];
  sessionFiles: string[];
  receiptPath?: string;
  /** Host-written process-boundary evidence. Never contains argv, prompts, output, env, or exception text. */
  launchEvidence?: {
    attempted: boolean;
    processOutcome: 'returned' | 'threw';
    observerEventCount: number;
    exitCode?: number | null;
    signal?: string | null;
    failureClass?: 'cancelled' | 'timed_out' | 'launch_error' | 'unknown';
    diagnosticHash?: string;
  };
  taskResultObserved: boolean;
  taskResultSha256?: string;
  /** Diagnostic substring observation only. Never Host verified truth. */
  taskResultMatchedExpectation?: boolean;
  observedProvider?: string;
  observedModel?: string;
  routeMatchedExpectation?: boolean;
  layer?: VerificationLayerKind;
  status?: VerificationStatus;
  sourceMatched?: boolean;
  /** Hash of Host-executable fixtures. Never the fixture arguments themselves. */
  fixtureDigest?: string;
  reason: string;
}
type VerifierRequestStatus = 'pending' | 'running' | 'completed' | 'cancelled' | 'timed_out';
type VerificationVerdictDecision = 'verified' | 'rejected' | 'uncertain';
/** Host-owned semantic verification job. Must not carry authorization or an install spec. */
interface VerifierRequest {
  id: string;
  installationId: string;
  reviewId: string;
  requirement: string;
  evidenceDigest: string;
  status: VerifierRequestStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}
/** Independent semantic completion verdict. Must not carry authorization, lease, endpoint, or install spec. */
interface VerificationVerdict {
  requestId: string;
  installationId: string;
  reviewId: string;
  requirementHash: string;
  evidenceDigest: string;
  verifierSessionId: string;
  verifierVersion: string;
  decision: VerificationVerdictDecision;
  evidence: string[];
  conditions: string[];
  createdAt: string;
}
interface InstallationRecord {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  reviewId: string;
  /** Current-policy installations are bound to the workflow that authorized them. */
  workflowId?: string;
  targetProfile: string;
  retention: InstallationRetention;
  dshHome: string;
  packageName: string | null;
  installSpec: string;
  ownedArtifactRoot?: string;
  artifactSha256?: string;
  /** Crash-recovery journal for the two-phase isolated-preflight/install flow. */
  installPhase?: 'prepared' | 'preflight_running' | 'preflight_passed' | 'destination_installing' | 'completed';
  /** Isolated Host evidence. This never means the live destination process loaded the bundle. */
  preflight?: {
    profile: string;
    passed: boolean;
    sourceMatched: boolean;
    verification: VerificationEvidence;
  };
  /** Present on v0.1.1+ receipts. Older v0.1.0 receipts are inferred from `installed`. */
  installState?: InstallationState;
  /** Fail-closed public outcome. Host-verified success is only `verified`. */
  installOutcome?: InstallOutcome;
  installed: boolean;
  loaded: boolean;
  verified: boolean;
  restartRequired: boolean;
  hotReload?: HotReloadEvidence;
  removed: boolean;
  verification: VerificationEvidence;
  verifierRequestId?: string;
  verifierRequest?: VerifierRequest;
  verificationVerdict?: VerificationVerdict;
  /** Redacted structured facts for a failed install command. Raw stderr is never persisted. */
  installFailure?: {
    code: string;
    message: string;
    exitCode?: number | null;
    diagnosticHash?: string;
  };
  contributionAdvice?: {
    eligible: boolean;
    reason: string;
  };
  predecessorInstallationId?: string;
  supersededByInstallationId?: string;
  replacement?: ReplacementJournal;
}
interface InstallInput {
  reviewId: string;
  targetProfile: string;
  retention: InstallationRetention;
  /** Optional human test prompt. Never forwarded into automatic Host verification. */
  verificationTask?: string;
  verificationExpectedText?: string;
  /** Host-derived managed-source artifact hash; never accepted from model tool arguments. */
  expectedArtifactSha256?: string;
  /** Host-owned same-package replacement binding. Never accepted from model tool arguments. */
  replacement?: ReplacementTarget;
}
interface RemoveInput {
  installationId: string;
}
/** Model-interpreted final authorization intent, bounded by the current interrupt. */
interface AuthorizationDecisionInput {
  action: AuthorizationAction;
  /** Required for use_this / modify_this; must belong to the action's interrupt-bound candidate set. */
  candidateId?: string;
  /** Optional for use_this. Defaults to temporary when the user did not express a preference. */
  retention?: InstallationRetention;
}
/** Public resume input keeps model interpretation separate from Host-owned facts. */
interface ResumeInput {
  workflowId: string;
  /** Required at user gates. Omit for in-session `finish_managed_work`. */
  interruptId?: string;
  /** Model-interpreted read-only navigation. Never grants a side effect except finish_managed_work. */
  navigation?: NavigationInput;
  /** Model-interpreted final action. Host validates it against the current interrupt and fresh user turn. */
  decision?: AuthorizationDecisionInput;
}
/**
 * Host-owned selection evidence. Minted only after a fresh user turn is consumed.
 * ResumeInput must not accept a model-forged copy of this object.
 */
interface SelectionReceipt {
  id: string;
  workflowId: string;
  interruptId: string;
  snapshotDigest: string;
  kind: NavigationKind | AuthorizationAction;
  candidateIds: string[];
  candidateDigests: Record<string, string>;
  hostTurnId: string;
  ownerSessionId: string;
  bootId: string;
  createdAt: string;
}
type ExecutionEndpoint = {
  kind: 'none';
} | {
  kind: 'exact_tool';
  name: string;
} | {
  kind: 'bridge';
  tools: readonly string[];
  target: string;
};
interface FrozenCandidateIdentity {
  kind: 'local' | 'remote';
  localKind?: LocalCapabilityCandidate['kind'];
  name: string;
  identity: string;
  availability?: CandidateAvailability;
  fit?: 'full' | 'partial' | 'none';
  repository?: string;
}
/** Host-derived from SelectionReceipt + the interrupt-bound candidate snapshot. */
interface ActionCommitment {
  id: string;
  selectionReceiptId: string;
  snapshotDigest: string;
  candidateId?: string;
  candidateDigest?: string;
  frozenIdentity: FrozenCandidateIdentity | {
    kind: 'none';
  };
  requestedAction: NavigationKind | AuthorizationAction;
  retention?: InstallationRetention;
  endpoint: ExecutionEndpoint;
  allowedParameterConstraints: {
    /** Exact bridge/tool target; tool_search/tool_call may not widen past this name. */
    exactTarget?: string;
  };
  createdAt: string;
  /** Host-frozen review identity. Reviewer output cannot mint these fields. */
  reviewId?: string;
  reviewSnapshotDigest?: string;
  reviewerRequestId?: string;
  reviewerVerdictDigest?: string;
  frozenManifestDigest?: string;
  frozenInstallSpec?: string | null;
  targetProfile?: string;
}
/**
 * Current-turn execution grant. Bound to commitment + session/boot/workflow + turn watermark.
 * Host may silently re-sign the next continuation only when receipt, commitment, and endpoint are unchanged.
 */
interface ExecutionLease {
  id: string;
  commitmentId: string;
  selectionReceiptId: string;
  workflowId: string;
  ownerSessionId: string;
  bootId: string;
  hostTurnId: string;
  interruptId: string;
  snapshotDigest: string;
  candidateId?: string;
  candidateDigest?: string;
  requestedAction: ActionCommitment['requestedAction'];
  endpoint: ExecutionEndpoint;
  allowedParameterConstraints: ActionCommitment['allowedParameterConstraints'];
  createdAt: string;
}
declare const BRIDGE_EXECUTION_TOOLS: readonly ["tool_search", "tool_describe", "tool_call"];
declare const FORGED_RESUME_HOST_KEYS: readonly ["selectionReceipt", "actionCommitment", "executionLease", "commitment", "lease", "endpoint", "reviewerVerdict", "verificationVerdict", "verifierVerdict", "verifierRequest"];
//#endregion
//#region src/review/direct-use.d.ts
/** Minimal snapshot context for candidate-digest binding. WorkflowRecord is assignable. */
interface ReviewCandidateContext {
  id?: string;
  candidateSnapshot?: ReadonlyArray<{
    id: string;
    kind: 'local' | 'remote';
    repository?: string;
    identity: string;
    digest?: string;
  }>;
  reviewIdsByCandidate?: Record<string, string>;
}
interface InstallCommitmentBinding {
  workflow?: ReviewCandidateContext;
  commitment?: ActionCommitment;
  receipt?: SelectionReceipt;
  retention?: ActionCommitment['retention'];
}
//#endregion
//#region src/process/runner.d.ts
interface CommandRequest {
  argv: readonly [string, ...string[]];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  allowFailure?: boolean;
}
interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}
interface CommandRunner {
  run(request: CommandRequest): Promise<CommandResult>;
  resolveExecutable?(command: string, signal?: AbortSignal): Promise<string>;
}
//#endregion
//#region src/creator-foundation.d.ts
declare const CREATOR_FOUNDATION_CONTRACT_VERSION: 2;
type CreatorOperation = 'create' | 'modify' | 'correct';
type CreatorStatus = 'verified' | 'unavailable';
interface CreatorWorkOrder {
  operation: CreatorOperation;
  requirement: string;
  baselineReview?: {
    reviewId: string;
  };
  blockers: ReadonlyArray<{
    key: string;
    kind: string;
    summary: string;
  }>;
  allowedScope: {
    cwd: string;
  };
  acceptanceTargets: readonly string[];
}
interface CreatorFoundationReceipt {
  contractVersion: typeof CREATOR_FOUNDATION_CONTRACT_VERSION;
  presetId: typeof EVOLUTION_PRESET_ID;
  compositionSha256: string;
  requiredToolCatalogDigest: string;
  /** Parent session identity. Field name kept for V8 JSON compatibility. */
  childSessionId: string;
}
interface CreatorRecord {
  operation: CreatorOperation;
  status: CreatorStatus;
  createdAt: string;
  receipt?: CreatorFoundationReceipt;
}
interface CreatorCatalog {
  tools: string[];
  skills: string[];
}
interface CreatorFoundationPreflight {
  presetId: typeof EVOLUTION_PRESET_ID;
  compositionSha256: string;
  requiredToolCatalogDigest: string;
  standingScope: unknown;
  catalog: CreatorCatalog;
}
interface CreatorFoundation {
  /**
   * `parentCtx` is the parent Agent context used to resolve live services.
   * `parentScope` is the parent Agent itself — DSH tools/skills registries
   * view by Agent, not by `agent.ctx`.
   */
  preflight(input?: {
    signal?: AbortSignal;
    parentCtx?: unknown;
    parentScope?: unknown;
  }): Promise<CreatorFoundationPreflight>;
}
//#endregion
//#region src/workflow/lifecycle.d.ts
/**
 * Public workflow lifecycle presentation. Internal `cursor` names stay on the
 * record for graph safety; this field is a deterministic mapping only.
 */
type WorkflowLifecycleState = 'searched' | 'selected' | 'reviewing' | 'approved' | 'rejected' | 'uncertain' | 'skipped' | 'awaiting_confirmation' | 'committed' | 'leased' | 'executing' | 'verified' | 'activated' | 'awaiting_user_test' | 'recovery_required' | 'restart_required' | 'market_restart_required' | 'market_setup_required' | 'modify_authorized' | 'create_authorized' | 'stopped' | 'interrupted' | 'reuse_local';
interface LifecycleMappingInput {
  reviews?: readonly ReviewRecord[];
  installation?: InstallationRecord;
}
/** Map internal cursor/status/grants to the public lifecycle state. Never claims verified early. */
declare function lifecycleStateFor(workflow: Pick<WorkflowRecord, 'status' | 'cursor' | 'policyVersion' | 'actionCommitment' | 'executionLease' | 'lastFailure'>, extras?: LifecycleMappingInput): WorkflowLifecycleState;
//#endregion
//#region src/workflow/contracts.d.ts
type WorkflowStatus = 'running' | 'interrupted' | 'completed' | 'failed';
type WorkflowNodeId = 'resolve_local' | 'discover_remote' | 'ensure_market' | 'await_discovery' | 'await_selection' | 'review_github' | 'review_existing' | 'await_confirmation' | 'prepare_modify' | 'await_modify_work' | 'complete_managed_work' | 'review_local' | 'install_verify' | 'prepare_create' | 'reuse_local' | 'stopped' | 'market_restart_required' | 'market_setup_required' | 'installed' | 'activated' | 'awaiting_user_test' | 'restart_required' | 'recovery_required' | 'create_authorized' | 'modify_authorized';
type InterruptKind = 'await_selection' | 'await_confirmation' | 'await_modify_work' | 'await_recovery';
type WorkflowOptionPlacement = 'primary' | 'advanced' | 'recovery';
interface WorkflowOption {
  id: WorkflowOptionId;
  labelEn: string;
  labelZh: string;
  /** When present, the action is valid only for these interrupt-bound snapshot candidates. */
  candidateIds?: string[];
  /** Presentation group only. Does not change Host authorization. */
  placement?: WorkflowOptionPlacement;
}
interface InterruptPayload {
  kind: InterruptKind;
  interruptId: string;
  ownerSessionId: string;
  bootId: string;
  validAfterTurnId: string;
  snapshotDigest: string;
  options: WorkflowOption[];
  facts: Record<string, unknown>;
}
interface WorkflowPendingInstall {
  targetProfile: string;
  retention: InstallationRetention;
  verificationTask?: string;
  verificationExpectedText?: string;
  replacement?: ReplacementTarget;
}
interface CandidateSnapshotItem {
  id: string;
  index: number;
  kind: 'local' | 'remote';
  name: string;
  identity: string;
  digest: string;
  repository?: string;
  localName?: string;
  localKind?: 'tool' | 'skill' | 'plugin';
  availability?: CandidateAvailability;
  fit?: 'full' | 'partial' | 'none';
  semanticFit?: 'full' | 'partial' | 'none';
  surfaceMatch?: boolean;
  reuseEligible?: boolean;
  evolutionTarget?: EvolutionTarget;
  installation?: {
    source: 'host_profile_manifest';
    profile: string;
    package_name: string;
    dependency_spec: string;
    configured_bundle: boolean;
  };
}
interface ReviewPlan {
  mode: ReviewMode;
  candidateIds: string[];
  maxReviews: 1 | 2 | 3;
}
interface ReviewFailure {
  candidateId: string;
  code: string;
  message: string;
}
interface DiscoveryBudget {
  refinementRoundsUsed: number;
  refinementQueriesUsed: string[];
  explicitRepositories: string[];
  maxRefinementRounds: 2;
  maxRefinementQueries: 5;
  maxCandidates: 20;
}
interface DiscoveryRefineInput {
  workflowId: string;
  queries?: string[];
  repositories?: string[];
}
interface DiscoveryPresentInput {
  workflowId: string;
  candidateIds: string[];
}
type DiagnosticProbe = 'discovery' | 'review' | 'installation' | 'verification' | 'managed_child' | 'cleanup';
interface WorkflowDiagnoseInput {
  workflowId: string;
  probes: DiagnosticProbe[];
}
interface DiagnosticFact {
  probe: DiagnosticProbe;
  status: 'pass' | 'failed' | 'unknown' | 'skipped';
  code: string;
  summary: string;
  observed: boolean;
  evidenceHash?: string;
  facts?: Record<string, boolean | number | string | string[]>;
}
interface WorkflowDiagnosis {
  createdAt: string;
  probes: DiagnosticProbe[];
  facts: DiagnosticFact[];
  budget: {
    maxCalls: 2;
    usedCalls: number;
    maxProbes: 8;
    usedProbes: number;
    maxRecordReads: 4;
    usedRecordReads: number;
  };
}
interface InvalidResumeAttempt {
  hostTurnId: string;
  fingerprint: string;
  count: number;
}
interface WorkflowRecoveryInput {
  workflowId: string;
  /** Required for sealed recovery_required interrupts. Omit for completed-install restart. */
  interruptId?: string;
}
interface WorkflowRecoveryRecord {
  action: 'cleanup_and_restart';
  hostTurnId: string;
  cleanup: 'not_required' | 'already_removed' | 'removed';
  installationId?: string;
  restartRequired: boolean;
  restartedAsWorkflowId: string;
  completedAt: string;
}
type WorkflowFailureStage = 'discovery' | 'review' | 'managed_child' | 'install' | 'verification' | 'hot_load' | 'workflow';
interface WorkflowFailure {
  stage: WorkflowFailureStage;
  code: string;
  message: string;
  retryable: boolean;
  diagnosticHash?: string;
}
interface ModificationBlocker {
  key: string;
  kind: 'compatibility' | 'missing_capability' | 'security_finding' | 'host_boundary';
  summary: string;
}
type ModificationCheckStatus = 'passed' | 'failed' | 'skipped' | 'unknown' | 'unavailable';
interface ModificationCheckEvidence {
  source: 'host_observed' | 'child_reported' | 'unknown';
  status: ModificationCheckStatus;
  summary: string;
}
interface ModificationAttemptEvidence {
  attempt: number;
  childSessionId: string;
  commit: string;
  changedFiles: string[];
  changedFilesTruncated: boolean;
  postReviewId: string;
  completionMarkerObserved: boolean;
  checks: ModificationCheckEvidence;
}
interface ModificationOutcome {
  contractVersion: 1;
  policyVersion: string;
  baselineReviewId: string;
  instructionHash?: string;
  baselineRuntimeVersion: string | null;
  maxAttempts: 2;
  automaticCorrectionUsed: boolean;
  status: 'resolved' | 'unresolved' | 'indeterminate';
  attempts: ModificationAttemptEvidence[];
  resolvedBlockers: ModificationBlocker[];
  unresolvedBlockers: ModificationBlocker[];
  introducedBlockers: ModificationBlocker[];
}
interface ConsumedVerificationAttempt {
  reviewId: string;
  sourceIdentity: string;
  layer: string;
  fixtureDigest?: string;
}
interface WorkflowRecord {
  schemaVersion: 1 | 2;
  id: string;
  policyVersion: string;
  createdAt: string;
  updatedAt: string;
  requirement: string;
  requirementNormalized?: string;
  cwd?: string;
  ownerSessionId?: string;
  bootId?: string;
  resolutionId?: string;
  status: WorkflowStatus;
  cursor: WorkflowNodeId;
  generation: number;
  interrupt?: InterruptPayload;
  consumedInterruptIds?: string[];
  lineageTipReviewId?: string;
  lastReviewId?: string;
  lastInstallationId?: string;
  forceRemoteDiscovery?: boolean;
  /** Host-verified candidates available for model curation before Gate 1. */
  discoveryPool?: CandidateSnapshotItem[];
  discoveryBudget?: DiscoveryBudget;
  candidateSnapshot?: CandidateSnapshotItem[];
  seenCandidateIds?: string[];
  rejectedCandidateIds?: string[];
  selectionReceipt?: SelectionReceipt;
  actionCommitment?: ActionCommitment;
  executionLease?: ExecutionLease;
  reviewPlan?: ReviewPlan;
  reviewQueue?: string[];
  reviewedCandidateIds?: string[];
  reviewIdsByCandidate?: Record<string, string>;
  reviewFailures?: ReviewFailure[];
  pendingRepositories?: string[];
  pendingRef?: string;
  pendingPath?: string;
  pendingWorkOrder?: CreatorWorkOrder;
  pendingInstall?: WorkflowPendingInstall;
  managedSourceId?: string;
  modificationOutcome?: ModificationOutcome;
  /** Optional bounded Creator foundation records. Absent on schemaVersion 1/2 legacy JSON. */
  creatorRecords?: CreatorRecord[];
  lastFailure?: WorkflowFailure;
  lastDiagnosis?: WorkflowDiagnosis;
  invalidResumeAttempt?: InvalidResumeAttempt;
  consumedVerificationAttempts?: ConsumedVerificationAttempt[];
  completionTurnId?: string;
  recovery?: WorkflowRecoveryRecord;
  recoveredFromWorkflowId?: string;
  error?: {
    code: string;
    message: string;
  };
  intent?: RequestIntent;
  pendingReviewedCandidateId?: string;
}
type WorkflowViewStatus = 'progressed' | 'parked' | 'invalid_resume';
interface AgentShortlistItem {
  index: number;
  candidate_id: string;
  name: string;
  repository?: string;
  why?: string;
  fit?: string;
  recommendation?: string;
}
interface AgentLegalActions {
  navigation: WorkflowOptionId[];
  decision: WorkflowOptionId[];
}
interface WorkflowView {
  workflow: WorkflowRecord;
  /** Public lifecycle presentation. Internal `workflow.cursor` remains the graph cursor. */
  lifecycleState: WorkflowLifecycleState;
  resolution?: ResolutionRecord;
  review?: ReviewRecord;
  reviews?: ReviewRecord[];
  installation?: InstallationRecord;
  diagnosis?: WorkflowDiagnosis;
  nextStep?: string;
  /** Model-facing outcome. `parked` and `invalid_resume` are successful tool results, not errors. */
  status?: WorkflowViewStatus;
  phase?: InterruptKind | WorkflowNodeId;
  shortlist?: AgentShortlistItem[];
  legal?: AgentLegalActions;
  agentDirective?: string;
  alreadyWaiting?: boolean;
  resumeHint?: string;
}
interface ValidatedResume {
  optionId: AuthorizationAction;
  userMessage: string;
  hostTurnId: string;
  interruptId: string;
  snapshotDigest: string;
  candidateId?: string;
  repositories: string[];
  path?: string;
  ref?: string;
  reviewId?: string;
  install?: WorkflowPendingInstall;
}
interface MarketplaceStepResult {
  status: 'loaded' | 'restart' | 'blocked' | 'empty';
  reason: string;
}
interface WorkflowHost {
  bootstrapResolution(requirement: string, exec: WorkflowExec, intent?: RequestIntent): Promise<ResolutionRecord>;
  discoverRemote(resolution: ResolutionRecord, exec: WorkflowExec): Promise<ResolutionRecord>;
  refineRemote?(resolution: ResolutionRecord, input: {
    queries: string[];
    repositories: string[];
  }, exec: WorkflowExec): Promise<ResolutionRecord>;
  ensureMarket(resolution: ResolutionRecord, exec: WorkflowExec): Promise<{
    resolution: ResolutionRecord;
    market: MarketplaceStepResult;
  }>;
  reviewGithub(resolution: ResolutionRecord, repository: string, ref: string | undefined, exec: WorkflowExec, workflow?: WorkflowRecord): Promise<{
    resolution: ResolutionRecord;
    review: ReviewRecord;
  }>;
  reviewExisting?(resolution: ResolutionRecord, target: EvolutionTarget, exec: WorkflowExec, workflow?: WorkflowRecord): Promise<{
    resolution: ResolutionRecord;
    review: ReviewRecord;
  }>;
  reviewGithubBatch?(resolution: ResolutionRecord, repositories: string[], mode: ReviewMode, exec: WorkflowExec, workflow?: WorkflowRecord): Promise<{
    resolution: ResolutionRecord;
    reviews: ReviewRecord[];
    failures: Array<{
      repository: string;
      code: string;
      message: string;
    }>;
  }>;
  reviewLocal(resolution: ResolutionRecord, path: string, baseReviewId: string, exec: WorkflowExec, workflow?: WorkflowRecord): Promise<{
    resolution: ResolutionRecord;
    review: ReviewRecord;
  }>;
  installReviewed(review: ReviewRecord, input: WorkflowPendingInstall, exec: WorkflowExec, workflow?: WorkflowRecord): Promise<InstallationRecord>;
  prepareModify?(resolution: ResolutionRecord, review: ReviewRecord, exec: WorkflowExec, workflow: WorkflowRecord): Promise<{
    resolution: ResolutionRecord;
    path?: string;
    review?: ReviewRecord;
  }>;
  prepareCreate?(resolution: ResolutionRecord, exec: WorkflowExec, workflow: WorkflowRecord): Promise<{
    resolution: ResolutionRecord;
    path?: string;
    review?: ReviewRecord;
  }>;
  finishManagedWork?(resolution: ResolutionRecord, exec: WorkflowExec, workflow: WorkflowRecord): Promise<{
    resolution: ResolutionRecord;
    path?: string;
    review?: ReviewRecord;
    continueConstruction?: boolean;
  }>;
  applyDecision(resolution: ResolutionRecord, resume: ValidatedResume, review?: ReviewRecord, workflow?: WorkflowRecord): Promise<ResolutionRecord>;
  applyNavigation?(resolution: ResolutionRecord, navigation: NavigationInput, repositories: string[]): Promise<ResolutionRecord>;
  latestReview(resolutionId: string, reviewId?: string): Promise<ReviewRecord | undefined>;
  getResolution(id: string): Promise<ResolutionRecord>;
  getReview(id: string): Promise<ReviewRecord>;
  getInstallation(id: string): Promise<InstallationRecord>;
  listInstallProfiles?(): Promise<string[]>;
  cleanupInstallation?(installationId: string, exec: WorkflowExec): Promise<{
    installationId: string;
    removed: boolean;
    restartRequired: boolean;
  }>;
  releaseManagedSource?(workflow: WorkflowRecord, exec: WorkflowExec): Promise<void>;
}
interface WorkflowExec {
  agent?: import('@deepseek-ai/dsh-agent').Agent;
  signal?: AbortSignal;
  callId?: string;
}
//#endregion
//#region src/creation-guard.d.ts
interface AgentGateState {
  generation: number;
  activeResolutionId?: string;
  authorization?: ResolutionAuthorization;
  lastUserMessage?: string;
  currentTurnId?: string;
  turnSequence: number;
  consumedTurnIds: Set<string>;
  waitingKind?: 'await_discovery' | 'await_selection' | 'await_confirmation' | 'await_modify_work' | 'await_recovery';
  interruptWatermarkTurnId?: string;
  sessionId?: string;
  selectionReceipt?: SelectionReceipt;
  actionCommitment?: ActionCommitment;
  executionLease?: ExecutionLease;
  constructionRoot?: string;
}
interface UserFacingMessage {
  content?: readonly unknown[];
}
interface ClaimedHostTurn {
  turnId: string;
  message: string;
  sequence: number;
}
interface CreationGuardOptions {
  /** True only when agentPresets.serviceFor(agent, 'autoevoEvolutionMode') yields exact marker. */
  isEvolutionMode?: (agent: Agent) => boolean;
  /** Service boot identity; interrupts bound to a prior boot are invalidated. */
  bootId?: string;
}
/** Runtime-only, fail-closed authorization for AutoEvo parent-session decisions. */
declare class CreationGuard {
  private readonly options;
  private readonly states;
  private nextGeneration;
  readonly bootId: string;
  constructor(options?: CreationGuardOptions);
  beginResolution(agent?: Agent): number | undefined;
  rememberUserMessage(agent: Agent | undefined, message: UserFacingMessage): void;
  lastUserMessage(agent: Agent | undefined): string | undefined;
  currentTurnId(agent: Agent | undefined): string | undefined;
  setConstructionRoot(agent: Agent | undefined, root: string | undefined): void;
  constructionRoot(agent: Agent | undefined): string | undefined;
  /**
   * True when resume must park: no claimed turn, or the claimed turn is the
   * interrupt-issuing turn. Does not consume the turn.
   */
  isAwaitingFreshUserTurn(agent: Agent | undefined, interrupt: InterruptPayload): boolean;
  /**
   * Validate and return the latest host-owned user turn without consuming it.
   * Callers use this to finish all local validation before claiming authority.
   */
  previewDecisionTurn(agent: Agent | undefined, interrupt: InterruptPayload): ClaimedHostTurn;
  /**
   * Consume the latest host-owned user turn after all caller-side validation.
   * Rejects missing turns, replay, and stale turns before mutating the ledger.
   */
  consumeDecisionTurn(agent: Agent | undefined, interrupt: InterruptPayload): ClaimedHostTurn;
  /**
   * Host-owned grant. Never accepted from ResumeInput.
   * `lease` is omitted when the commitment endpoint is `none`.
   */
  grantHostSelection(agent: Agent | undefined, receipt: SelectionReceipt, commitment: ActionCommitment, lease?: ExecutionLease): void;
  invalidateExecutionLease(agent: Agent | undefined): void;
  activeExecutionLease(agent: Agent | undefined): ExecutionLease | undefined;
  setWaiting(agent: Agent | undefined, kind?: AgentGateState['waitingKind'], watermarkTurnId?: string): void;
  applyResolutionAuthorization(agent: Agent | undefined, authorization: ResolutionAuthorization, generation: number | undefined): boolean;
  applyReviewAuthorization(agent: Agent | undefined, authorization: ResolutionAuthorization): boolean;
  assertInstallAuthorized(agent: Agent | undefined, review: ReviewRecord, resolution: Pick<ResolutionRecord, 'id' | 'decisions'>, binding?: InstallCommitmentBinding): void;
  private inEvolutionMode;
  protocolDenial(exec: Readonly<ToolExecution>): string | undefined;
  preExecute(exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>;
  /** Final monotonic check: no earlier waterfall listener can override this denial. */
  guard(exec: Readonly<ToolExecution>): string | undefined;
  result(_exec: Readonly<ToolExecution>, _result: Readonly<ToolExecutionResult>): void;
  private managedConstructionDenial;
  authorization(agent: Agent): ResolutionAuthorization | undefined;
  private resignLeaseIfUnchanged;
}
//#endregion
//#region src/execution-guard.d.ts
type ExecutionRole = 'parent' | 'child' | 'constructor';
interface ExecutionGuardOptions {
  role: ExecutionRole;
  /** Absolute managed-source root. Required for constructor path scoping. */
  allowedRoot?: string;
}
/**
 * Final execution-layer guard for AutoEvo parent and in-parent managed construction.
 * Prompts are not enforcement; denials here are observable and rejectable.
 */
declare class ExecutionGuard {
  private readonly options;
  constructor(options: ExecutionGuardOptions);
  get role(): ExecutionRole;
  denyReason(exec: Readonly<ToolExecution>): string | undefined;
  preExecute(exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>;
  guard(exec: Readonly<ToolExecution>): string | undefined;
  private parentDenial;
  private constructorDenial;
  private childDenial;
}
//#endregion
//#region src/lifecycle/decide.d.ts
declare function reviewIdentity(review: ReviewRecord): string;
//#endregion
//#region src/host-verification-driver.d.ts
interface HostExecutableFixture {
  tool: string;
  arguments: Record<string, unknown>;
}
interface HostLayerSelection {
  layer: VerificationLayerKind;
  reason: string;
  fixtures: HostExecutableFixture[];
  fixtureDigest: string;
  expectedTools: string[];
}
/** Candidate risk/approval/safe flags are never Host attestation. Kept as an explicit untrusted probe. */
declare function inspectLoadedToolSafety(tool: object): {
  safe: boolean;
  reason: string;
};
/**
 * Install-time layer selection. Risk signals only downgrade. Plugin-declared
 * `safe:true` / `risk:'safe'` cannot mint tool_roundtrip. Authorization comes
 * only from frozen Host-attested review fixtures plus namespaced JSON arguments.
 */
declare function selectInstallVerificationLayer(input: {
  review: Pick<ReviewRecord, 'manifest' | 'runtimeSurface'>;
  declaredFixtures: Record<string, unknown>;
}): HostLayerSelection;
/** Installation receipt: layer/status, source match, tool names, counts, stable diagnostics. */
declare function sanitizeHostVerificationEvidence(input: {
  attempted: boolean;
  layer: VerificationLayerKind;
  status: VerificationStatus;
  reason: string;
  expectedTools: readonly string[];
  calledTools?: readonly string[];
  resultTools?: readonly string[];
  failedTools?: readonly string[];
  exitCode?: number | null;
  sourceMatched?: boolean;
  fixtureDigest?: string;
  launchEvidence?: VerificationEvidence['launchEvidence'];
}): VerificationEvidence;
declare function hostLayerSuccess(input: {
  sourceMatched: boolean;
  layer: VerificationLayerKind;
  verification: Pick<VerificationEvidence, 'attempted' | 'exitCode' | 'expectedTools' | 'calledTools' | 'resultTools' | 'failedTools' | 'layer' | 'status'>;
}): boolean;
declare function verificationChildEnv(dshHome: string, parent?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
//#endregion
//#region src/semantic-host.d.ts
declare function requirementHashFor(requirement: string): string;
//#endregion
//#region src/semantic-verifier.d.ts
declare const VERIFIER_SUBMIT_TOOL = "autoevo_submit_verification";
declare const VERIFIER_VERSION = "1";
/** Bounded Host receipt for the verifier. Never includes secrets or source paths. */
interface RedactedVerificationReceipt {
  expectedTools: string[];
  calledTools: string[];
  resultTools: string[];
  failedTools: string[];
  taskResultObserved: boolean;
  taskResultSha256?: string;
  observedProvider?: string;
  observedModel?: string;
  routeMatchedExpectation?: boolean;
  exitCode?: number | null;
  launchEvidence?: VerificationEvidence['launchEvidence'];
}
interface VerifierRunInput {
  parent: Agent;
  installationId: string;
  reviewId: string;
  requirement: string;
  evidenceDigest: string;
  receipt: RedactedVerificationReceipt;
  signal?: AbortSignal;
  timeoutMs: number;
}
interface SemanticVerifierResult {
  request: VerifierRequest;
  verdict: VerificationVerdict;
}
interface SemanticVerifierHost {
  run(input: VerifierRunInput): Promise<SemanticVerifierResult>;
}
declare function verificationEvidenceDigest(evidence: Pick<VerificationEvidence, 'expectedTools' | 'calledTools' | 'resultTools' | 'failedTools' | 'taskResultObserved' | 'taskResultSha256' | 'observedProvider' | 'observedModel' | 'routeMatchedExpectation' | 'exitCode' | 'launchEvidence'>): string;
declare function mintVerifierRequest(input: {
  installationId: string;
  reviewId: string;
  requirement: string;
  evidenceDigest: string;
  createdAt?: string;
}): VerifierRequest;
declare function verificationVerdictAllowsCompletion(verdict: VerificationVerdict | undefined, expected: {
  installationId: string;
  reviewId: string;
  requirement: string;
  evidenceDigest: string;
}): boolean;
/** Real Host-owned DSH semantic verifier lifecycle. */
declare class DshSemanticVerifierHost implements SemanticVerifierHost {
  private readonly ctx;
  constructor(ctx: Context);
  run(input: VerifierRunInput): Promise<SemanticVerifierResult>;
}
//#endregion
//#region src/state/store.d.ts
type RecordKind = 'resolutions' | 'reviews' | 'installations' | 'workflows';
type StoredRecord = ResolutionRecord | ReviewRecord | InstallationRecord | WorkflowRecord;
declare class StateStore {
  private readonly resolveRoot;
  constructor(root: string | (() => string));
  get root(): string;
  trialRoot(installationId: string): string;
  put(kind: RecordKind, record: StoredRecord): Promise<void>;
  getResolution(id: string): Promise<ResolutionRecord>;
  getReview(id: string): Promise<ReviewRecord>;
  getInstallation(id: string): Promise<InstallationRecord>;
  getWorkflow(id: string): Promise<WorkflowRecord>;
  listWorkflows(): Promise<WorkflowRecord[]>;
  listInstallations(): Promise<InstallationRecord[]>;
  listAllReviews(): Promise<ReviewRecord[]>;
  listReviews(resolutionId: string): Promise<ReviewRecord[]>;
  private readReviews;
  private get;
}
//#endregion
//#region src/lifecycle/snapshot.d.ts
interface MaterializedLocalPackage {
  installSpec: string;
  artifactRoot: string;
  artifactSha256: string;
}
//#endregion
//#region src/lifecycle/launcher.d.ts
declare class DshLauncher {
  private readonly runner;
  private readonly config;
  constructor(runner: CommandRunner, config: RuntimeConfig);
  materializeLocal(review: ReviewRecord, artifactRoot: string, signal?: AbortSignal): Promise<MaterializedLocalPackage>;
  private argv;
  private childEnv;
  install(dshHome: string, profile: string, spec: string, cwd: string, signal?: AbortSignal, options?: {
    forwardCredentials?: boolean;
  }): Promise<CommandResult>;
  remove(dshHome: string, profile: string, packageName: string, cwd: string, signal?: AbortSignal): Promise<CommandResult>;
  hasProfileDependency(dshHome: string, profile: string, packageName: string): Promise<boolean>;
  profileDependencySpec(dshHome: string, profile: string, packageName: string): Promise<string | undefined>;
  /** Verify that the target profile records the exact reviewed source and loads that bundle. */
  profileSourceMatches(dshHome: string, profile: string, packageName: string, expectedSpec: string): Promise<boolean>;
  /** Confirm absence in both the profile manifest and its visible node_modules target. */
  profileTargetAbsent(dshHome: string, profile: string, packageName: string): Promise<boolean>;
  verify(dshHome: string, profile: string, cwd: string, task: string, expectedTools: readonly string[], expectedText?: string, expectedRoute?: {
    provider: string;
    model?: string;
  }, signal?: AbortSignal): Promise<VerificationEvidence>;
  readInstalledVerificationFixtures(dshHome: string, profile: string, packageName: string): Promise<Record<string, unknown>>;
  /**
   * Host-owned mechanical verification. Never forwards credentials, never
   * passes a user task, and never boots an Agent turn or default model route.
   */
  readInstalledActivationTargets(dshHome: string, profile: string, packageName: string): Promise<ActivatedFiber[]>;
  verifyHost(input: {
    dshHome: string;
    profile: string;
    cwd: string;
    layer: Exclude<VerificationLayerKind, 'manual_runtime'>;
    packageName: string;
    expectedTools: readonly string[];
    fixtures: readonly HostExecutableFixture[];
    fixtureDigest: string;
    activatedFibers?: readonly ActivatedFiber[];
    signal?: AbortSignal;
  }): Promise<VerificationEvidence>;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+cosmokit@1.8.2/node_modules/@deepseek-ai/cosmokit/lib/types/misc.d.ts
/** String/symbol keyed dictionary type. */
type Dict<T = any, K extends string | symbol = string> = { [key in K]: T; };
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+cordis-plugin-_6bbed33e411487075eb8aac91da6ecf2/node_modules/@deepseek-ai/cordis-plugin-loader/lib/types/internal.d.ts
/** Node internal module format names handled by loader hooks. */
type ModuleFormat = 'builtin' | 'commonjs' | 'json' | 'module' | 'wasm';
/** Source payload accepted by Node internal module load hooks. */
type ModuleSource = string | ArrayBuffer;
/** Result returned by a Node internal resolve hook. */
interface ResolveResult {
  format: ModuleFormat;
  url: string;
}
/** Result returned by a Node internal load hook. */
interface LoadResult {
  format: ModuleFormat;
  source?: ModuleSource;
}
type LoadCacheData = ModuleJob;
/** @see https://github.com/nodejs/node/blob/main/lib/internal/modules/esm/module_map.js */
interface LoadCache extends Omit<Map<string, Dict<LoadCacheData>>, 'get' | 'set' | 'has'> {
  get(url: string, type?: string): LoadCacheData | undefined;
  set(url: string, type?: string, job?: LoadCacheData): this;
  has(url: string, type?: string): boolean;
}
/** Minimal Node internal ModuleWrap surface used by HMR helpers. */
interface ModuleWrap {
  url: string;
  getNamespace(): any;
}
/** @see https://github.com/nodejs/node/blob/main/lib/internal/modules/esm/module_job.js */
interface ModuleJob {
  url: string;
  loader: ModuleLoader;
  module?: ModuleWrap;
  importAttributes: ImportAttributes;
  linked: Promise<ModuleJob[]>;
  instantiate(): Promise<void>;
  run(): Promise<{
    module: ModuleWrap;
  }>;
}
/**
 * Node 22/23 ModuleLoader interface.
 *
 * Key methods:
 * - getModuleJobForImport(specifier, parentURL, importAttributes)
 * - resolve(specifier, parentURL, importAttributes) → Promise<ResolveResult>
 * - resolveSync(specifier, parentURL, importAttributes) → ResolveResult
 */
interface ModuleLoaderV1 {
  version: 'v1';
  loadCache: LoadCache;
  import(specifier: string, parentURL: string, importAttributes: ImportAttributes): Promise<any>;
  register(specifier: string | URL, parentURL?: string | URL, data?: any, transferList?: any[]): void;
  getModuleJobForImport(specifier: string, parentURL: string, importAttributes: ImportAttributes): Promise<ModuleJob>;
  resolve(specifier: string, parentURL: string, importAttributes: ImportAttributes): Promise<ResolveResult>;
  resolveSync(specifier: string, parentURL: string, importAttributes: ImportAttributes): ResolveResult;
  load(specifier: string, context: Pick<LoadHookContext, 'format' | 'importAttributes'>): Promise<LoadResult>;
}
/** Node 24+ module request object. */
interface ModuleRequest {
  specifier: string;
  attributes?: ImportAttributes;
  phase?: ModulePhase;
}
/** @see https://github.com/nodejs/node/blob/main/src/module_wrap.h */
declare const enum ModulePhase {
  Source = 1,
  Evaluation = 2
}
/** Opaque Node internal module request type marker. */
type ModuleRequestType = unknown;
/**
 * Node 24+ ModuleLoader interface.
 *
 * Breaking changes from v1:
 * - getModuleJobForImport removed → getOrCreateModuleJob(parentURL, request, requestType)
 * - resolve removed (became private #resolve) → resolveSync(parentURL, request)
 * - Parameter order reversed for resolveSync, request object { specifier, attributes }
 * - LoadCache became typed Map<url, { [type]: ModuleJob }> with delete only setting undefined
 */
interface ModuleLoaderV2 {
  version: 'v2';
  loadCache: LoadCache;
  import(specifier: string, parentURL: string, importAttributes: ImportAttributes, phase?: ModulePhase, isEntryPoint?: boolean): Promise<any>;
  register(specifier: string | URL, parentURL?: string | URL, data?: any, transferList?: any[], isInternal?: boolean): void;
  getOrCreateModuleJob(parentURL: string, request: ModuleRequest, requestType?: ModuleRequestType): Promise<ModuleJob>;
  resolveSync(parentURL: string, request: ModuleRequest): ResolveResult;
  load(url: string, context: Pick<LoadHookContext, 'format' | 'importAttributes'>): Promise<LoadResult>;
}
/** Supported Node internal ESM loader shapes. */
type ModuleLoader = ModuleLoaderV1 | ModuleLoaderV2;
/** Helpers for locating the current Node internal module loader. */
declare namespace ModuleLoader {
  function fromInternal(): ModuleLoader | undefined;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+cordis-plugin-_6bbed33e411487075eb8aac91da6ecf2/node_modules/@deepseek-ai/cordis-plugin-loader/lib/types/config/tree.d.ts
/** Mutable tree of loader entries. Persistence is supplied by subclasses. */
declare abstract class EntryTree {
  static readonly sep = ":";
  ctx: Context;
  enableLogs?: boolean;
  root: EntryGroup;
  store: Dict<Entry>;
  constructor(ctx: Context);
  get context(): Context;
  /** Iterate entries in this tree and any nested subtrees. */
  entries(): Generator<Entry, void, void>;
  /** Return pending import and lifecycle tasks owned by this tree. */
  getTasks(): Promise<void>[];
  /**
   * Wait until this tree has no active import or lifecycle tasks.
   * @throws a settled fiber failure, or an aggregate when several fibers failed.
   */
  await(): Promise<void>;
  ensureId(options: Partial<EntryOptions>): string;
  /** Resolve an entry by id, including nested ids separated by `EntryTree.sep`. */
  resolve(id: string): Entry;
  resolveGroup(id: string | null): EntryGroup;
  /** Create an entry in the root group or a nested group. */
  create(options: Omit<EntryOptions, 'id'>, parent?: string | null, position?: number): Promise<string>;
  /** Stop and remove an entry from its parent group. */
  remove(id: string): Promise<void>;
  /** Update an entry and optionally move it to another group. */
  update(id: string, options: Omit<EntryOptions, 'id' | 'name'>, parent?: string | null, position?: number): Promise<void>;
  /** Import a plugin module from a specifier or `cordis:` builtin. */
  import(name: string, getOuterStack?: () => string[]): any;
  /** Persist current tree state. In-memory trees may implement this as a no-op. */
  abstract write(): void;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+cordis-plugin-_6bbed33e411487075eb8aac91da6ecf2/node_modules/@deepseek-ai/cordis-plugin-loader/lib/types/config/group.d.ts
/** Runtime owner for a list of child loader entries. */
declare class EntryGroup {
  ctx: Context;
  tree: EntryTree;
  static readonly key: unique symbol;
  data: EntryOptions[];
  constructor(ctx: Context, tree: EntryTree);
  get context(): Context;
  create(options: Omit<EntryOptions, 'id'>): Promise<string>;
  unlink(options: EntryOptions): void;
  remove(id: string, isDispose?: boolean): Promise<void>;
  update(config: EntryOptions[]): Promise<void>;
  stop(): Promise<void>;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+cordis-plugin-_6bbed33e411487075eb8aac91da6ecf2/node_modules/@deepseek-ai/cordis-plugin-loader/lib/types/config/entry.d.ts
/** Serialized plugin entry options stored in loader config files. */
interface EntryOptions {
  /** Stable id inside the containing entry tree. */
  id: string;
  /** Module specifier imported by the entry tree. */
  name: string;
  /** Config passed to the plugin. */
  config?: any;
  /** Marks this entry as a nested group. */
  group?: boolean | null;
  /** Prevents this entry and descendants from running. */
  disabled?: boolean | null;
  /** Required services or service intercept config for this entry. */
  inject?: Inject | null;
}
/** One configured plugin node inside an `EntryTree`. */
declare class Entry {
  loader: Loader;
  static readonly key: unique symbol;
  ctx: Context;
  fiber?: Fiber;
  parent: EntryGroup;
  options: EntryOptions;
  subgroup?: EntryGroup;
  subtree?: EntryTree;
  _initTask?: Promise<void>;
  _disposing: number;
  constructor(loader: Loader);
  get context(): Context;
  get id(): string;
  /** True when this entry or any owning parent entry is disabled. */
  get disabled(): boolean;
  private _disabled;
  /**
   * Effective disabled state: a `!!js` expression evaluates against the loader
   * context. The raw node stays in the options, so write-back keeps the form.
   */
  private disabledOf;
  evaluate(expr: string): any;
  private _patchContext;
  refresh(): Promise<void>;
  _dispose(fiber?: Fiber | undefined): Promise<void>;
  /** Merge new options, restart as needed, and persist through the parent tree. */
  update(options: Partial<EntryOptions>, create?: boolean, force?: boolean): Promise<void>;
  getOuterStack: () => string[];
  /** Import and start the configured plugin if it is not already running. */
  init(): Promise<void>;
  _await(): Promise<void>;
  private _init;
  private _start;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+cordis-plugin-_6bbed33e411487075eb8aac91da6ecf2/node_modules/@deepseek-ai/cordis-plugin-loader/lib/types/config/isolate.d.ts
declare module './entry.ts' {
  interface EntryOptions {
    intercept?: Dict | null;
    isolate?: Dict<true | string> | null;
  }
  interface Entry {
    realm: LocalRealm;
  }
}
/** Symbol realm used to isolate service implementations by entry or label. */
declare abstract class Realm {
  protected store: Dict<symbol>;
  abstract get suffix(): string;
  access(key: string, create?: boolean): symbol;
  delete(key: string): void;
  get size(): number;
}
/** Entry-local isolation realm. */
declare class LocalRealm extends Realm {
  private entry;
  constructor(entry: Entry);
  get suffix(): string;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+cordis-plugin-_6bbed33e411487075eb8aac91da6ecf2/node_modules/@deepseek-ai/cordis-plugin-loader/lib/types/index.d.ts
declare module '@deepseek-ai/cordis' {
  interface Events {
    'exit'(signal: NodeJS.Signals): Promise<void>;
    'loader/config-update'(): void;
    'loader/entry-init'(entry: Entry): void;
    'loader/partial-dispose'(entry: Entry, legacy: Partial<EntryOptions>, active: boolean): void;
    'loader/patch-context'(entry: Entry, next: () => void | Promise<void>): void | Promise<void>;
  }
  interface Context {
    loader: Loader;
  }
  interface EnvData {
    startTime?: number;
  }
  interface Fiber {
    entry?: Entry;
  }
}
/** Loader config and dependency intercept namespace. */
declare namespace Loader {
  /** Root loader configuration. */
  interface Config {
    /** Base URL used to resolve relative plugin specifiers and config paths. */
    baseUrl?: string;
  }
  /** Intercept config used when other plugins depend on `loader`. */
  interface Intercept {
    /** Keep dependent plugins pending while loader entries are still loading. */
    await?: boolean;
  }
}
/**
 * Service that owns a loader entry tree and imports configured plugins.
 *
 * Subclasses provide persistence by implementing `write()` on `EntryTree`.
 */
declare class Loader extends EntryTree {
  config: Loader.Config;
  [Service.config]: Loader.Intercept;
  envData: any;
  name: string;
  internal: ModuleLoader | undefined;
  builtins: Dict<any>;
  constructor(ctx: Context, config?: Loader.Config);
  write(): void;
  [Service.check](): boolean;
  showLog(entry: Entry, type: string): void;
  /** Return the loader entry id that owns `fiber`, if any. */
  locate(fiber?: Fiber): string | undefined;
  /** Hook for hosts that can restart the process on full-reload requests. */
  exit(): void;
  /** Normalize ESM/CJS/default export shapes before applying a plugin. */
  unwrapExports(exports: any): any;
}
//#endregion
//#region src/lifecycle/hot-load.d.ts
interface HotReloadAttempt {
  evidence: HotReloadEvidence;
  /** Restore the exact previous Loader group after later receipt failure. */
  rollback?: () => Promise<void>;
  rollbackFailed?: boolean;
}
//#endregion
//#region src/lifecycle/install.d.ts
type ReviewRevalidator = (review: ReviewRecord, signal?: AbortSignal) => Promise<boolean>;
type InstallAuthorizer = (review: ReviewRecord, exec: ToolRunContext, binding?: InstallCommitmentBinding) => void | Promise<void>;
type ProfileHotLoader = (input: {
  ctx: Context;
  dshHome: string;
  profile: string;
  packageName: string;
  expectedTools: readonly string[];
  agent?: ToolRunContext['agent'];
}) => Promise<HotReloadAttempt>;
declare class PluginInstaller {
  private readonly ctx;
  private readonly config;
  private readonly store;
  private readonly launcher;
  private readonly revalidate;
  private readonly authorizeInstall?;
  private readonly semanticVerifier?;
  private readonly preflightProfile?;
  private readonly resolveDestinationProfile?;
  private readonly hotLoader;
  constructor(ctx: Context, config: RuntimeConfig, store: StateStore, launcher: DshLauncher, revalidate: ReviewRevalidator, authorizeInstall?: InstallAuthorizer | undefined, hotLoader?: ProfileHotLoader, semanticVerifier?: SemanticVerifierHost | undefined, preflightProfile?: string | undefined, resolveDestinationProfile?: (() => Promise<string>) | undefined);
  private removeOwnedDirectory;
  private assertPersistentDestination;
  private assertReplacementBinding;
  private resolvePredecessor;
  private reconcileReplacement;
  install(input: InstallInput, exec: ToolRunContext, binding?: InstallCommitmentBinding): Promise<InstallationRecord>;
  private attachSemanticVerification;
}
//#endregion
//#region src/lifecycle/remove.d.ts
interface RemovalResult {
  installationId: string;
  removed: boolean;
  stillVisible: boolean;
  cleanup: string;
  restartRequired: boolean;
}
declare class PluginRemover {
  private readonly ctx;
  private readonly config;
  private readonly store;
  private readonly launcher;
  constructor(ctx: Context, config: RuntimeConfig, store: StateStore, launcher: DshLauncher);
  /**
   * Uninstalls exactly one installation receipt.
   * Never deletes a managed source repository under the workspace sources dir.
   */
  remove(input: RemoveInput, exec: ToolRunContext): Promise<RemovalResult>;
}
//#endregion
//#region src/sandbox-probe.d.ts
interface LiveSandboxStack {
  sandbox?: SandboxProvider;
  sandboxPolicy?: SandboxPolicyService;
  fs?: FileSystem;
  runner?: CommandRunner;
}
interface SandboxProbeResult {
  ok: true;
  mode: 'workspace-write';
  cwd: string;
  platform: NodeJS.Platform;
  enforcement: 'full' | 'partial';
  isolation: 'integrity-partial';
  note: string;
}
/**
 * Probe the official rc.6 DSH policy, filesystem, and subprocess sandbox seams.
 * The probe runs only after a child session exists and has a durable
 * `workspace-write` override. It owns and removes every probe path.
 */
declare function probeWorkspaceWriteSandbox(stack: LiveSandboxStack | undefined, session: Session, expectedCwd: string, signal?: AbortSignal): Promise<SandboxProbeResult>;
//#endregion
//#region src/managed-child.d.ts
interface ManagedChildRequest {
  parent: Agent;
  cwd: string;
  workOrder: CreatorWorkOrder;
  preflight?: CreatorFoundationPreflight;
  signal?: AbortSignal;
}
interface ManagedChildResult {
  sessionId: string;
  taskResult: string;
  sandbox: Awaited<ReturnType<typeof probeWorkspaceWriteSandbox>>;
  creator: CreatorFoundationReceipt;
}
interface ManagedChildHost {
  run(request: ManagedChildRequest): Promise<ManagedChildResult>;
}
//#endregion
//#region src/source-manager.d.ts
interface SourceReceipt {
  sourceId: string;
  repository: string | null;
  path: string;
  baseCommit: string;
  branch: string;
  headCommit: string;
  reviewId: string;
  artifactHash: string | null;
  activeWorkflowId: string | null;
  /** Hash of Host-controlled Git config and hooks metadata. */
  gitConfigHash: string;
}
interface FinalizedChildCommit extends SourceReceipt {
  changedFiles: string[];
  changedFilesTruncated: boolean;
}
declare class SourceManager {
  private readonly config;
  private readonly runner;
  constructor(config: RuntimeConfig, runner: CommandRunner);
  private get controlRoot();
  private get legacySourceRoot();
  private legacyReceiptPath;
  private legacyLockPath;
  /** Explicit `sourceDir` override, or `<workspace>/.autoevo/sources`; Host control remains under stateDir. */
  sourceRootFor(workspaceCwd?: string): string;
  /** @deprecated Use sourceRootFor(workspaceCwd). Kept for explicit sourceDir unit and integration tests. */
  get sourceRoot(): string;
  sourcePath(sourceId: string, workspaceCwd?: string): string;
  /** True when `candidate` is inside the managed sources root for this session. */
  pathUnderSourceRoot(candidate: string, workspaceCwd?: string): Promise<boolean>;
  /**
   * Resume/finalize follow a Host receipt. Materialize/initialize pass
   * `workspaceCwd` so a new or relocated tree lands in the session workspace.
   */
  private resolveWorkingPath;
  receiptPath(sourceId: string): string;
  lockPath(sourceId: string): string;
  private isManagedSourceDir;
  /** Containment of a realpath'd managed source against canonicalized base roots. */
  private isCanonicalManagedSourceDir;
  private ensureWorkspaceLayout;
  readReceipt(sourceId: string): Promise<SourceReceipt | undefined>;
  receiptForManagedPath(candidate: string): Promise<SourceReceipt | undefined>;
  /** Read-only proof that a historical local review still has an intact completed Host source. */
  validateCompletedSnapshot(input: {
    path: string;
    reviewId: string;
    repository: string;
    baseCommit: string;
    workspaceCwd?: string;
    signal?: AbortSignal;
  }): Promise<SourceReceipt | undefined>;
  writeReceipt(receipt: SourceReceipt): Promise<void>;
  private git;
  private gitConfigHash;
  private disabledHooksPath;
  acquireLock(sourceId: string, workflowId: string, signal?: AbortSignal, workspaceCwd?: string): Promise<void>;
  releaseLock(sourceId: string, workflowId: string): Promise<void>;
  completeWorkflow(sourceId: string, workflowId: string, signal?: AbortSignal): Promise<void>;
  assertCleanTree(sourceId: string, signal?: AbortSignal, workspaceCwd?: string): Promise<void>;
  assertPathContainment(sourceId: string, workspaceCwd?: string): Promise<string>;
  /** Trusted minimal DSH bundle scaffold written before any child edit session. */
  static trustedScaffoldFiles(packageName: string): Record<string, string>;
  /**
   * Initialize a managed create-new repository with a trusted scaffold commit
   * before any child session begins.
   */
  initializeCreateSource(input: {
    resolutionId: string;
    workflowId: string;
    packageName?: string;
    workspaceCwd?: string;
    signal?: AbortSignal;
  }): Promise<SourceReceipt>;
  /**
   * Materialize the exact reviewed remote commit into a managed git source and
   * create branch `autoevo/<workflow-id>`.
   */
  materializeReviewedGithub(input: {
    review: ReviewRecord;
    workflowId: string;
    workspaceCwd?: string;
    signal?: AbortSignal;
  }): Promise<SourceReceipt>;
  createHooklessCommit(input: {
    sourceId: string;
    message: string;
    workspaceCwd?: string;
    signal?: AbortSignal;
  }): Promise<string>;
  finalizeChildCommit(input: {
    sourceId: string;
    workflowId: string;
    reviewId: string;
    message: string;
    signal?: AbortSignal;
  }): Promise<FinalizedChildCommit>;
  recordReviewedArtifact(input: {
    sourceId: string;
    workflowId: string;
    reviewId: string;
    artifactHash: string;
  }): Promise<SourceReceipt>;
  inspectCompletedSource(sourceId: string, signal?: AbortSignal): Promise<SourceReceipt | undefined>;
  claimCompletedSourceForWorkflow(sourceId: string, workflowId: string, signal?: AbortSignal): Promise<SourceReceipt>;
  /** Re-enter an already-owned managed source without resetting its lineage. */
  resumeWorkflowSource(sourceId: string, workflowId: string, signal?: AbortSignal): Promise<SourceReceipt>;
  /** Preserve a failed child's bounded edits as a local WIP commit for retry. */
  preserveInterruptedChild(input: {
    sourceId: string;
    workflowId: string;
    reviewId: string;
    signal?: AbortSignal;
  }): Promise<SourceReceipt>;
}
//#endregion
//#region src/semantic-reviewer.d.ts
declare const REVIEWER_SUBMIT_TOOL = "autoevo_submit_review";
declare const REVIEWER_VERSION = "1";
interface BoundedReviewFile {
  path: string;
  sha256: string;
  bytes: number;
  text: string;
}
/** Internal Host input. Never accepted on ResumeInput. */
interface ReviewerRunInput {
  parent: Agent;
  workflowId: string;
  review: ReviewRecord;
  candidateDigest: string;
  snapshotDigest: string;
  files: readonly BoundedReviewFile[];
  signal?: AbortSignal;
  timeoutMs: number;
}
interface SemanticReviewerResult {
  request: ReviewerRequest;
  verdict: ReviewerVerdict;
}
interface SemanticReviewerHost {
  run(input: ReviewerRunInput): Promise<SemanticReviewerResult>;
}
declare function mintReviewerRequest(input: {
  workflowId: string;
  review: ReviewRecord;
  snapshotDigest: string;
  candidateDigest: string;
  createdAt?: string;
}): ReviewerRequest;
/** Real Host-owned DSH semantic reviewer lifecycle. */
declare class DshSemanticReviewerHost implements SemanticReviewerHost {
  private readonly ctx;
  constructor(ctx: Context);
  run(input: ReviewerRunInput): Promise<SemanticReviewerResult>;
}
//#endregion
//#region src/service.d.ts
declare class CapabilityEvolutionService implements WorkflowHost {
  private readonly ctx;
  private readonly config;
  private readonly runner;
  private readonly store;
  private readonly creationGuard;
  readonly installer: PluginInstaller;
  readonly remover: PluginRemover;
  readonly sources: SourceManager;
  private readonly launcher;
  private readonly engine;
  private readonly creatorFoundation;
  constructor(ctx: Context, config: RuntimeConfig, runner: CommandRunner, store: StateStore, creationGuard: CreationGuard, _managedChild?: ManagedChildHost, _semanticReviewer?: SemanticReviewerHost, _semanticVerifier?: SemanticVerifierHost, creatorFoundation?: CreatorFoundation);
  private managedWorkDeps;
  private withWorkspace;
  start(requirement: string, exec: ToolRunContext, intent?: RequestIntent): Promise<WorkflowView>;
  resume(input: ResumeInput, exec: ToolRunContext): Promise<WorkflowView>;
  refine(input: DiscoveryRefineInput, exec: ToolRunContext): Promise<WorkflowView>;
  present(input: DiscoveryPresentInput, exec: ToolRunContext): Promise<WorkflowView>;
  diagnose(input: WorkflowDiagnoseInput, exec: ToolRunContext): Promise<WorkflowView>;
  recover(input: WorkflowRecoveryInput, exec: ToolRunContext): Promise<WorkflowView>;
  remove(input: RemoveInput, exec: ToolRunContext): Promise<RemovalResult>;
  cleanupInstallation(installationId: string, exec: WorkflowExec): Promise<RemovalResult>;
  bootstrapResolution(requirementInput: string, exec: WorkflowExec, intent?: RequestIntent): Promise<ResolutionRecord>;
  discoverRemote(resolution: ResolutionRecord, exec: WorkflowExec): Promise<ResolutionRecord>;
  refineRemote(resolution: ResolutionRecord, input: {
    queries: string[];
    repositories: string[];
  }, exec: WorkflowExec): Promise<ResolutionRecord>;
  ensureMarket(resolution: ResolutionRecord, exec: WorkflowExec): Promise<{
    resolution: ResolutionRecord;
    market: MarketplaceStepResult;
  }>;
  reviewGithub(resolution: ResolutionRecord, repository: string, ref: string | undefined, exec: WorkflowExec, workflow?: WorkflowRecord): Promise<{
    resolution: ResolutionRecord;
    review: ReviewRecord;
  }>;
  reviewExisting(resolution: ResolutionRecord, target: EvolutionTarget, exec: WorkflowExec, workflow?: WorkflowRecord): Promise<{
    resolution: ResolutionRecord;
    review: ReviewRecord;
  }>;
  reviewGithubBatch(resolution: ResolutionRecord, repositories: string[], mode: ReviewMode, exec: WorkflowExec, workflow?: WorkflowRecord): Promise<{
    resolution: ResolutionRecord;
    reviews: ReviewRecord[];
    failures: Array<{
      repository: string;
      code: string;
      message: string;
    }>;
  }>;
  reviewLocal(resolution: ResolutionRecord, path: string, baseReviewId: string, exec: WorkflowExec, workflow?: WorkflowRecord): Promise<{
    resolution: ResolutionRecord;
    review: ReviewRecord;
  }>;
  installReviewed(review: ReviewRecord, input: WorkflowPendingInstall, exec: WorkflowExec, workflow?: WorkflowRecord): Promise<InstallationRecord>;
  private revalidate;
  prepareModify(resolution: ResolutionRecord, review: ReviewRecord, exec: WorkflowExec, workflow: WorkflowRecord): Promise<{
    resolution: ResolutionRecord;
    path?: string;
    review?: ReviewRecord;
  }>;
  prepareCreate(resolution: ResolutionRecord, exec: WorkflowExec, workflow: WorkflowRecord): Promise<{
    resolution: ResolutionRecord;
    path?: string;
    review?: ReviewRecord;
  }>;
  finishManagedWork(resolution: ResolutionRecord, exec: WorkflowExec, workflow: WorkflowRecord): Promise<{
    resolution: ResolutionRecord;
    path?: string;
    review?: ReviewRecord;
    continueConstruction?: boolean;
  }>;
  applyDecision(resolution: ResolutionRecord, resume: ValidatedResume, review?: ReviewRecord, workflow?: WorkflowRecord): Promise<ResolutionRecord>;
  applyNavigation(resolution: ResolutionRecord, navigation: NavigationInput, repositories: string[]): Promise<ResolutionRecord>;
  latestReview(resolutionId: string, reviewId?: string): Promise<ReviewRecord | undefined>;
  getResolution(id: string): Promise<ResolutionRecord>;
  getReview(id: string): Promise<ReviewRecord>;
  getInstallation(id: string): Promise<InstallationRecord>;
  listInstallProfiles(): Promise<string[]>;
  private currentProfileOwner;
  private persistReviewed;
  releaseManagedSource(workflow: WorkflowRecord, _exec: WorkflowExec): Promise<void>;
}
//#endregion
//#region src/index.d.ts
declare const name = "autoevo";
declare const inject: readonly ["tools", "skills", "subprocess", "systemPrompt"];
type Config = Config$1;
declare const Config: import("@deepseek-ai/schemastery").default<Config$1>;
declare function createIsEvolutionMode(ctx: Context): (agent: Agent) => boolean;
declare function installCordisInspectCompatibilityWhenAvailable(ctx: Context): void;
declare const _testing: {
  createIsEvolutionMode: typeof createIsEvolutionMode;
  installCordisInspectCompatibilityWhenAvailable: typeof installCordisInspectCompatibilityWhenAvailable;
};
declare function apply(ctx: Context, input: Config): void;
//#endregion
export { type ActionCommitment, BRIDGE_EXECUTION_TOOLS, type BoundedReviewFile, CapabilityEvolutionService, Config, CreationGuard, DshSemanticReviewerHost, DshSemanticVerifierHost, type ExecutionEndpoint, ExecutionGuard, type ExecutionLease, FORGED_RESUME_HOST_KEYS, type FrozenCandidateIdentity, type MechanicalFacts, POLICY_VERSION, REVIEWER_SUBMIT_TOOL, REVIEWER_VERSION, type RedactedVerificationReceipt, type ReviewerRequest, type ReviewerRequestStatus, type ReviewerRunInput, type ReviewerVerdict, type ReviewerVerdictDecision, type SelectionReceipt, type SemanticReviewerHost, type SemanticReviewerResult, type SemanticVerifierHost, type SemanticVerifierResult, StateStore, TOOL_NAMES, VERIFICATION_LAYER_KINDS, VERIFICATION_STATUSES, VERIFIER_SUBMIT_TOOL, VERIFIER_VERSION, type VerificationEvidence, type VerificationLayerKind, type VerificationStatus, type VerificationVerdict, type VerificationVerdictDecision, type VerifierRequest, type VerifierRequestStatus, type VerifierRunInput, type WorkflowLifecycleState, type WorkflowRecord, type WorkflowView, _testing, apply, classifyRuntimeSurface, hostLayerSuccess, inject, inspectLoadedToolSafety, lifecycleStateFor, mintReviewerRequest, mintVerifierRequest, name, probeWorkspaceWriteSandbox, requirementHashFor, reviewIdentity, sanitizeHostVerificationEvidence, selectInstallVerificationLayer, verificationChildEnv, verificationEvidenceDigest, verificationVerdictAllowsCompletion };
//# sourceMappingURL=index.d.ts.map