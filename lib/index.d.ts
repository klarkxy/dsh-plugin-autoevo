import Schema from "@deepseek-ai/schemastery";
import { PreToolDecision, ToolExecution, ToolExecutionResult, ToolRunContext } from "@deepseek-ai/dsh-tools";
import { Context } from "@deepseek-ai/cordis";
import { Agent } from "@deepseek-ai/dsh-agent";
import "@deepseek-ai/dsh-subprocess";
//#region src/config.d.ts
interface Config$1 {
  dshHome?: string;
  stateDir?: string;
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
  /** Archived. No public quality service is offered; leave unset. */
  communityQualityFilter?: boolean;
  /** Archived. No public quality service is offered; leave unset. */
  communityReports?: boolean;
  /** Archived. Empty disables network access. */
  communityQualityEndpoint?: string;
  communityQualityTimeoutMs?: number;
}
interface RuntimeConfig {
  dshHome: string;
  stateDir: string;
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
  communityQualityFilter: boolean;
  communityReports: boolean;
  communityQualityEndpoint: string;
  communityQualityTimeoutMs: number;
}
declare const Config$1: Schema<Config$1>;
//#endregion
//#region src/contracts.d.ts
type ResolutionDecision = 'use_local' | 'inspect_remote' | 'none';
/** Evidence states wait; action states are minted only after a recorded human answer. */
type AuthorizationState = 'selection_required' | 'confirmation_required' | 'market_required' | 'stopped' | 'reuse_local' | 'use_review' | 'modify_review' | 'scratch_ready';
type CandidateAvailability = 'available' | 'available_via_tool_search';
type RemoteCandidateSource = 'dsh-find-plugin' | 'marketplace-setup';
type CommunityQualityClass = 'good' | 'repairable' | 'broken' | 'junk' | 'unknown';
type DecisionPhase = 'gate1' | 'gate2';
type DecisionAction = 'inspect' | 'create_new' | 'stop' | 'use_this' | 'modify_this' | 'use_local' | 'search_more' | 'resume_modify';
type WorkflowOptionId = DecisionAction;
interface DecisionReceipt {
  id: string;
  phase: DecisionPhase;
  action: DecisionAction;
  selectedRepositories: string[];
  reviewId?: string;
  reviewIdentity?: string;
  userMessage?: string;
  optionId?: WorkflowOptionId;
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
  kind: 'tool' | 'skill';
  name: string;
  description: string;
  availability: CandidateAvailability;
  confidence: number;
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
  communityQuality?: CommunityQualityAssessment;
}
interface CommunityQualityAssessment {
  classification: CommunityQualityClass;
  repairability: number | null;
  evolutionValue: number | null;
  confidence: number | null;
  observationCount: number;
  reasonCodes: string[];
  updatedAt: string | null;
}
interface CommunityQualityScreening {
  enabled: true;
  complete: boolean;
  assessedCandidates: number;
  filtered: Array<{
    repository: string;
    classification: 'broken' | 'junk';
    reasonCodes: string[];
  }>;
  reason: string;
}
interface ResolutionRecord {
  /** V1 records remain readable but never restore a scratch-build grant. */
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
  /** Opt-in community quality result. Filtered repositories are retained here for audit, not selection. */
  communityQualityScreening?: CommunityQualityScreening;
  /** Present on V2 records created by the current policy. */
  authorization?: ResolutionAuthorization;
  selectedRepositories?: string[];
  decisions?: DecisionReceipt[];
  queries: string[];
  reasons: string[];
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
interface ManifestFacts {
  kind: 'bundle' | 'skill' | 'legacy' | 'unknown';
  packageName?: string;
  packageVersion?: string;
  bundlePatch?: string;
  license?: string;
  scripts: string[];
  dependencies: string[];
  peerDependencies: Record<string, string>;
  expectedTools: string[];
}
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
}
type InstallationRetention = 'temporary' | 'persistent';
type InstallationState = 'installed' | 'not_installed' | 'unknown';
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
  taskResultObserved: boolean;
  taskResultSha256?: string;
  taskResultMatchedExpectation?: boolean;
  reason: string;
}
interface InstallationRecord {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  reviewId: string;
  targetProfile: string;
  retention: InstallationRetention;
  dshHome: string;
  packageName: string | null;
  installSpec: string;
  ownedArtifactRoot?: string;
  artifactSha256?: string;
  /** Present on v0.1.1+ receipts. Older v0.1.0 receipts are inferred from `installed`. */
  installState?: InstallationState;
  installed: boolean;
  loaded: boolean;
  verified: boolean;
  restartRequired: boolean;
  removed: boolean;
  verification: VerificationEvidence;
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
}
interface InstallInput {
  reviewId: string;
  targetProfile: string;
  retention: InstallationRetention;
  verificationTask?: string;
  verificationExpectedText?: string;
}
interface RemoveInput {
  installationId: string;
}
interface ResumeInput {
  workflowId: string;
  userMessage: string;
  optionId: WorkflowOptionId;
  repositories?: string[];
  path?: string;
  ref?: string;
  reviewId?: string;
  targetProfile?: string;
  retention?: InstallationRetention;
  verificationTask?: string;
  verificationExpectedText?: string;
}
//#endregion
//#region src/creation-guard.d.ts
type Grant = {
  state: 'available';
  resolutionId: string;
} | {
  state: 'reserved';
  resolutionId: string;
  callId: string;
};
interface AgentGateState {
  generation: number;
  activeResolutionId?: string;
  authorization?: ResolutionAuthorization;
  grant?: Grant;
  lastUserMessage?: string;
  waitingKind?: 'await_selection' | 'await_confirmation' | 'await_modify_work';
}
interface UserFacingMessage {
  content?: readonly unknown[];
}
interface CreationGuardOptions {
  /** True only when agentPresets.serviceFor(agent, 'autoevoEvolutionMode') yields exact marker. */
  isEvolutionMode?: (agent: Agent) => boolean;
}
/** Runtime-only, fail-closed authorization for one new dynamic Cordis Plugin. */
declare class CreationGuard {
  private readonly options;
  private readonly states;
  private nextGeneration;
  constructor(options?: CreationGuardOptions);
  beginResolution(agent?: Agent): number | undefined;
  rememberUserMessage(agent: Agent | undefined, message: UserFacingMessage): void;
  lastUserMessage(agent: Agent | undefined): string | undefined;
  setWaiting(agent: Agent | undefined, kind?: AgentGateState['waitingKind']): void;
  applyResolutionAuthorization(agent: Agent | undefined, authorization: ResolutionAuthorization, generation: number | undefined): boolean;
  applyReviewAuthorization(agent: Agent | undefined, authorization: ResolutionAuthorization): boolean;
  private setAuthorization;
  assertInstallAuthorized(agent: Agent | undefined, review: ReviewRecord, resolution: Pick<ResolutionRecord, 'id' | 'decisions'>): void;
  private inEvolutionMode;
  protocolDenial(exec: Readonly<ToolExecution>): string | undefined;
  preExecute(exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>;
  /** Final monotonic check: no earlier waterfall listener can override this denial. */
  guard(exec: Readonly<ToolExecution>): string | undefined;
  result(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): void;
  authorization(agent: Agent): ResolutionAuthorization | undefined;
}
//#endregion
//#region src/community-quality.d.ts
interface CommunityQualitySource {
  repository: string;
  commit: string;
  localModification: boolean;
}
interface CommunityQualityResult {
  candidates: RemotePluginCandidate[];
  screening?: CommunityQualityScreening;
}
type FetchLike = typeof globalThis.fetch;
declare class CommunityQualityService {
  private readonly config;
  private readonly fetcher;
  private readonly qualityRoot;
  private readonly observationsRoot;
  private readonly snapshotFile;
  private snapshot;
  constructor(config: RuntimeConfig, fetcher?: FetchLike);
  screen(candidates: readonly RemotePluginCandidate[], signal?: AbortSignal): Promise<CommunityQualityResult>;
  recordReview(source: CommunityQualitySource, review: ReviewRecord): Promise<void>;
  recordInstallation(source: CommunityQualitySource, review: ReviewRecord, record: InstallationRecord): Promise<void>;
  flushPending(limit?: number): Promise<void>;
  private observationBase;
  private parseAssessments;
  private readStoredSnapshot;
  private loadSnapshot;
  private persistAndSend;
  private requestJson;
  private atomicWrite;
}
//#endregion
//#region src/workflow/contracts.d.ts
type WorkflowStatus = 'running' | 'interrupted' | 'completed' | 'failed';
type WorkflowNodeId = 'resolve_local' | 'discover_remote' | 'ensure_market' | 'await_selection' | 'review_github' | 'await_confirmation' | 'await_modify_work' | 'review_local' | 'install_verify' | 'grant_scratch' | 'reuse_local' | 'stopped' | 'market_restart_required' | 'installed' | 'scratch_ready';
type InterruptKind = 'await_selection' | 'await_confirmation' | 'await_modify_work';
interface WorkflowOption {
  id: WorkflowOptionId;
  labelEn: string;
  labelZh: string;
}
interface InterruptPayload {
  kind: InterruptKind;
  options: WorkflowOption[];
  facts: Record<string, unknown>;
}
interface WorkflowPendingInstall {
  targetProfile: string;
  retention: InstallationRetention;
  verificationTask?: string;
  verificationExpectedText?: string;
}
interface WorkflowRecord {
  schemaVersion: 1;
  id: string;
  policyVersion: string;
  createdAt: string;
  updatedAt: string;
  requirement: string;
  cwd?: string;
  resolutionId?: string;
  status: WorkflowStatus;
  cursor: WorkflowNodeId;
  generation: number;
  interrupt?: InterruptPayload;
  lineageTipReviewId?: string;
  lastReviewId?: string;
  lastInstallationId?: string;
  forceRemoteDiscovery?: boolean;
  pendingRepositories?: string[];
  pendingRef?: string;
  pendingPath?: string;
  pendingInstall?: WorkflowPendingInstall;
  lastFailure?: {
    code: string;
    message: string;
  };
  error?: {
    code: string;
    message: string;
  };
}
interface WorkflowView {
  workflow: WorkflowRecord;
  resolution?: ResolutionRecord;
  review?: ReviewRecord;
  installation?: InstallationRecord;
  nextStep?: string;
}
interface ValidatedResume {
  optionId: WorkflowOptionId;
  userMessage: string;
  repositories: string[];
  path?: string;
  ref?: string;
  reviewId?: string;
  install?: WorkflowPendingInstall;
}
interface MarketplaceStepResult {
  status: 'loaded' | 'restart' | 'empty';
  reason: string;
}
interface WorkflowHost {
  bootstrapResolution(requirement: string, exec: WorkflowExec): Promise<ResolutionRecord>;
  discoverRemote(resolution: ResolutionRecord, exec: WorkflowExec): Promise<ResolutionRecord>;
  ensureMarket(resolution: ResolutionRecord, exec: WorkflowExec): Promise<{
    resolution: ResolutionRecord;
    market: MarketplaceStepResult;
  }>;
  reviewGithub(resolution: ResolutionRecord, repository: string, ref: string | undefined, exec: WorkflowExec): Promise<{
    resolution: ResolutionRecord;
    review: ReviewRecord;
  }>;
  reviewLocal(resolution: ResolutionRecord, path: string, baseReviewId: string, exec: WorkflowExec): Promise<{
    resolution: ResolutionRecord;
    review: ReviewRecord;
  }>;
  installReviewed(review: ReviewRecord, input: WorkflowPendingInstall, exec: WorkflowExec): Promise<InstallationRecord>;
  applyDecision(resolution: ResolutionRecord, resume: ValidatedResume, review?: ReviewRecord): Promise<ResolutionRecord>;
  latestReview(resolutionId: string, reviewId?: string): Promise<ReviewRecord | undefined>;
  getResolution(id: string): Promise<ResolutionRecord>;
  getReview(id: string): Promise<ReviewRecord>;
  getInstallation(id: string): Promise<InstallationRecord>;
  listInstallProfiles?(): Promise<string[]>;
}
interface WorkflowExec {
  agent?: import('@deepseek-ai/dsh-agent').Agent;
  signal?: AbortSignal;
  callId?: string;
}
//#endregion
//#region src/lifecycle/decide.d.ts
declare function reviewIdentity(review: ReviewRecord): string;
//#endregion
//#region src/state/store.d.ts
type RecordKind = 'resolutions' | 'reviews' | 'installations' | 'workflows';
type StoredRecord = ResolutionRecord | ReviewRecord | InstallationRecord | WorkflowRecord;
declare class StateStore {
  readonly root: string;
  constructor(root: string);
  trialRoot(installationId: string): string;
  put(kind: RecordKind, record: StoredRecord): Promise<void>;
  getResolution(id: string): Promise<ResolutionRecord>;
  getReview(id: string): Promise<ReviewRecord>;
  getInstallation(id: string): Promise<InstallationRecord>;
  getWorkflow(id: string): Promise<WorkflowRecord>;
  listReviews(resolutionId: string): Promise<ReviewRecord[]>;
  private get;
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
  install(dshHome: string, profile: string, spec: string, cwd: string, signal?: AbortSignal): Promise<CommandResult>;
  remove(dshHome: string, profile: string, packageName: string, cwd: string, signal?: AbortSignal): Promise<CommandResult>;
  hasProfileDependency(dshHome: string, profile: string, packageName: string): Promise<boolean>;
  verify(dshHome: string, profile: string, cwd: string, task: string, expectedTools: readonly string[], expectedText?: string, signal?: AbortSignal): Promise<VerificationEvidence>;
}
//#endregion
//#region src/lifecycle/install.d.ts
type ReviewRevalidator = (review: ReviewRecord, signal?: AbortSignal) => Promise<boolean>;
type InstallAuthorizer = (review: ReviewRecord, exec: ToolRunContext) => void | Promise<void>;
declare class PluginInstaller {
  private readonly ctx;
  private readonly config;
  private readonly store;
  private readonly launcher;
  private readonly revalidate;
  private readonly authorizeInstall?;
  constructor(ctx: Context, config: RuntimeConfig, store: StateStore, launcher: DshLauncher, revalidate: ReviewRevalidator, authorizeInstall?: InstallAuthorizer | undefined);
  private removeOwnedDirectory;
  install(input: InstallInput, exec: ToolRunContext): Promise<InstallationRecord>;
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
  remove(input: RemoveInput, exec: ToolRunContext): Promise<RemovalResult>;
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
  private readonly launcher;
  private readonly quality;
  private readonly engine;
  constructor(ctx: Context, config: RuntimeConfig, runner: CommandRunner, store: StateStore, creationGuard: CreationGuard, quality?: CommunityQualityService);
  start(requirement: string, exec: ToolRunContext): Promise<WorkflowView>;
  resume(input: ResumeInput, exec: ToolRunContext): Promise<WorkflowView>;
  remove(input: RemoveInput, exec: ToolRunContext): Promise<RemovalResult>;
  bootstrapResolution(requirementInput: string, exec: WorkflowExec): Promise<ResolutionRecord>;
  discoverRemote(resolution: ResolutionRecord, exec: WorkflowExec): Promise<ResolutionRecord>;
  ensureMarket(resolution: ResolutionRecord, exec: WorkflowExec): Promise<{
    resolution: ResolutionRecord;
    market: MarketplaceStepResult;
  }>;
  reviewGithub(resolution: ResolutionRecord, repository: string, ref: string | undefined, exec: WorkflowExec): Promise<{
    resolution: ResolutionRecord;
    review: ReviewRecord;
  }>;
  reviewLocal(resolution: ResolutionRecord, path: string, baseReviewId: string, exec: WorkflowExec): Promise<{
    resolution: ResolutionRecord;
    review: ReviewRecord;
  }>;
  installReviewed(review: ReviewRecord, input: WorkflowPendingInstall, exec: WorkflowExec): Promise<InstallationRecord>;
  applyDecision(resolution: ResolutionRecord, resume: ValidatedResume, review?: ReviewRecord): Promise<ResolutionRecord>;
  latestReview(resolutionId: string, reviewId?: string): Promise<ReviewRecord | undefined>;
  getResolution(id: string): Promise<ResolutionRecord>;
  getReview(id: string): Promise<ReviewRecord>;
  getInstallation(id: string): Promise<InstallationRecord>;
  listInstallProfiles(): Promise<string[]>;
  private waitingConfirmation;
  private revalidate;
  private qualitySourceForReview;
  private dshRuntimeVersion;
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
export { CapabilityEvolutionService, Config, CreationGuard, StateStore, _testing, apply, inject, name, reviewIdentity };
//# sourceMappingURL=index.d.ts.map