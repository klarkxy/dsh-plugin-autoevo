import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { satisfies, valid, validRange } from 'semver'
import type { RuntimeConfig } from './config.js'
import {
  POLICY_VERSION,
  type DecisionReceipt,
  type InstallationRecord,
  type NavigationInput,
  type RemotePluginCandidate,
  type RemoveInput,
  type ResolutionAuthorization,
  type ResolutionRecord,
  type ResumeInput,
  type ReviewerRequest,
  type ReviewerVerdict,
  type ReviewMode,
  type ReviewRecord,
} from './contracts.js'
import type { CreationGuard } from './creation-guard.js'
import { discoverRemoteCandidates, FIND_PLUGIN_REPOSITORY } from './discovery/remote.js'
import { EvolutionError } from './errors.js'
import { validateGithubRepository } from './github/index.js'
import {
  authorizationFromDecision,
  newDecisionReceipt,
  nextStepForAuthorization,
  prefersChinese,
  reviewIdentity,
} from './lifecycle/decide.js'
import { PluginInstaller } from './lifecycle/install.js'
import { DshLauncher } from './lifecycle/launcher.js'
import { installMarketplace, profilesWithAutoEvo } from './lifecycle/marketplace.js'
import { PluginRemover, type RemovalResult } from './lifecycle/remove.js'
import { DshManagedChildHost, type ManagedChildHost, type ManagedChildResult } from './managed-child.js'
import type { CommandRunner } from './process/runner.js'
import { resolveLocalCapabilities } from './resolver/local.js'
import { activeProfileFromArgv } from './resolver/profile.js'
import {
  assertDirectUseAllowed,
  hostDirectUseBoundary,
  isDirectlyUsableReview,
  needsSemanticReviewer,
  reviewCandidateDigest,
  reviewGithubPlugin,
  reviewGithubPluginWithFiles,
  reviewLocalPlugin,
  reviewSnapshotDigest,
} from './review/index.js'
import type { ContentFile } from './review/review.js'
import {
  DshSemanticReviewerHost,
  mintReviewerRequest,
  requirementHashFor,
  REVIEWER_VERSION,
  type BoundedReviewFile,
  type SemanticReviewerHost,
} from './semantic-reviewer.js'
import { DshSemanticVerifierHost, type SemanticVerifierHost } from './semantic-verifier.js'
import { SourceManager, sourceIdForCreate, sourceIdForRepository, type SourceReceipt } from './source-manager.js'
import { hashObject } from './state/hashes.js'
import type { StateStore } from './state/store.js'
import { WorkflowEngine } from './workflow/engine.js'
import type {
  MarketplaceStepResult,
  DiscoveryPresentInput,
  DiscoveryRefineInput,
  ModificationAttemptEvidence,
  ModificationBlocker,
  ModificationOutcome,
  ValidatedResume,
  WorkflowDiagnoseInput,
  WorkflowExec,
  WorkflowHost,
  WorkflowPendingInstall,
  WorkflowRecord,
  WorkflowRecoveryInput,
  WorkflowView,
} from './workflow/contracts.js'

export function addExplicitCandidate(
  resolution: ResolutionRecord,
  repositoryInput: string,
): { resolution: ResolutionRecord, candidate: RemotePluginCandidate } {
  const repository = validateGithubRepository(repositoryInput)
  if (repository.toLowerCase() === FIND_PLUGIN_REPOSITORY.toLowerCase()) {
    throw new EvolutionError(
      'invalid_input',
      'dsh-find-plugin is marketplace infrastructure, not a capability candidate',
      { repository },
    )
  }
  const existing = resolution.remoteCandidates.find((item) => item.repository.toLowerCase() === repository.toLowerCase())
  if (existing) return { resolution, candidate: existing }

  const candidate: RemotePluginCandidate = {
    repository,
    name: repository.split('/')[1]!,
    description: '',
    stars: 0,
    updatedAt: null,
    topics: ['dsh-plugin'],
  }
  return {
    candidate,
    resolution: {
      ...resolution,
      remoteCandidates: [...resolution.remoteCandidates, candidate],
    },
  }
}

const MAX_BLOCKER_SUMMARY = 500

function boundedReviewText(value: string, limit = MAX_BLOCKER_SUMMARY): string {
  const normalized = value.normalize('NFKC').replace(/\s+/gu, ' ').trim()
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`
}

function modificationBlockers(review: ReviewRecord): ModificationBlocker[] {
  const blockers = new Map<string, ModificationBlocker>()
  if (review.compatibility.status === 'incompatible') {
    const runtime = review.compatibility.runtimeVersion && valid(review.compatibility.runtimeVersion)
    const incompatiblePeers = runtime
      ? Object.entries(review.manifest.peerDependencies)
        .filter(([name, range]) => name.startsWith('@deepseek-ai/dsh-')
          && (!validRange(range) || !satisfies(runtime, range, { includePrerelease: true })))
      : []
    if (incompatiblePeers.length > 0) {
      for (const [name, range] of incompatiblePeers) {
        const key = `compatibility:${hashObject({ name, runtime }).slice(0, 24)}`
        blockers.set(key, {
          key,
          kind: 'compatibility',
          summary: boundedReviewText(`${name} peer range ${range} excludes active runtime ${runtime}.`),
        })
      }
    } else {
      const summary = boundedReviewText(review.compatibility.reason)
      const key = `compatibility:${hashObject({ summary, runtime: review.compatibility.runtimeVersion }).slice(0, 24)}`
      blockers.set(key, { key, kind: 'compatibility', summary })
    }
  }
  for (const capability of review.missingCapabilities) {
    const summary = boundedReviewText(capability)
    const key = `missing:${hashObject(summary).slice(0, 16)}`
    blockers.set(key, { key, kind: 'missing_capability', summary })
  }
  for (const finding of review.findings.filter((item) => item.severity === 'block')) {
    const source = boundedReviewText(finding.source, 200)
    const identityEvidence = finding.evidenceHash ?? boundedReviewText(finding.detail, 300)
    const key = `finding:${hashObject({ code: finding.code, source, identityEvidence }).slice(0, 24)}`
    blockers.set(key, {
      key,
      kind: 'security_finding',
      summary: boundedReviewText(`${finding.code} at ${finding.source}: ${finding.detail}`),
    })
  }
  const boundary = hostDirectUseBoundary(review)
  if (boundary === 'not_materializable') {
    blockers.set(`host_boundary:${boundary}`, {
      key: `host_boundary:${boundary}`,
      kind: 'host_boundary',
      summary: 'The reviewed source cannot yet be materialized as an installable DSH bundle.',
    })
  }
  return [...blockers.values()]
}

function blockerStillPresent(blocker: ModificationBlocker, review: ReviewRecord): boolean {
  return modificationBlockers(review).some((current) => current.key === blocker.key)
}

function modificationDelta(baseline: readonly ModificationBlocker[], review: ReviewRecord): {
  resolved: ModificationBlocker[]
  unresolved: ModificationBlocker[]
  introduced: ModificationBlocker[]
} {
  const baselineKeys = new Set(baseline.map((item) => item.key))
  return {
    resolved: baseline.filter((item) => !blockerStillPresent(item, review)),
    unresolved: baseline.filter((item) => blockerStillPresent(item, review)),
    introduced: modificationBlockers(review).filter((item) => !baselineKeys.has(item.key)),
  }
}

function modificationAcceptance(input: {
  baselineReview: ReviewRecord
  baselineBlockers: readonly ModificationBlocker[]
  postReview: ReviewRecord
  meaningfulInstruction: boolean
  attempt: number
}): ReturnType<typeof modificationDelta> & {
  evaluatorStable: boolean
  status: ModificationOutcome['status']
  canCorrect: boolean
} {
  const delta = modificationDelta(input.baselineBlockers, input.postReview)
  const evaluatorStable = input.postReview.policyVersion === input.baselineReview.policyVersion
    && input.postReview.compatibility.runtimeVersion === input.baselineReview.compatibility.runtimeVersion
  const status: ModificationOutcome['status'] = !evaluatorStable
    ? 'indeterminate'
    : delta.unresolved.length > 0 || delta.introduced.length > 0
      ? 'unresolved'
      : input.meaningfulInstruction ? 'indeterminate' : 'resolved'
  return {
    ...delta,
    evaluatorStable,
    status,
    canCorrect: input.attempt === 1
      && evaluatorStable
      && delta.unresolved.length > 0
      && delta.introduced.length === 0,
  }
}

const TOOLCHAIN_TOKEN = String.raw`vitest|\btsc\b|typescript|typecheck|test runner|dev toolchain|\btoolchain\b`
const TOOLCHAIN_MISSING = String.raw`unavailable|not (?:found|installed|present|available)|is not recognized|command not found|ENOENT|未安装|不可用|找不到|缺失`
const TEST_FAILURE = String.raw`(?:tests?|test run).{0,60}(?:failed|failure)|测试.{0,40}失败`
const CLAUSE_BREAKS = new Set(['.', ';', '\n', '。', '；'])

function reportsUnavailableLocalToolchain(report: string): boolean {
  return new RegExp(String.raw`(?:${TOOLCHAIN_TOKEN}).{0,80}(?:${TOOLCHAIN_MISSING})`, 'iu').test(report)
    || new RegExp(String.raw`(?:${TOOLCHAIN_MISSING}).{0,80}(?:${TOOLCHAIN_TOKEN})`, 'iu').test(report)
    || /(?:cannot find|can't find|could not find) (?:module|package) ['"`]?(?:vitest|typescript|tsc)\b/iu.test(report)
    || /本地(?:开发)?(?:测试)?工具链?.{0,24}(?:不可用|未安装|缺失)/iu.test(report)
}

function clauseContaining(text: string, start: number, end: number): string {
  let from = 0
  for (let i = start - 1; i >= 0; i--) {
    if (CLAUSE_BREAKS.has(text[i]!)) {
      from = i + 1
      break
    }
  }
  let to = text.length
  for (let i = end; i < text.length; i++) {
    if (CLAUSE_BREAKS.has(text[i]!)) {
      to = i
      break
    }
  }
  return text.slice(from, to)
}

function reportsGenuineTestFailure(report: string): boolean {
  // Tight assertion evidence is independent of a missing sibling tool such as tsc.
  if (/\bAssertionError\b|\b\d+ failing assertions?\b|\bexpected \d+ to (?:be|equal) \d+\b/iu.test(report)) return true
  for (const match of report.matchAll(new RegExp(TEST_FAILURE, 'giu'))) {
    const start = match.index
    const clause = clauseContaining(report, start, start + match[0].length)
    // "npm test failed because vitest is not recognized" stays unavailable; unexplained test failures do not.
    if (!reportsUnavailableLocalToolchain(clause)) return true
  }
  return false
}

function childCheckEvidence(taskResult: string): ModificationAttemptEvidence['checks'] {
  const report = taskResult.replace(/\s*AUTOEVO_CHILD_COMPLETED\s*$/u, '')
  if (reportsGenuineTestFailure(report)) {
    return {
      source: 'child_reported',
      status: 'failed',
      summary: 'The managed child reported that tests failed; Host did not independently observe the command result.',
    }
  }
  // Command failures caused only by missing local tools are not assertion failures.
  if (reportsUnavailableLocalToolchain(report)) {
    return {
      source: 'child_reported',
      status: 'unavailable',
      summary: 'Checks could not run because the local toolchain was unavailable; the plugin is not verified. The managed child reported missing local test tools; Host did not independently observe the command result.',
    }
  }
  if (/skipped (?:the )?(?:test|tests|test run)|tests? (?:were )?not run|未运行测试|跳过测试/iu.test(report)) {
    return { source: 'child_reported', status: 'skipped', summary: 'The managed child reported that tests were skipped.' }
  }
  if (/(?:tests?|test run).{0,60}(?:passed|successful)|测试.{0,40}通过/iu.test(report)) {
    return { source: 'child_reported', status: 'passed', summary: 'The managed child reported that tests passed; Host did not independently observe the command result.' }
  }
  if (new RegExp(TEST_FAILURE, 'iu').test(report)) {
    return { source: 'child_reported', status: 'failed', summary: 'The managed child reported that tests failed; Host did not independently observe the command result.' }
  }
  return { source: 'unknown', status: 'unknown', summary: 'Host did not independently observe a test command result.' }
}

function authenticatedModificationInstruction(resolution: ResolutionRecord, review: ReviewRecord): string | undefined {
  return [...(resolution.decisions ?? [])].reverse().find((item) => item.phase === 'gate2'
    && item.action === 'modify_this'
    && item.reviewId === review.id)?.userMessage?.trim()
}

function hasMeaningfulModificationInstruction(instruction: string | undefined): instruction is string {
  if (!instruction) return false
  const normalized = instruction.normalize('NFKC').trim().toLowerCase()
  return !new Set(['modify_this', 'modify', '在这个上改', '修改这个', '改这个', '先改进已审查候选']).has(normalized)
}

function modificationTask(
  resolution: ResolutionRecord,
  review: ReviewRecord,
  blockers = modificationBlockers(review),
  focusedCorrection = false,
): string {
  const userInstruction = authenticatedModificationInstruction(resolution, review)
  return [
    `Improve the reviewed plugin for this original capability requirement: ${resolution.requirement}`,
    ...(userInstruction ? [`Authenticated user modification instruction: ${userInstruction}`] : []),
    focusedCorrection
      ? 'This is the single focused correction allowed after Host re-review. Investigate why the bounded targets below remain; do not mechanically assume a particular file or implementation.'
      : 'Use your own repository investigation and judgment to implement the smallest complete change.',
    `Host-observed modification targets: ${JSON.stringify(blockers)}`,
    'Acceptance boundary: after your change, Host re-review must no longer report these targets and must not introduce a new blocking target. Preserve package identity; choose the implementation path yourself.',
  ].join('\n')
}

function newResolutionId(requirement: string): string {
  return `resolution_${hashObject({ requirement, at: new Date().toISOString(), nonce: randomUUID() }).slice(0, 24)}`
}

function materialReviewFacts(review: ReviewRecord): unknown {
  const sourceIdentity = review.sourceSnapshot.kind === 'github'
    ? {
        kind: 'github' as const,
        repository: review.sourceSnapshot.repository,
        commit: review.sourceSnapshot.commit,
      }
    : review.sourceSnapshot
  return {
    policyVersion: review.policyVersion,
    requirement: review.requirement,
    sourceIdentity,
    inspectedFiles: review.inspectedFiles,
    manifest: review.manifest,
    compatibility: review.compatibility,
  }
}

function assertRequirement(requirement: string): string {
  const value = requirement.normalize('NFKC').trim()
  if (!value || value.length > 2_000) {
    throw new EvolutionError('invalid_input', 'requirement must contain 1 to 2000 characters')
  }
  return value
}

function shouldReviewAdaptiveThird(
  mode: ReviewMode,
  reviews: ReviewRecord[],
  workflow?: WorkflowRecord,
): boolean {
  return mode === 'fixed' || !reviews.some((item) => isDirectlyUsableReview(item, workflow))
}

function waitingAuthorization(
  resolutionId: string,
  decision: ResolutionRecord['decision'],
  remoteDiscoveryComplete: boolean,
  remoteCandidateSource?: ResolutionRecord['remoteCandidateSource'],
): ResolutionAuthorization {
  if (decision === 'inspect_remote' && remoteCandidateSource === 'marketplace-setup') {
    return {
      state: 'market_required',
      resolutionId,
      reason: 'The DSH plugin marketplace still needs to finish installing. That is search infrastructure, not permission to create a plugin.',
    }
  }
  if (!remoteDiscoveryComplete && decision !== 'use_local') {
    return {
      state: 'selection_required',
      resolutionId,
      reason: 'Remote discovery did not finish. Retry capability_workflow; nothing will be created until the user chooses.',
    }
  }
  return {
    state: 'selection_required',
    resolutionId,
    reason: 'Waiting for the user to choose a candidate, create new, or stop.',
  }
}

export function lineageRootReview(base: ReviewRecord, reviews: readonly ReviewRecord[]): ReviewRecord {
  const byId = new Map(reviews.map((item) => [item.id, item]))
  byId.set(base.id, base)
  const seen = new Set<string>()
  let current = base
  while (current.sourceSnapshot.kind === 'local') {
    if (seen.has(current.id)) {
      throw new EvolutionError('invalid_input', 'baseReviewId lineage is cyclic')
    }
    seen.add(current.id)
    const parent = byId.get(current.sourceSnapshot.baseReviewId)
    if (!parent) {
      throw new EvolutionError('invalid_input', 'baseReviewId must belong to a GitHub review lineage on the same resolution')
    }
    current = parent
  }
  return current
}

function latestDecision(resolution: ResolutionRecord): DecisionReceipt | undefined {
  const decisions = resolution.decisions ?? []
  return decisions[decisions.length - 1]
}

function authorizationForResolution(
  resolution: ResolutionRecord,
  reviews: readonly ReviewRecord[] = [],
): ResolutionAuthorization {
  const legacy = resolution.schemaVersion !== 2 || resolution.policyVersion !== POLICY_VERSION || !resolution.authorization
  if (legacy) {
    return {
      state: 'selection_required',
      resolutionId: resolution.id,
      reason: 'This resolution predates the current user-choice policy; run capability_workflow again.',
    }
  }

  const decision = latestDecision(resolution)
  if (decision?.phase === 'gate2') {
    const review = decision.reviewId
      ? reviews.find((item) => item.id === decision.reviewId)
      : undefined
    return authorizationFromDecision(
      resolution.id,
      decision.action,
      decision.selectedRepositories,
      review,
    )
  }

  if (resolution.remoteCandidateSource === 'marketplace-setup' && resolution.decision === 'inspect_remote') {
    return resolution.authorization?.state === 'market_required'
      ? resolution.authorization
      : waitingAuthorization(resolution.id, resolution.decision, Boolean(resolution.remoteDiscoveryComplete), resolution.remoteCandidateSource)
  }

  const selected = resolution.selectedRepositories ?? []
  if (selected.length > 0) {
    const reviewed = selected.some((repository) => reviews.some((review) => review.sourceSnapshot.kind === 'github'
      && review.sourceSnapshot.repository.toLowerCase() === repository.toLowerCase()))
    return {
      state: reviewed ? 'confirmation_required' : 'selection_required',
      resolutionId: resolution.id,
      reason: reviewed
        ? 'A selected plugin was reviewed. The user must choose use this, create new, or stop.'
        : 'Review only the repositories the user selected.',
      selectedRepositories: selected,
    }
  }

  return resolution.authorization ?? waitingAuthorization(
    resolution.id,
    resolution.decision,
    Boolean(resolution.remoteDiscoveryComplete),
    resolution.remoteCandidateSource,
  )
}

function withNextStep(record: ResolutionRecord): ResolutionRecord {
  const authorization = record.authorization
  if (!authorization) return record
  return { ...record, nextStep: nextStepForAuthorization(record.requirement, authorization) }
}

function asToolExec(exec: WorkflowExec): ToolRunContext {
  return exec as ToolRunContext
}

export { reviewCandidateDigest, reviewSnapshotDigest } from './review/direct-use.js'

export function boundedReviewerFiles(files: readonly ContentFile[], inspected: ReviewRecord['inspectedFiles']): BoundedReviewFile[] {
  return inspected.map((item) => {
    const file = files.find((entry) => entry.path === item.path)
    return {
      path: item.path,
      sha256: item.sha256,
      bytes: item.bytes,
      text: file ? Buffer.from(file.content).toString('utf8') : '',
    }
  })
}

function isReviewerIntegrityError(error: unknown): boolean {
  return error instanceof EvolutionError && (error.code === 'invalid_input' || error.code === 'review_rejected')
}

function hostMintedUncertain(
  review: ReviewRecord,
  workflowId: string,
  snapshotDigest: string,
  candidateDigest: string,
  evidence: string,
): { request: ReviewerRequest; verdict: ReviewerVerdict } {
  const request = mintReviewerRequest({
    workflowId,
    review,
    snapshotDigest,
    candidateDigest,
  })
  const completedAt = new Date().toISOString()
  return {
    request: { ...request, status: 'completed', startedAt: request.createdAt, completedAt },
    verdict: {
      requestId: request.id,
      reviewId: review.id,
      requirementHash: requirementHashFor(review.requirement),
      snapshotDigest,
      candidateDigest,
      reviewerSessionId: 'host',
      reviewerVersion: REVIEWER_VERSION,
      decision: 'uncertain',
      evidence: [evidence.slice(0, 300)],
      conditions: [],
      semanticCoverage: 'none',
      createdAt: completedAt,
    },
  }
}

export function assertSemanticReviewerBinding(
  review: ReviewRecord,
  result: { request: ReviewerRequest; verdict: ReviewerVerdict },
  expected: { snapshotDigest: string; candidateDigest: string },
): void {
  if (result.request.reviewId !== review.id || result.verdict.reviewId !== review.id) {
    throw new EvolutionError('invalid_input', 'Semantic reviewer result is not bound to this review', {
      reviewId: review.id,
    })
  }
  if (result.request.id !== result.verdict.requestId) {
    throw new EvolutionError('invalid_input', 'Semantic reviewer verdict is not bound to its request')
  }
  if (result.request.snapshotDigest !== expected.snapshotDigest
    || result.verdict.snapshotDigest !== expected.snapshotDigest
    || result.request.candidateDigest !== expected.candidateDigest
    || result.verdict.candidateDigest !== expected.candidateDigest) {
    throw new EvolutionError('invalid_input', 'Semantic reviewer result digest mismatch', {
      expectedSnapshot: expected.snapshotDigest,
      expectedCandidate: expected.candidateDigest,
    })
  }
  if (result.verdict.requirementHash !== requirementHashFor(review.requirement)) {
    throw new EvolutionError('invalid_input', 'Semantic reviewer requirement hash mismatch')
  }
}

export async function attachSemanticReview(input: {
  host: SemanticReviewerHost
  review: ReviewRecord
  files: readonly ContentFile[]
  exec: WorkflowExec
  workflow?: WorkflowRecord
  timeoutMs: number
}): Promise<ReviewRecord> {
  if (!needsSemanticReviewer(input.review)) return input.review
  if (!input.exec.agent) {
    throw new EvolutionError('invalid_input', 'A live top-level Agent is required to attach a semantic reviewer')
  }
  if ((input.exec.agent.session?.header?.delegationDepth ?? 0) !== 0) {
    throw new EvolutionError('invalid_input', 'Semantic review requires a top-level parent Agent')
  }
  const snapshotDigest = reviewSnapshotDigest(input.review)
  const candidateDigest = reviewCandidateDigest(input.review, input.workflow)
  const workflowId = input.workflow?.id
    ?? `workflow_${hashObject({ resolutionId: input.review.resolutionId, reviewId: input.review.id }).slice(0, 24)}`
  try {
    const result = await input.host.run({
      parent: input.exec.agent,
      workflowId,
      review: input.review,
      candidateDigest,
      snapshotDigest,
      files: boundedReviewerFiles(input.files, input.review.inspectedFiles),
      timeoutMs: input.timeoutMs,
      ...(input.exec.signal ? { signal: input.exec.signal } : {}),
    })
    assertSemanticReviewerBinding(input.review, result, { snapshotDigest, candidateDigest })
    return {
      ...input.review,
      reviewerRequestId: result.request.id,
      reviewerRequest: result.request,
      reviewerVerdict: result.verdict,
    }
  } catch (error) {
    if (isReviewerIntegrityError(error)) throw error
    const minted = hostMintedUncertain(
      input.review,
      workflowId,
      snapshotDigest,
      candidateDigest,
      error instanceof Error ? error.message : String(error),
    )
    return {
      ...input.review,
      reviewerRequestId: minted.request.id,
      reviewerRequest: minted.request,
      reviewerVerdict: minted.verdict,
    }
  }
}

export class CapabilityEvolutionService implements WorkflowHost {
  readonly installer: PluginInstaller
  readonly remover: PluginRemover
  readonly sources: SourceManager
  private readonly launcher: DshLauncher
  private readonly engine: WorkflowEngine
  private readonly managedChild: ManagedChildHost
  private readonly semanticReviewer: SemanticReviewerHost
  private readonly semanticVerifier: SemanticVerifierHost

  constructor(
    private readonly ctx: Context,
    private readonly config: RuntimeConfig,
    private readonly runner: CommandRunner,
    private readonly store: StateStore,
    private readonly creationGuard: CreationGuard,
    managedChild?: ManagedChildHost,
    semanticReviewer?: SemanticReviewerHost,
    semanticVerifier?: SemanticVerifierHost,
  ) {
    this.launcher = new DshLauncher(runner, config)
    this.sources = new SourceManager(config, runner)
    this.managedChild = managedChild ?? new DshManagedChildHost(ctx, runner)
    this.semanticReviewer = semanticReviewer ?? new DshSemanticReviewerHost(ctx)
    this.semanticVerifier = semanticVerifier ?? new DshSemanticVerifierHost(ctx)
    this.installer = new PluginInstaller(
      ctx,
      config,
      store,
      this.launcher,
      (review, signal) => this.revalidate(review, signal),
      async (review, exec, binding) => {
        const resolution = await this.store.getResolution(review.resolutionId)
        this.creationGuard.assertInstallAuthorized(exec.agent, review, resolution, binding)
      },
      undefined,
      this.semanticVerifier,
    )
    this.remover = new PluginRemover(ctx, config, store, this.launcher)
    this.engine = new WorkflowEngine(store, creationGuard, this)
  }

  start(requirement: string, exec: ToolRunContext): Promise<WorkflowView> {
    return this.engine.start(requirement, exec)
  }

  resume(input: ResumeInput, exec: ToolRunContext): Promise<WorkflowView> {
    return this.engine.resume(input, exec)
  }

  refine(input: DiscoveryRefineInput, exec: ToolRunContext): Promise<WorkflowView> {
    return this.engine.refine(input, exec)
  }

  present(input: DiscoveryPresentInput, exec: ToolRunContext): Promise<WorkflowView> {
    return this.engine.present(input, exec)
  }

  diagnose(input: WorkflowDiagnoseInput, exec: ToolRunContext): Promise<WorkflowView> {
    return this.engine.diagnose(input, exec)
  }

  recover(input: WorkflowRecoveryInput, exec: ToolRunContext): Promise<WorkflowView> {
    return this.engine.recover(input, exec)
  }

  remove(input: RemoveInput, exec: ToolRunContext): Promise<RemovalResult> {
    return this.remover.remove(input, exec)
  }

  cleanupInstallation(installationId: string, exec: WorkflowExec): Promise<RemovalResult> {
    return this.remover.remove({ installationId }, asToolExec(exec))
  }

  async bootstrapResolution(requirementInput: string, exec: WorkflowExec): Promise<ResolutionRecord> {
    const requirement = assertRequirement(requirementInput)
    const activeProfile = activeProfileFromArgv(process.argv.slice(2))
    const local = await resolveLocalCapabilities(this.ctx, requirement, asToolExec(exec), {
      dshHome: this.config.dshHome,
      ...(activeProfile ? { activeProfile } : {}),
    })
    const decision: ResolutionRecord['decision'] = local.shouldDiscoverRemote ? 'none' : 'use_local'
    const id = newResolutionId(requirement)
    const authorization = waitingAuthorization(id, decision, !local.shouldDiscoverRemote)
    const record: ResolutionRecord = {
      schemaVersion: 2,
      id,
      policyVersion: POLICY_VERSION,
      createdAt: new Date().toISOString(),
      requirement,
      cwd: local.cwd,
      decision,
      localCandidates: local.candidates,
      remoteCandidates: [],
      remoteDiscoveryComplete: !local.shouldDiscoverRemote,
      authorization,
      queries: [],
      reasons: [...local.reasons],
    }
    const waiting = withNextStep(record)
    await this.store.put('resolutions', waiting)
    return waiting
  }

  async discoverRemote(resolution: ResolutionRecord, exec: WorkflowExec): Promise<ResolutionRecord> {
    const discovery = await discoverRemoteCandidates({
      ctx: this.ctx,
      config: this.config,
      requirement: resolution.requirement,
      exec: asToolExec(exec),
    })
    const decision: ResolutionRecord['decision'] = discovery.source === 'marketplace-setup' || discovery.candidates.length > 0
      ? 'inspect_remote'
      : resolution.decision === 'use_local'
        ? 'use_local'
        : 'none'
    const authorization = waitingAuthorization(
      resolution.id,
      decision,
      discovery.complete,
      discovery.source,
    )
    const { remoteCandidateSource: _ignoredSource, ...withoutSource } = resolution
    void _ignoredSource
    const next = withNextStep({
      ...withoutSource,
      decision,
      remoteCandidates: discovery.candidates.slice(0, this.config.maxCandidates),
      ...(discovery.source ? { remoteCandidateSource: discovery.source } : {}),
      remoteDiscoveryComplete: discovery.complete,
      authorization,
      queries: [...resolution.queries, ...discovery.queries],
      reasons: [...resolution.reasons, ...discovery.reasons],
    })
    await this.store.put('resolutions', next)
    return next
  }

  async refineRemote(
    resolution: ResolutionRecord,
    input: { queries: string[]; repositories: string[] },
    exec: WorkflowExec,
  ): Promise<ResolutionRecord> {
    const discovery = input.queries.length > 0
      ? await discoverRemoteCandidates({
          ctx: this.ctx,
          config: this.config,
          requirement: resolution.requirement,
          queries: input.queries,
          exec: asToolExec(exec),
        })
      : { candidates: [], complete: false, queries: [], reasons: [] }
    let accumulated = { ...resolution, remoteCandidates: [...resolution.remoteCandidates] }
    for (const repository of input.repositories) {
      const added = addExplicitCandidate(accumulated, repository)
      accumulated = added.resolution
      const index = accumulated.remoteCandidates.findIndex((item) => item.repository.toLowerCase()
        === added.candidate.repository.toLowerCase())
      if (index >= 0) {
        accumulated.remoteCandidates[index] = {
          ...accumulated.remoteCandidates[index]!,
          matchReason: 'Model proposed this repository; Host validated its GitHub identity. Metadata remains unverified until review.',
        }
      }
    }
    const merged = new Map(accumulated.remoteCandidates
      .map((candidate) => [candidate.repository.toLowerCase(), candidate] as const))
    for (const candidate of discovery.candidates) merged.set(candidate.repository.toLowerCase(), candidate)
    const candidates = [...merged.values()].slice(0, 20)
    const complete = resolution.remoteDiscoveryComplete || discovery.complete
    const decision: ResolutionRecord['decision'] = candidates.length > 0 ? 'inspect_remote' : resolution.decision
    const authorization = waitingAuthorization(
      resolution.id,
      decision,
      complete,
      discovery.source ?? resolution.remoteCandidateSource,
    )
    const next = withNextStep({
      ...accumulated,
      decision,
      remoteCandidates: candidates,
      remoteDiscoveryComplete: complete,
      authorization,
      queries: [...new Set([...resolution.queries, ...discovery.queries])],
      reasons: [...resolution.reasons, ...discovery.reasons],
      ...(discovery.source ?? resolution.remoteCandidateSource
        ? { remoteCandidateSource: (discovery.source ?? resolution.remoteCandidateSource)! }
        : {}),
    })
    await this.store.put('resolutions', next)
    return next
  }

  async ensureMarket(resolution: ResolutionRecord, exec: WorkflowExec): Promise<{
    resolution: ResolutionRecord
    market: MarketplaceStepResult
  }> {
    const setup = await installMarketplace({
      ctx: this.ctx,
      config: this.config,
      launcher: this.launcher,
      cwd: resolution.cwd,
      exec: asToolExec(exec),
      requirement: resolution.requirement,
    })
    const reasons = [...resolution.reasons, setup.reason]
    if (setup.status === 'loaded') {
      const { remoteCandidateSource: _ignored, ...withoutSource } = resolution
      void _ignored
      const next = withNextStep({
        ...withoutSource,
        reasons,
        remoteDiscoveryComplete: false,
        authorization: waitingAuthorization(resolution.id, 'inspect_remote', false),
      })
      await this.store.put('resolutions', next)
      return { resolution: next, market: { status: 'loaded', reason: setup.reason } }
    }
    if (setup.status === 'denied' || setup.status === 'failed' || setup.status === 'no_profile') {
      const authorization: ResolutionAuthorization = {
        state: 'market_required',
        resolutionId: resolution.id,
        reason: setup.reason,
      }
      const next = withNextStep({
        ...resolution,
        remoteCandidates: [],
        remoteDiscoveryComplete: false,
        authorization,
        reasons,
      })
      await this.store.put('resolutions', next)
      return { resolution: next, market: { status: 'blocked', reason: setup.reason } }
    }
    const authorization: ResolutionAuthorization = {
      state: 'market_required',
      resolutionId: resolution.id,
      reason: prefersChinese(resolution.requirement)
        ? '市场插件已写入 profile，但当前进程热加载失败。请重启 DSH，再调用 capability_workflow。'
        : 'The marketplace plugin is a profile dependency, but this process could not hot-load it. Restart DSH, then call capability_workflow again.',
    }
    const next = withNextStep({
      ...resolution,
      authorization,
      reasons,
    })
    await this.store.put('resolutions', next)
    return { resolution: next, market: { status: 'restart', reason: setup.reason } }
  }

  async reviewGithub(
    resolution: ResolutionRecord,
    repository: string,
    ref: string | undefined,
    exec: WorkflowExec,
    workflow?: WorkflowRecord,
  ): Promise<{ resolution: ResolutionRecord; review: ReviewRecord }> {
    const selected = (resolution.selectedRepositories ?? []).map((item) => item.toLowerCase())
    if (!selected.includes(repository.toLowerCase())) {
      throw new EvolutionError(
        'invalid_input',
        'This repository was not selected by the user for this resolution',
        { repository },
      )
    }
    const candidate = resolution.remoteCandidates.find((item) => item.repository.toLowerCase() === repository.toLowerCase())
    if (!candidate) {
      throw new EvolutionError('invalid_input', 'The repository is not a candidate from this resolution', {
        repository,
      })
    }
    const runtimeVersion = await this.dshRuntimeVersion(resolution.cwd, exec.signal)
    const evidence = await reviewGithubPluginWithFiles({
      runner: this.runner,
      config: this.config,
      cwd: resolution.cwd,
      repository: candidate.repository,
      ref: ref ?? candidate.defaultBranch ?? 'HEAD',
      resolutionId: resolution.id,
      requirement: resolution.requirement,
      ...(runtimeVersion ? { runtimeVersion } : {}),
      ...(exec.signal ? { signal: exec.signal } : {}),
    })
    const review = await this.persistReviewed(evidence.record, evidence.files, exec, workflow)
    const waiting = withNextStep(this.waitingConfirmation(resolution, review, workflow))
    await this.store.put('resolutions', waiting)
    return { resolution: waiting, review }
  }

  async reviewGithubBatch(
    resolution: ResolutionRecord,
    repositories: string[],
    mode: ReviewMode,
    exec: WorkflowExec,
    workflow?: WorkflowRecord,
  ): Promise<{
    resolution: ResolutionRecord
    reviews: ReviewRecord[]
    failures: Array<{ repository: string; code: string; message: string }>
  }> {
    const selected = new Set((resolution.selectedRepositories ?? []).map((item) => item.toLowerCase()))
    const ordered = [...new Set(repositories)].slice(0, 3)
    for (const repository of ordered) {
      if (!selected.has(repository.toLowerCase())) {
        throw new EvolutionError('invalid_input', 'This repository was not selected for read-only review', { repository })
      }
    }
    const runtimeVersion = await this.dshRuntimeVersion(resolution.cwd, exec.signal)
    const reviews: ReviewRecord[] = []
    const failures: Array<{ repository: string; code: string; message: string }> = []
    const reviewOne = async (repository: string): Promise<ReviewRecord> => {
      const candidate = resolution.remoteCandidates.find((item) => item.repository.toLowerCase() === repository.toLowerCase())
      if (!candidate) throw new EvolutionError('invalid_input', 'Repository is outside the discovery snapshot', { repository })
      const evidence = await reviewGithubPluginWithFiles({
        runner: this.runner,
        config: this.config,
        cwd: resolution.cwd,
        repository: candidate.repository,
        ref: candidate.defaultBranch ?? 'HEAD',
        resolutionId: resolution.id,
        requirement: resolution.requirement,
        ...(runtimeVersion ? { runtimeVersion } : {}),
        ...(exec.signal ? { signal: exec.signal } : {}),
      })
      return await this.persistReviewed(evidence.record, evidence.files, exec, workflow)
    }
    const runBatch = async (batch: string[]): Promise<void> => {
      const settled = await Promise.allSettled(batch.map(reviewOne))
      for (let index = 0; index < settled.length; index += 1) {
        const result = settled[index]!
        const repository = batch[index]!
        if (result.status === 'fulfilled') {
          reviews.push(result.value)
        } else {
          failures.push({
            repository,
            code: result.reason instanceof EvolutionError ? result.reason.code : 'command_failed',
            message: (result.reason instanceof Error ? result.reason.message : String(result.reason)).slice(0, 500),
          })
        }
      }
    }
    await runBatch(ordered.slice(0, 2))
    if (ordered[2] && shouldReviewAdaptiveThird(mode, reviews, workflow)) await runBatch([ordered[2]])

    const rank = (review: ReviewRecord): number => {
      if (isDirectlyUsableReview(review, workflow)) return 0
      if (review.recommendation === 'modify' || review.fit !== 'none') return 1
      return 2
    }
    reviews.sort((left, right) => rank(left) - rank(right))
    const primary = reviews[0]
    const waiting = primary
      ? withNextStep(this.waitingConfirmation({ ...resolution, selectedRepositories: ordered }, primary, workflow))
      : resolution
    await this.store.put('resolutions', waiting)
    return { resolution: waiting, reviews, failures }
  }

  async reviewLocal(
    resolution: ResolutionRecord,
    path: string,
    baseReviewId: string,
    exec: WorkflowExec,
    workflow?: WorkflowRecord,
  ): Promise<{ resolution: ResolutionRecord; review: ReviewRecord }> {
    const prior = await this.store.listReviews(resolution.id)
    const current = authorizationForResolution(resolution, prior)
    if (current.state !== 'modify_review') {
      throw new EvolutionError(
        'invalid_input',
        'A local modification review requires the user to choose improve-this first',
        { state: current.state },
      )
    }
    const base = await this.store.getReview(baseReviewId)
    const lineage = [base, ...prior]
    const root = lineageRootReview(base, lineage)
    if (base.resolutionId !== resolution.id || root.resolutionId !== resolution.id || root.sourceSnapshot.kind !== 'github') {
      throw new EvolutionError('invalid_input', 'baseReviewId must belong to a GitHub review lineage on the same resolution')
    }
    const runtimeVersion = await this.dshRuntimeVersion(resolution.cwd, exec.signal)
    const local = await reviewLocalPlugin({
      runner: this.runner,
      config: this.config,
      workspaceRoot: resolution.cwd,
      path,
      baseReviewId: base.id,
      lineageRootCommit: root.sourceSnapshot.commit,
      resolutionId: resolution.id,
      requirement: resolution.requirement,
      ...(runtimeVersion ? { runtimeVersion } : {}),
    })
    if (local.record.sourceSnapshot.kind !== 'local'
      || local.record.sourceSnapshot.baseCommit.toLowerCase() !== root.sourceSnapshot.commit.toLowerCase()) {
      throw new EvolutionError('review_rejected', 'The local checkout is not based on the reviewed upstream commit')
    }
    const review = await this.persistReviewed(local.record, local.files, exec, workflow)
    const waiting = withNextStep(this.waitingConfirmation(resolution, review, workflow))
    await this.store.put('resolutions', waiting)
    return { resolution: waiting, review }
  }

  async installReviewed(
    review: ReviewRecord,
    input: WorkflowPendingInstall,
    exec: WorkflowExec,
    workflow?: WorkflowRecord,
  ): Promise<InstallationRecord> {
    assertDirectUseAllowed(review, workflow)
    const provenance = review.sourceSnapshot.kind === 'local'
      ? await this.sources.receiptForManagedPath(review.sourceSnapshot.path)
      : undefined
    if (review.sourceSnapshot.kind === 'local'
      && (!provenance || provenance.reviewId !== review.id || !provenance.artifactHash)) {
      throw new EvolutionError('review_rejected', 'Managed local review is missing matching frozen artifact provenance')
    }
    const record = await this.installer.install({
      reviewId: review.id,
      targetProfile: input.targetProfile,
      retention: input.retention,
      ...(input.verificationTask !== undefined ? { verificationTask: input.verificationTask } : {}),
      ...(input.verificationExpectedText !== undefined ? { verificationExpectedText: input.verificationExpectedText } : {}),
      ...(provenance?.artifactHash ? { expectedArtifactSha256: provenance.artifactHash } : {}),
    }, asToolExec(exec), {
      ...(workflow ? { workflow } : {}),
      ...(workflow?.actionCommitment ? { commitment: workflow.actionCommitment } : {}),
      ...(workflow?.selectionReceipt ? { receipt: workflow.selectionReceipt } : {}),
      ...(input.retention ? { retention: input.retention } : {}),
    })
    return record
  }

  private requireParentAgent(exec: WorkflowExec): NonNullable<WorkflowExec['agent']> {
    if (!exec.agent) {
      throw new EvolutionError('invalid_input', 'A live parent Agent session is required for managed modify/create')
    }
    return exec.agent
  }

  private async runManagedChild(input: {
    sourceId: string
    workflowId: string
    reviewId: string
    cwd: string
    task: string
    exec: WorkflowExec
  }): Promise<ManagedChildResult> {
    try {
      return await this.managedChild.run({
        parent: this.requireParentAgent(input.exec),
        cwd: input.cwd,
        task: input.task,
        ...(input.exec.signal ? { signal: input.exec.signal } : {}),
      })
    } catch (error) {
      try {
        // Cleanup must still checkpoint bounded edits when the child inherited an
        // already-aborted user signal; otherwise cancellation itself can strand
        // a dirty tree behind an unreleasable live lock.
        const preserveSignal = input.exec.signal?.aborted ? undefined : input.exec.signal
        await this.sources.preserveInterruptedChild({
          sourceId: input.sourceId,
          workflowId: input.workflowId,
          reviewId: input.reviewId,
          ...(preserveSignal ? { signal: preserveSignal } : {}),
        })
      } catch (preserveError) {
        throw new EvolutionError(
          'command_failed',
          'Managed child failed and its bounded edits could not be checkpointed; explicit source recovery is required',
          {
            recoveryRequired: true,
            childDiagnostic: hashObject({ cause: error instanceof Error ? error.message : String(error) }),
            preserveDiagnostic: hashObject({ cause: preserveError instanceof Error ? preserveError.message : String(preserveError) }),
          },
        )
      }
      if (input.exec.signal?.aborted) throw error
      throw new EvolutionError(
        'command_failed',
        'Managed child failed; its bounded edits were checkpointed and this workflow can be retried',
        { childDiagnostic: hashObject({ cause: error instanceof Error ? error.message : String(error) }) },
      )
    }
  }

  private async preserveCancelledManagedWork(input: {
    sourceId: string
    workflowId: string
    reviewId: string
    cause: unknown
  }): Promise<never> {
    let checkpoint: SourceReceipt
    try {
      // Cancellation belongs to the user turn, not to Host cleanup.  Checkpoint
      // with the runner's own bounded timeout so an already-aborted signal
      // cannot strand a dirty tree behind a live workflow lock.
      checkpoint = await this.sources.preserveInterruptedChild({
        sourceId: input.sourceId,
        workflowId: input.workflowId,
        reviewId: input.reviewId,
      })
    } catch (preserveError) {
      throw new EvolutionError(
        'command_failed',
        'Managed child was cancelled and its edits require explicit source recovery',
        {
          recoveryRequired: true,
          cancelled: true,
          sourceId: input.sourceId,
          childDiagnostic: hashObject({ cause: input.cause instanceof Error ? input.cause.message : String(input.cause) }),
          preserveDiagnostic: hashObject({ cause: preserveError instanceof Error ? preserveError.message : String(preserveError) }),
        },
      )
    }
    throw new EvolutionError(
      'command_failed',
      'Managed child was cancelled; its bounded edits were checkpointed for recovery',
      {
        recoveryRequired: true,
        cancelled: true,
        sourceId: input.sourceId,
        branch: checkpoint.branch,
        headCommit: checkpoint.headCommit,
      },
    )
  }

  private async reviewAndFreezeManagedSource(input: {
    resolution: ResolutionRecord
    sourceId: string
    path: string
    baseReviewId: string
    lineageRootCommit: string
    workflowId: string
    exec: WorkflowExec
  }): Promise<{ resolution: ResolutionRecord; review: ReviewRecord }> {
    const runtimeVersion = await this.dshRuntimeVersion(input.resolution.cwd, input.exec.signal)
    const local = await reviewLocalPlugin({
      runner: this.runner,
      config: this.config,
      workspaceRoot: this.sources.sourceRoot,
      path: input.path,
      baseReviewId: input.baseReviewId,
      lineageRootCommit: input.lineageRootCommit,
      resolutionId: input.resolution.id,
      requirement: input.resolution.requirement,
      ...(runtimeVersion ? { runtimeVersion } : {}),
    })
    const artifactRoot = path.join(this.config.stateDir, 'review-artifacts', `${local.record.id}-${randomUUID()}`)
    const materialized = await this.launcher.materializeLocal(local.record, artifactRoot, input.exec.signal)
    const review: ReviewRecord = { ...local.record, installSpec: materialized.installSpec }
    await this.sources.recordReviewedArtifact({
      sourceId: input.sourceId,
      workflowId: input.workflowId,
      reviewId: review.id,
      artifactHash: materialized.artifactSha256,
    })
    await this.store.put('reviews', review)
    const waiting = withNextStep(this.waitingConfirmation(input.resolution, review))
    await this.store.put('resolutions', waiting)
    return { resolution: waiting, review }
  }

  async prepareModify(
    resolution: ResolutionRecord,
    review: ReviewRecord,
    exec: WorkflowExec,
    workflow: WorkflowRecord,
  ): Promise<{ resolution: ResolutionRecord; path?: string; review?: ReviewRecord }> {
    let sourceKey = workflow.managedSourceId
    if (!sourceKey && review.sourceSnapshot.kind === 'local') {
      const managed = await this.sources.receiptForManagedPath(review.sourceSnapshot.path)
      if (!managed || managed.reviewId !== review.id) {
        throw new EvolutionError('invalid_input', 'Local review is not the current tip of a managed source')
      }
      sourceKey = managed.sourceId
    }
    let receipt: SourceReceipt
    if (sourceKey) {
      receipt = await this.sources.resumeWorkflowSource(sourceKey, workflow.id, exec.signal)
    } else if (review.sourceSnapshot.kind === 'github') {
      sourceKey = sourceIdForRepository(review.sourceSnapshot.repository)
      receipt = await this.sources.materializeReviewedGithub({
        review,
        workflowId: workflow.id,
        ...(exec.signal ? { signal: exec.signal } : {}),
      })
    } else {
      throw new EvolutionError('invalid_input', 'Local modification requires a managed source receipt')
    }
    workflow.managedSourceId = sourceKey
    try {
      const baselineBlockers = modificationBlockers(review)
      const attempts: ModificationAttemptEvidence[] = []
      const instruction = authenticatedModificationInstruction(resolution, review)
      const meaningfulInstruction = hasMeaningfulModificationInstruction(instruction)
      let correctionTargets = baselineBlockers
      let automaticCorrectionUsed = false
      let currentReview = review
      let currentResolution = resolution
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const child = await this.runManagedChild({
          sourceId: sourceKey,
          workflowId: workflow.id,
          reviewId: currentReview.id,
          cwd: receipt.path,
          task: modificationTask(resolution, review, correctionTargets, attempt === 2),
          exec,
        })
        const committed = await this.sources.finalizeChildCommit({
          sourceId: sourceKey,
          workflowId: workflow.id,
          reviewId: currentReview.id,
          message: attempt === 1
            ? `fix: satisfy AutoEvo workflow ${workflow.id}`
            : `fix: complete AutoEvo workflow ${workflow.id}`,
          ...(exec.signal ? { signal: exec.signal } : {}),
        })
        const finalized = await this.reviewAndFreezeManagedSource({
          resolution: currentResolution,
          sourceId: sourceKey,
          path: receipt.path,
          baseReviewId: currentReview.id,
          lineageRootCommit: receipt.baseCommit,
          workflowId: workflow.id,
          exec,
        })
        currentReview = finalized.review
        currentResolution = finalized.resolution
        attempts.push({
          attempt,
          childSessionId: child.sessionId,
          commit: committed.headCommit,
          changedFiles: committed.changedFiles,
          changedFilesTruncated: committed.changedFilesTruncated,
          postReviewId: currentReview.id,
          completionMarkerObserved: true,
          checks: childCheckEvidence(child.taskResult),
        })
        const acceptance = modificationAcceptance({
          baselineReview: review,
          baselineBlockers,
          postReview: currentReview,
          meaningfulInstruction,
          attempt,
        })
        const outcome: ModificationOutcome = {
          contractVersion: 1,
          policyVersion: review.policyVersion,
          baselineReviewId: review.id,
          ...(meaningfulInstruction ? { instructionHash: hashObject(instruction) } : {}),
          baselineRuntimeVersion: review.compatibility.runtimeVersion,
          maxAttempts: 2,
          automaticCorrectionUsed,
          status: acceptance.status,
          attempts: [...attempts],
          resolvedBlockers: acceptance.resolved,
          unresolvedBlockers: acceptance.unresolved,
          introducedBlockers: acceptance.introduced,
        }
        workflow.modificationOutcome = outcome
        workflow.lastReviewId = currentReview.id
        workflow.lineageTipReviewId = currentReview.id
        if (outcome.status === 'unresolved' && !acceptance.canCorrect) {
          workflow.lastFailure = {
            stage: 'review',
            code: acceptance.introduced.length > 0 ? 'modify_introduced_blocker' : 'modify_targets_unresolved',
            message: acceptance.introduced.length > 0
              ? `Host re-review found ${acceptance.introduced.length} new blocking modification target(s); automatic correction stopped without expanding scope.`
              : `Host re-review still reports ${acceptance.unresolved.length} original modification target(s) after one focused correction.`,
            retryable: false,
          }
        } else {
          delete workflow.lastFailure
        }
        workflow.updatedAt = new Date().toISOString()
        await this.store.put('workflows', workflow)
        if (!acceptance.canCorrect) {
          return { resolution: currentResolution, review: currentReview, path: receipt.path }
        }
        automaticCorrectionUsed = true
        correctionTargets = acceptance.unresolved
        workflow.modificationOutcome = { ...outcome, automaticCorrectionUsed: true }
        workflow.updatedAt = new Date().toISOString()
        await this.store.put('workflows', workflow)
      }
      throw new EvolutionError('command_failed', 'Managed modification exhausted its bounded correction loop')
    } catch (error) {
      if (!exec.signal?.aborted) throw error
      return await this.preserveCancelledManagedWork({
        sourceId: sourceKey,
        workflowId: workflow.id,
        reviewId: review.id,
        cause: error,
      })
    }
  }

  async prepareCreate(
    resolution: ResolutionRecord,
    exec: WorkflowExec,
    workflow: WorkflowRecord,
  ): Promise<{ resolution: ResolutionRecord; path?: string; review?: ReviewRecord }> {
    const sourceKey = sourceIdForCreate(resolution.id)
    const receipt = await this.sources.initializeCreateSource({
      resolutionId: resolution.id,
      workflowId: workflow.id,
      ...(exec.signal ? { signal: exec.signal } : {}),
    })
    workflow.managedSourceId = sourceKey
    let reviewId = `scaffold_${hashObject({ sourceId: sourceKey, head: receipt.baseCommit }).slice(0, 24)}`
    try {
      const scaffoldBaseId = `review_${hashObject({ sourceId: sourceKey, head: receipt.baseCommit }).slice(0, 64)}`
      const runtimeVersion = await this.dshRuntimeVersion(resolution.cwd, exec.signal)
      const scaffold = await reviewLocalPlugin({
        runner: this.runner,
        config: this.config,
        workspaceRoot: this.sources.sourceRoot,
        path: receipt.path,
        baseReviewId: scaffoldBaseId,
        lineageRootCommit: receipt.baseCommit,
        resolutionId: resolution.id,
        requirement: resolution.requirement,
        ...(runtimeVersion ? { runtimeVersion } : {}),
      })
      reviewId = scaffold.record.id
      await this.store.put('reviews', scaffold.record)
      workflow.lastReviewId = scaffold.record.id
      workflow.lineageTipReviewId = scaffold.record.id
      await this.runManagedChild({
        sourceId: sourceKey,
        workflowId: workflow.id,
        reviewId: scaffold.record.id,
        cwd: receipt.path,
        task: `Implement a new DSH plugin for this requirement: ${resolution.requirement}\nBuild on the trusted scaffold, include a complete bundle patch and implementation, and add focused tests or self-checks where practical.`,
        exec,
      })
      await this.sources.finalizeChildCommit({
        sourceId: sourceKey,
        workflowId: workflow.id,
        reviewId: scaffold.record.id,
        message: `feat: implement AutoEvo workflow ${workflow.id}`,
        ...(exec.signal ? { signal: exec.signal } : {}),
      })
      const finalized = await this.reviewAndFreezeManagedSource({
        resolution,
        sourceId: sourceKey,
        path: receipt.path,
        baseReviewId: scaffold.record.id,
        lineageRootCommit: receipt.baseCommit,
        workflowId: workflow.id,
        exec,
      })
      return { ...finalized, path: receipt.path }
    } catch (error) {
      if (!exec.signal?.aborted) throw error
      return await this.preserveCancelledManagedWork({
        sourceId: sourceKey,
        workflowId: workflow.id,
        reviewId,
        cause: error,
      })
    }
  }

  async applyDecision(
    resolution: ResolutionRecord,
    resume: ValidatedResume,
    review?: ReviewRecord,
    workflow?: WorkflowRecord,
  ): Promise<ResolutionRecord> {
    if (resolution.authorization?.state === 'market_required') {
      throw new EvolutionError(
        'invalid_input',
        'Finish marketplace setup and call capability_workflow again before recording a decision',
      )
    }
    if (resume.optionId === 'use_this' && (!review || !isDirectlyUsableReview(review, workflow))) {
      throw new EvolutionError('review_rejected', 'The selected review is not directly installable', {
        reviewId: review?.id,
      })
    }
    if (resume.optionId === 'modify_this' && (!review || review.fit === 'none' || review.license === null)) {
      throw new EvolutionError('review_rejected', 'The selected review is not eligible for managed modification', {
        reviewId: review?.id,
      })
    }
    const nextRecord = resolution
    const selected = resume.repositories.length > 0
      ? [...resume.repositories]
      : [...(resolution.selectedRepositories ?? [])]
    const receipt = newDecisionReceipt('gate2', resume.optionId, selected, {
      userMessage: resume.userMessage,
      optionId: resume.optionId,
      interruptId: resume.interruptId,
      hostTurnId: resume.hostTurnId,
      snapshotDigest: resume.snapshotDigest,
      ...(resume.candidateId ? { candidateId: resume.candidateId } : {}),
      ...(resume.install ? {
        retention: resume.install.retention,
        targetProfile: resume.install.targetProfile,
      } : {}),
      ...(review ? { reviewId: review.id, reviewIdentity: reviewIdentity(review) } : {}),
    })
    const authorization = authorizationFromDecision(nextRecord.id, resume.optionId, selected, review)
    const next = withNextStep({
      ...nextRecord,
      authorization,
      selectedRepositories: selected,
      decisions: [...(nextRecord.decisions ?? []), receipt],
      reasons: [...nextRecord.reasons, authorization.reason],
      decision: nextRecord.decision,
    })
    await this.store.put('resolutions', next)
    return next
  }

  async applyNavigation(
    resolution: ResolutionRecord,
    navigation: NavigationInput,
    repositories: string[],
  ): Promise<ResolutionRecord> {
    let authorization: ResolutionAuthorization
    if (navigation.kind === 'reuse_local') {
      authorization = {
        state: 'reuse_local',
        resolutionId: resolution.id,
        reason: 'The user selected a full local capability; no plugin mutation was authorized.',
      }
    } else if (navigation.kind === 'stop') {
      authorization = {
        state: 'stopped',
        resolutionId: resolution.id,
        reason: 'The user stopped read-only capability exploration.',
      }
    } else {
      authorization = {
        state: 'selection_required',
        resolutionId: resolution.id,
        reason: navigation.kind === 'review_candidates'
          ? 'The Agent mapped the user request to snapshot-bound candidates for read-only review.'
          : 'The user asked for more read-only discovery.',
        ...(repositories.length > 0 ? { selectedRepositories: repositories } : {}),
      }
    }
    const next = withNextStep({
      ...resolution,
      authorization,
      ...(repositories.length > 0 ? { selectedRepositories: repositories } : {}),
      reasons: [...resolution.reasons, authorization.reason],
      decision: navigation.kind === 'reuse_local'
        ? 'use_local'
        : repositories.length > 0
          ? 'inspect_remote'
          : resolution.decision,
    })
    await this.store.put('resolutions', next)
    return next
  }

  async latestReview(resolutionId: string, reviewId?: string): Promise<ReviewRecord | undefined> {
    if (reviewId) {
      const review = await this.store.getReview(reviewId)
      if (review.resolutionId !== resolutionId) {
        throw new EvolutionError('invalid_input', 'review_id does not belong to this resolution', { reviewId })
      }
      return review
    }
    const reviews = await this.store.listReviews(resolutionId)
    return [...reviews].sort((left, right) => left.createdAt.localeCompare(right.createdAt)).at(-1)
  }

  getResolution(id: string): Promise<ResolutionRecord> {
    return this.store.getResolution(id)
  }

  getReview(id: string): Promise<ReviewRecord> {
    return this.store.getReview(id)
  }

  getInstallation(id: string): Promise<InstallationRecord> {
    return this.store.getInstallation(id)
  }

  listInstallProfiles(): Promise<string[]> {
    return profilesWithAutoEvo(this.launcher, this.config.dshHome)
  }

  private async persistReviewed(
    record: ReviewRecord,
    files: readonly ContentFile[],
    exec: WorkflowExec,
    workflow?: WorkflowRecord,
  ): Promise<ReviewRecord> {
    const review = await attachSemanticReview({
      host: this.semanticReviewer,
      review: record,
      files,
      exec,
      timeoutMs: this.config.commandTimeoutMs,
      ...(workflow ? { workflow } : {}),
    })
    await this.store.put('reviews', review)
    return review
  }

  async releaseManagedSource(workflow: WorkflowRecord, _exec: WorkflowExec): Promise<void> {
    if (!workflow.managedSourceId) return
    // Lock release is Host cleanup. It must outlive an aborted user turn and is
    // already bounded by the command runner's timeout.
    await this.sources.completeWorkflow(workflow.managedSourceId, workflow.id)
  }

  private waitingConfirmation(
    resolution: ResolutionRecord,
    review: ReviewRecord,
    workflow?: WorkflowRecord,
  ): ResolutionRecord {
    const chinese = prefersChinese(resolution.requirement)
    const usable = isDirectlyUsableReview(review, workflow)
    const authorization: ResolutionAuthorization = {
      state: 'confirmation_required',
      resolutionId: resolution.id,
      reason: chinese
        ? usable
          ? '审查已完成。简要比较候选并等待用户明确选择安装、修改、新建或先停。'
          : '审查已完成，但当前候选不能直接安装。简要说明阻断项，并等待用户选择修改、继续比较、新建或先停。'
        : usable
          ? 'Review finished. Compare the candidates briefly, then wait for an explicit install, modify, create, or stop decision.'
          : 'Review finished, but the current candidate is not directly installable. Explain the blockers briefly, then wait for modify, compare, create, or stop.',
      selectedRepositories: resolution.selectedRepositories ?? [],
      reviewId: review.id,
      reviewIdentity: reviewIdentity(review),
    }
    return {
      ...resolution,
      authorization,
      reasons: [...resolution.reasons, authorization.reason],
    }
  }

  private async revalidate(review: ReviewRecord, signal?: AbortSignal): Promise<boolean> {
    let lastError: unknown
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const resolution = await this.store.getResolution(review.resolutionId)
        const runtimeVersion = await this.dshRuntimeVersion(resolution.cwd, signal)
        let current: ReviewRecord
        if (review.sourceSnapshot.kind === 'github') {
          current = await reviewGithubPlugin({
            runner: this.runner,
            config: this.config,
            cwd: resolution.cwd,
            repository: review.sourceSnapshot.repository,
            ref: review.sourceSnapshot.commit,
            resolutionId: resolution.id,
            requirement: resolution.requirement,
            ...(runtimeVersion ? { runtimeVersion } : {}),
            ...(signal ? { signal } : {}),
          })
        } else {
          const prior = await this.store.listReviews(resolution.id)
          const managed = await this.sources.receiptForManagedPath(review.sourceSnapshot.path)
          const root = managed ? undefined : lineageRootReview(review, prior)
          if (!managed && root?.sourceSnapshot.kind !== 'github') return false
          const lineageRootCommit = managed?.baseCommit
            ?? (root?.sourceSnapshot.kind === 'github' ? root.sourceSnapshot.commit : undefined)
          if (!lineageRootCommit) return false
          current = (await reviewLocalPlugin({
            runner: this.runner,
            config: this.config,
            workspaceRoot: managed ? this.sources.sourceRoot : resolution.cwd,
            path: review.sourceSnapshot.path,
            baseReviewId: review.sourceSnapshot.baseReviewId,
            lineageRootCommit,
            resolutionId: resolution.id,
            requirement: resolution.requirement,
            ...(runtimeVersion ? { runtimeVersion } : {}),
          })).record
        }
        return hashObject(materialReviewFacts(current)) === hashObject(materialReviewFacts(review))
      } catch (error) {
        if (signal?.aborted) throw error
        lastError = error
      }
    }
    throw new EvolutionError(
      'command_failed',
      'Review revalidation could not complete after retry; the previous review was not marked expired',
      {
        causeCode: lastError instanceof EvolutionError ? lastError.code : 'command_failed',
        diagnosticHash: hashObject({ cause: lastError instanceof Error ? lastError.message : String(lastError) }),
      },
    )
  }

  private async dshRuntimeVersion(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
    try {
      const result = await this.runner.run({
        argv: [this.config.dshCommand, ...this.config.dshCommandArgs, '--version'],
        cwd,
        allowFailure: true,
        timeoutMs: this.config.commandTimeoutMs,
        ...(signal ? { signal } : {}),
      })
      if (result.exitCode !== 0) return undefined
      const candidate = result.stdout.trim().split(/\s+/u)[0]
      return candidate ? valid(candidate) ?? undefined : undefined
    } catch {
      return undefined
    }
  }
}

export const _testing = {
  addExplicitCandidate,
  assertRequirement,
  authorizationForResolution,
  lineageRootReview,
  materialReviewFacts,
  modificationBlockers,
  modificationAcceptance,
  modificationDelta,
  modificationTask,
  childCheckEvidence,
  reviewIdentity,
  isDirectlyUsableReview,
  shouldReviewAdaptiveThird,
  waitingAuthorization,
  attachSemanticReview,
  assertSemanticReviewerBinding,
  boundedReviewerFiles,
  reviewCandidateDigest,
  reviewSnapshotDigest,
}
