import Schema from "@deepseek-ai/schemastery";
import { SandboxPolicyService } from "@deepseek-ai/dsh-sandbox-policy";
import { Session } from "@deepseek-ai/dsh-session";
import { PreToolDecision, ToolExecution, ToolExecutionResult, ToolRunContext } from "@deepseek-ai/dsh-tools";
import { Context } from "@deepseek-ai/cordis";
import { Agent } from "@deepseek-ai/dsh-agent";
import "@deepseek-ai/dsh-subprocess";
import { FileSystem } from "@deepseek-ai/dsh-fs";
import { SandboxProvider } from "@deepseek-ai/dsh-sandbox";
//#region src/config.d.ts
interface Config$1 {
  dshHome?: string;
  stateDir?: string;
  /** Managed plugin source repositories. Defaults to `<stateDir>/sources`. */
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
  stateDir: string;
  /** Optional; omitted callers resolve to `<stateDir>/sources` at the SourceManager boundary. */
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
type ResolutionDecision = 'use_local' | 'inspect_remote' | 'none';
/** Evidence states wait; action states are minted only after a recorded human answer. */
type AuthorizationState = 'selection_required' | 'confirmation_required' | 'market_required' | 'stopped' | 'reuse_local' | 'use_review' | 'modify_review' | 'create_authorized';
type CandidateAvailability = 'available' | 'available_via_tool_search';
type RemoteCandidateSource = 'dsh-find-plugin' | 'marketplace-setup';
type DecisionPhase = 'gate1' | 'gate2';
type DecisionAction = 'inspect' | 'create_new' | 'stop' | 'use_this' | 'modify_this' | 'use_local' | 'search_more';
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
  interruptId?: string;
  hostTurnId?: string;
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
/** Public install outcome: success only after Loader/runtime verification. */
type InstallOutcome = 'pending' | 'verified' | 'failed_absent' | 'recovery_required';
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
  /** Fail-closed public outcome. Success is only `verified`. */
  installOutcome?: InstallOutcome;
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
  /** Host-derived managed-source artifact hash; never accepted from model tool arguments. */
  expectedArtifactSha256?: string;
}
interface RemoveInput {
  installationId: string;
}
/** Public resume input is intentionally narrow: Host owns the decision facts. */
interface ResumeInput {
  workflowId: string;
  interruptId: string;
}
//#endregion
//#region src/workflow/contracts.d.ts
type WorkflowStatus = 'running' | 'interrupted' | 'completed' | 'failed';
type WorkflowNodeId = 'resolve_local' | 'discover_remote' | 'ensure_market' | 'await_selection' | 'review_github' | 'await_confirmation' | 'prepare_modify' | 'await_modify_work' | 'review_local' | 'install_verify' | 'prepare_create' | 'reuse_local' | 'stopped' | 'market_restart_required' | 'installed' | 'recovery_required' | 'create_authorized' | 'modify_authorized';
type InterruptKind = 'await_selection' | 'await_confirmation' | 'await_modify_work';
interface WorkflowOption {
  id: WorkflowOptionId;
  labelEn: string;
  labelZh: string;
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
}
interface WorkflowRecord {
  schemaVersion: 1;
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
  pendingRepositories?: string[];
  pendingRef?: string;
  pendingPath?: string;
  pendingInstall?: WorkflowPendingInstall;
  managedSourceId?: string;
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
  hostTurnId: string;
  interruptId: string;
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
  applyDecision(resolution: ResolutionRecord, resume: ValidatedResume, review?: ReviewRecord): Promise<ResolutionRecord>;
  latestReview(resolutionId: string, reviewId?: string): Promise<ReviewRecord | undefined>;
  getResolution(id: string): Promise<ResolutionRecord>;
  getReview(id: string): Promise<ReviewRecord>;
  getInstallation(id: string): Promise<InstallationRecord>;
  listInstallProfiles?(): Promise<string[]>;
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
  waitingKind?: 'await_selection' | 'await_confirmation' | 'await_modify_work';
  sessionId?: string;
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
  /**
   * Consume the latest host-owned user turn for an interrupt.
   * Rejects missing turns, already-consumed (replay) turns, and turns at/before the interrupt watermark.
   */
  consumeDecisionTurn(agent: Agent | undefined, interrupt: InterruptPayload): ClaimedHostTurn;
  setWaiting(agent: Agent | undefined, kind?: AgentGateState['waitingKind']): void;
  applyResolutionAuthorization(agent: Agent | undefined, authorization: ResolutionAuthorization, generation: number | undefined): boolean;
  applyReviewAuthorization(agent: Agent | undefined, authorization: ResolutionAuthorization): boolean;
  assertInstallAuthorized(agent: Agent | undefined, review: ReviewRecord, resolution: Pick<ResolutionRecord, 'id' | 'decisions'>): void;
  private inEvolutionMode;
  protocolDenial(exec: Readonly<ToolExecution>): string | undefined;
  preExecute(exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>;
  /** Final monotonic check: no earlier waterfall listener can override this denial. */
  guard(exec: Readonly<ToolExecution>): string | undefined;
  result(_exec: Readonly<ToolExecution>, _result: Readonly<ToolExecutionResult>): void;
  authorization(agent: Agent): ResolutionAuthorization | undefined;
}
//#endregion
//#region src/execution-guard.d.ts
type ExecutionRole = 'parent' | 'child';
interface ExecutionGuardOptions {
  role: ExecutionRole;
}
/**
 * Final execution-layer guard for AutoEvo parent and managed-source child sessions.
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
  private childDenial;
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
  listWorkflows(): Promise<WorkflowRecord[]>;
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
  /** Verify that the target profile records the exact reviewed source and loads that bundle. */
  profileSourceMatches(dshHome: string, profile: string, packageName: string, expectedSpec: string): Promise<boolean>;
  /** Confirm absence in both the profile manifest and its visible node_modules target. */
  profileTargetAbsent(dshHome: string, profile: string, packageName: string): Promise<boolean>;
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
  /**
   * Uninstalls exactly one installation receipt.
   * Never deletes a managed source repository under stateDir/sources.
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
  task: string;
  signal?: AbortSignal;
}
interface ManagedChildResult {
  sessionId: string;
  taskResult: string;
  sandbox: Awaited<ReturnType<typeof probeWorkspaceWriteSandbox>>;
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
declare class SourceManager {
  private readonly config;
  private readonly runner;
  constructor(config: RuntimeConfig, runner: CommandRunner);
  /** Resolve managed sources root; omitted config.sourceDir defaults to `<stateDir>/sources`. */
  get sourceRoot(): string;
  sourcePath(sourceId: string): string;
  receiptPath(sourceId: string): string;
  lockPath(sourceId: string): string;
  readReceipt(sourceId: string): Promise<SourceReceipt | undefined>;
  receiptForManagedPath(candidate: string): Promise<SourceReceipt | undefined>;
  writeReceipt(receipt: SourceReceipt): Promise<void>;
  private git;
  private gitConfigHash;
  private disabledHooksPath;
  acquireLock(sourceId: string, workflowId: string, signal?: AbortSignal): Promise<void>;
  releaseLock(sourceId: string, workflowId: string): Promise<void>;
  completeWorkflow(sourceId: string, workflowId: string, signal?: AbortSignal): Promise<void>;
  assertCleanTree(sourceId: string, signal?: AbortSignal): Promise<void>;
  assertPathContainment(sourceId: string): Promise<string>;
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
    signal?: AbortSignal;
  }): Promise<SourceReceipt>;
  /**
   * Materialize the exact reviewed remote commit into a managed git source and
   * create branch `autoevo/<workflow-id>`.
   */
  materializeReviewedGithub(input: {
    review: ReviewRecord;
    workflowId: string;
    signal?: AbortSignal;
  }): Promise<SourceReceipt>;
  createHooklessCommit(input: {
    sourceId: string;
    message: string;
    signal?: AbortSignal;
  }): Promise<string>;
  finalizeChildCommit(input: {
    sourceId: string;
    workflowId: string;
    reviewId: string;
    message: string;
    signal?: AbortSignal;
  }): Promise<SourceReceipt>;
  recordReviewedArtifact(input: {
    sourceId: string;
    workflowId: string;
    reviewId: string;
    artifactHash: string;
  }): Promise<SourceReceipt>;
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
  private readonly managedChild;
  constructor(ctx: Context, config: RuntimeConfig, runner: CommandRunner, store: StateStore, creationGuard: CreationGuard, managedChild?: ManagedChildHost);
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
  private requireParentAgent;
  private reviewAndFreezeManagedSource;
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
  applyDecision(resolution: ResolutionRecord, resume: ValidatedResume, review?: ReviewRecord): Promise<ResolutionRecord>;
  latestReview(resolutionId: string, reviewId?: string): Promise<ReviewRecord | undefined>;
  getResolution(id: string): Promise<ResolutionRecord>;
  getReview(id: string): Promise<ReviewRecord>;
  getInstallation(id: string): Promise<InstallationRecord>;
  listInstallProfiles(): Promise<string[]>;
  releaseManagedSource(workflow: WorkflowRecord, exec: WorkflowExec): Promise<void>;
  private waitingConfirmation;
  private revalidate;
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
export { CapabilityEvolutionService, Config, CreationGuard, ExecutionGuard, StateStore, _testing, apply, inject, name, probeWorkspaceWriteSandbox, reviewIdentity };
//# sourceMappingURL=index.d.ts.map