import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { valid } from 'semver'
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
import { DshManagedChildHost, type ManagedChildHost } from './managed-child.js'
import type { CommandRunner } from './process/runner.js'
import { resolveLocalCapabilities } from './resolver/local.js'
import {
  assertDirectUseAllowed,
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
  ValidatedResume,
  WorkflowExec,
  WorkflowHost,
  WorkflowPendingInstall,
  WorkflowRecord,
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

function modificationTask(resolution: ResolutionRecord, review: ReviewRecord): string {
  const decision = [...(resolution.decisions ?? [])].reverse().find((item) => item.phase === 'gate2'
    && item.action === 'modify_this'
    && item.reviewId === review.id)
  const userInstruction = decision?.userMessage?.trim()
  return [
    `Improve the reviewed plugin for this original capability requirement: ${resolution.requirement}`,
    ...(userInstruction ? [`Authenticated user modification instruction: ${userInstruction}`] : []),
    `Missing capabilities: ${JSON.stringify(review.missingCapabilities)}`,
    `Review finding codes: ${JSON.stringify(review.findings.map((finding) => finding.code))}`,
    'Preserve the package identity and implement the smallest complete change.',
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

  remove(input: RemoveInput, exec: ToolRunContext): Promise<RemovalResult> {
    return this.remover.remove(input, exec)
  }

  async bootstrapResolution(requirementInput: string, exec: WorkflowExec): Promise<ResolutionRecord> {
    const requirement = assertRequirement(requirementInput)
    const local = await resolveLocalCapabilities(this.ctx, requirement, asToolExec(exec))
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
      remoteCandidates: discovery.candidates.slice(0, 3),
      ...(discovery.source ? { remoteCandidateSource: discovery.source } : {}),
      remoteDiscoveryComplete: discovery.complete,
      authorization,
      queries: [...resolution.queries, ...discovery.queries],
      reasons: [...resolution.reasons, ...discovery.reasons],
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
  }): Promise<void> {
    try {
      await this.managedChild.run({
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
      await this.runManagedChild({
        sourceId: sourceKey,
        workflowId: workflow.id,
        reviewId: review.id,
        cwd: receipt.path,
        task: modificationTask(resolution, review),
        exec,
      })
      await this.sources.finalizeChildCommit({
        sourceId: sourceKey,
        workflowId: workflow.id,
        reviewId: review.id,
        message: `fix: satisfy AutoEvo workflow ${workflow.id}`,
        ...(exec.signal ? { signal: exec.signal } : {}),
      })
      const finalized = await this.reviewAndFreezeManagedSource({
        resolution,
        sourceId: sourceKey,
        path: receipt.path,
        baseReviewId: review.id,
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
  modificationTask,
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
