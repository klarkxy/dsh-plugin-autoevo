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
  type RemotePluginCandidate,
  type RemoveInput,
  type ResolutionAuthorization,
  type ResolutionRecord,
  type ResumeInput,
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
  phaseForOption,
  prefersChinese,
  reviewIdentity,
} from './lifecycle/decide.js'
import { PluginInstaller } from './lifecycle/install.js'
import { DshLauncher } from './lifecycle/launcher.js'
import { installMarketplace, profilesWithAutoEvo } from './lifecycle/marketplace.js'
import { PluginRemover, type RemovalResult } from './lifecycle/remove.js'
import type { CommandRunner } from './process/runner.js'
import { resolveLocalCapabilities } from './resolver/local.js'
import { reviewGithubPlugin, reviewLocalPlugin } from './review/index.js'
import { probeWorkspaceWriteSandbox, type SandboxStack } from './sandbox-probe.js'
import { SourceManager, sourceIdForCreate, sourceIdForRepository } from './source-manager.js'
import { hashObject } from './state/hashes.js'
import type { StateStore } from './state/store.js'
import { WorkflowEngine } from './workflow/engine.js'
import type {
  MarketplaceStepResult,
  ValidatedResume,
  WorkflowExec,
  WorkflowHost,
  WorkflowPendingInstall,
  WorkflowView,
} from './workflow/contracts.js'

function resolveSandboxStack(ctx: Context): SandboxStack | undefined {
  const direct = ctx.get('sandbox') as SandboxStack | undefined
  if (direct && (direct.filesystem || direct.shell)) return direct
  const filesystem = ctx.get('filesystem') as SandboxStack['filesystem'] | undefined
  const shell = ctx.get('shell') as SandboxStack['shell'] | undefined
  if (!filesystem && !shell) return undefined
  return {
    ...(filesystem !== undefined ? { filesystem } : {}),
    ...(shell !== undefined ? { shell } : {}),
  }
}

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
  if (decision && decision.action !== 'inspect' && decision.action !== 'search_more') {
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

export class CapabilityEvolutionService implements WorkflowHost {
  readonly installer: PluginInstaller
  readonly remover: PluginRemover
  readonly sources: SourceManager
  private readonly launcher: DshLauncher
  private readonly engine: WorkflowEngine

  constructor(
    private readonly ctx: Context,
    private readonly config: RuntimeConfig,
    private readonly runner: CommandRunner,
    private readonly store: StateStore,
    private readonly creationGuard: CreationGuard,
  ) {
    this.launcher = new DshLauncher(runner, config)
    this.sources = new SourceManager(config, runner)
    this.installer = new PluginInstaller(
      ctx,
      config,
      store,
      this.launcher,
      (review, signal) => this.revalidate(review, signal),
      async (review, exec) => {
        const resolution = await this.store.getResolution(review.resolutionId)
        this.creationGuard.assertInstallAuthorized(exec.agent, review, resolution)
      },
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
      remoteCandidates: discovery.candidates,
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
      const authorization = waitingAuthorization(resolution.id, 'none', true)
      const { remoteCandidateSource: _ignoredSource, ...withoutSource } = resolution
      void _ignoredSource
      const next = withNextStep({
        ...withoutSource,
        decision: 'none',
        remoteCandidates: [],
        remoteDiscoveryComplete: true,
        authorization,
        reasons,
      })
      await this.store.put('resolutions', next)
      return { resolution: next, market: { status: 'empty', reason: setup.reason } }
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
    const review = await reviewGithubPlugin({
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
    await this.store.put('reviews', review)
    const waiting = withNextStep(this.waitingConfirmation(resolution, review))
    await this.store.put('resolutions', waiting)
    return { resolution: waiting, review }
  }

  async reviewLocal(
    resolution: ResolutionRecord,
    path: string,
    baseReviewId: string,
    exec: WorkflowExec,
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
    const review = local.record
    await this.store.put('reviews', review)
    const waiting = withNextStep(this.waitingConfirmation(resolution, review))
    await this.store.put('resolutions', waiting)
    return { resolution: waiting, review }
  }

  async installReviewed(
    review: ReviewRecord,
    input: WorkflowPendingInstall,
    exec: WorkflowExec,
  ): Promise<InstallationRecord> {
    const record = await this.installer.install({
      reviewId: review.id,
      targetProfile: input.targetProfile,
      retention: input.retention,
      ...(input.verificationTask !== undefined ? { verificationTask: input.verificationTask } : {}),
      ...(input.verificationExpectedText !== undefined ? { verificationExpectedText: input.verificationExpectedText } : {}),
    }, asToolExec(exec))
    return record
  }

  private async assertChildSandbox(sourceKey: string): Promise<void> {
    await probeWorkspaceWriteSandbox(resolveSandboxStack(this.ctx), this.sources.sourcePath(sourceKey))
  }

  async prepareModify(
    resolution: ResolutionRecord,
    review: ReviewRecord,
    exec: WorkflowExec,
    workflow: { id: string },
  ): Promise<{ resolution: ResolutionRecord; path?: string; deferred?: boolean }> {
    if (review.sourceSnapshot.kind !== 'github') {
      throw new EvolutionError('invalid_input', 'modify_this currently materializes only from a GitHub review commit')
    }
    const sourceKey = sourceIdForRepository(review.sourceSnapshot.repository)
    await this.assertChildSandbox(sourceKey)
    const receipt = await this.sources.materializeReviewedGithub({
      review,
      workflowId: workflow.id,
      ...(exec.signal ? { signal: exec.signal } : {}),
    })
    // Child edits the managed source next; local re-review happens after the child returns.
    return { resolution, path: receipt.path, deferred: true }
  }

  async prepareCreate(
    resolution: ResolutionRecord,
    exec: WorkflowExec,
    workflow: { id: string },
  ): Promise<{ resolution: ResolutionRecord; path?: string; deferred?: boolean }> {
    const sourceKey = sourceIdForCreate(resolution.id)
    await this.assertChildSandbox(sourceKey)
    const receipt = await this.sources.initializeCreateSource({
      resolutionId: resolution.id,
      workflowId: workflow.id,
      ...(exec.signal ? { signal: exec.signal } : {}),
    })
    // Child implements inside the scaffolded repo; confirmation/install remain Host-gated.
    return { resolution, path: receipt.path, deferred: true }
  }

  async applyDecision(
    resolution: ResolutionRecord,
    resume: ValidatedResume,
    review?: ReviewRecord,
  ): Promise<ResolutionRecord> {
    if (resolution.authorization?.state === 'market_required') {
      throw new EvolutionError(
        'invalid_input',
        'Finish marketplace setup and call capability_workflow again before recording a decision',
      )
    }
    let nextRecord = resolution
    const selected = resume.optionId === 'inspect'
      ? [...resume.repositories]
      : resume.repositories.length > 0
        ? [...resume.repositories]
        : [...(resolution.selectedRepositories ?? [])]
    for (const repository of selected) {
      if (!nextRecord.remoteCandidates.some((item) => item.repository.toLowerCase() === repository.toLowerCase())) {
        nextRecord = addExplicitCandidate(nextRecord, repository).resolution
      }
    }
    const receipt = newDecisionReceipt(phaseForOption(resume.optionId), resume.optionId, selected, {
      userMessage: resume.userMessage,
      optionId: resume.optionId,
      interruptId: resume.interruptId,
      hostTurnId: resume.hostTurnId,
      ...(review ? { reviewId: review.id, reviewIdentity: reviewIdentity(review) } : {}),
    })
    const authorization = authorizationFromDecision(nextRecord.id, resume.optionId, selected, review)
    const next = withNextStep({
      ...nextRecord,
      authorization,
      selectedRepositories: selected,
      decisions: [...(nextRecord.decisions ?? []), receipt],
      reasons: [...nextRecord.reasons, authorization.reason],
      decision: resume.optionId === 'inspect' && selected.length > 0
        ? 'inspect_remote'
        : resume.optionId === 'use_local'
          ? 'use_local'
          : nextRecord.decision,
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

  private waitingConfirmation(resolution: ResolutionRecord, review: ReviewRecord): ResolutionRecord {
    const chinese = prefersChinese(resolution.requirement)
    const authorization: ResolutionAuthorization = {
      state: 'confirmation_required',
      resolutionId: resolution.id,
      reason: chinese
        ? '审查已完成。先在对话里讲清结果，再等用户选择用这个、在这个上改、新建或先停。'
        : 'Review finished. Explain it in chat, then wait for the user to choose use this, improve it, create new, or stop.',
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
          const root = lineageRootReview(review, prior)
          if (root.sourceSnapshot.kind !== 'github') {
            return false
          }
          current = (await reviewLocalPlugin({
            runner: this.runner,
            config: this.config,
            workspaceRoot: resolution.cwd,
            path: review.sourceSnapshot.path,
            baseReviewId: review.sourceSnapshot.baseReviewId,
            lineageRootCommit: root.sourceSnapshot.commit,
            resolutionId: resolution.id,
            requirement: resolution.requirement,
            ...(runtimeVersion ? { runtimeVersion } : {}),
          })).record
        }
        return hashObject(materialReviewFacts(current)) === hashObject(materialReviewFacts(review))
      } catch {
        if (attempt === 1) return false
      }
    }
    return false
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
  reviewIdentity,
  waitingAuthorization,
}
