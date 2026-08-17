import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { valid } from 'semver'
import type { RuntimeConfig } from './config.js'
import { CommunityQualityService, type CommunityQualitySource } from './community-quality.js'
import {
  POLICY_VERSION,
  type DecideInput,
  type DecisionReceipt,
  type InstallInput,
  type InstallationRecord,
  type RemotePluginCandidate,
  type RemoveInput,
  type ResolutionAuthorization,
  type ResolutionRecord,
  type ReviewInput,
  type ReviewRecord,
  type ReviewResult,
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
  resolveDecision,
  reviewIdentity,
} from './lifecycle/decide.js'
import { PluginInstaller } from './lifecycle/install.js'
import { DshLauncher } from './lifecycle/launcher.js'
import { installMarketplace } from './lifecycle/marketplace.js'
import { PluginRemover, type RemovalResult } from './lifecycle/remove.js'
import type { CommandRunner } from './process/runner.js'
import { resolveLocalCapabilities } from './resolver/local.js'
import { reviewGithubPlugin, reviewLocalPlugin } from './review/index.js'
import { hashObject } from './state/hashes.js'
import type { StateStore } from './state/store.js'

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
      reason: 'Remote discovery did not finish. Retry capability_resolve; nothing will be created until the user chooses.',
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
      reason: 'This resolution predates the current user-choice policy; run capability_resolve again.',
    }
  }

  const decision = latestDecision(resolution)
  if (decision && decision.action !== 'inspect') {
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

export class CapabilityEvolutionService {
  readonly installer: PluginInstaller
  readonly remover: PluginRemover
  private readonly launcher: DshLauncher
  private readonly quality: CommunityQualityService

  constructor(
    private readonly ctx: Context,
    private readonly config: RuntimeConfig,
    private readonly runner: CommandRunner,
    private readonly store: StateStore,
    private readonly creationGuard: CreationGuard,
    quality?: CommunityQualityService,
  ) {
    this.quality = quality ?? new CommunityQualityService(config)
    this.launcher = new DshLauncher(runner, config)
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
  }

  async resolve(requirementInput: string, exec: ToolRunContext): Promise<ResolutionRecord> {
    const requirement = assertRequirement(requirementInput)
    const guardGeneration = this.creationGuard.beginResolution(exec.agent)
    const local = await resolveLocalCapabilities(this.ctx, requirement, exec)
    let remoteCandidates: ResolutionRecord['remoteCandidates'] = []
    let remoteCandidateSource: ResolutionRecord['remoteCandidateSource']
    let queries: string[] = []
    let remoteDiscoveryComplete = !local.githubShouldRun
    let communityQualityScreening: ResolutionRecord['communityQualityScreening']
    const reasons = [...local.reasons]
    if (local.githubShouldRun) {
      const discovery = await discoverRemoteCandidates({
        ctx: this.ctx,
        config: this.config,
        runner: this.runner,
        cwd: local.cwd,
        requirement,
        exec,
        quality: this.quality,
      })
      remoteCandidates = discovery.candidates
      remoteCandidateSource = discovery.source
      remoteDiscoveryComplete = discovery.complete
      queries = discovery.queries
      reasons.push(...discovery.reasons)
      communityQualityScreening = discovery.qualityScreening
      if (discovery.source === 'marketplace-setup') {
        const setup = await installMarketplace({
          ctx: this.ctx,
          config: this.config,
          launcher: this.launcher,
          cwd: local.cwd,
          exec,
          requirement,
        })
        reasons.push(setup.reason)
        if (setup.status === 'loaded') {
          const again = await discoverRemoteCandidates({
            ctx: this.ctx,
            config: this.config,
            runner: this.runner,
            cwd: local.cwd,
            requirement,
            exec,
            quality: this.quality,
          })
          remoteCandidates = again.candidates
          remoteCandidateSource = again.source
          remoteDiscoveryComplete = again.complete
          queries = [...queries, ...again.queries]
          reasons.push(...again.reasons)
          communityQualityScreening = again.qualityScreening
        } else if (setup.status === 'denied' || setup.status === 'failed' || setup.status === 'no_profile') {
          remoteCandidates = []
          remoteCandidateSource = undefined
          remoteDiscoveryComplete = true
        }
      }
    }
    const decision: ResolutionRecord['decision'] = !local.githubShouldRun
      ? 'use_local'
      : remoteCandidateSource === 'marketplace-setup' || remoteCandidates.length > 0
        ? 'inspect_remote'
        : 'none'
    const id = newResolutionId(requirement)
    let authorization = waitingAuthorization(id, decision, remoteDiscoveryComplete, remoteCandidateSource)
    const record: ResolutionRecord = {
      schemaVersion: 2,
      id,
      policyVersion: POLICY_VERSION,
      createdAt: new Date().toISOString(),
      requirement,
      cwd: local.cwd,
      decision,
      localCandidates: local.candidates,
      remoteCandidates,
      ...(remoteCandidateSource ? { remoteCandidateSource } : {}),
      remoteDiscoveryComplete,
      ...(communityQualityScreening ? { communityQualityScreening } : {}),
      authorization,
      queries,
      reasons,
    }
    const waiting = withNextStep(record)
    await this.store.put('resolutions', waiting)
    this.creationGuard.applyResolutionAuthorization(exec.agent, waiting.authorization!, guardGeneration)
    return waiting
  }

  async review(input: ReviewInput, exec: ToolRunContext): Promise<ReviewResult> {
    let resolution = await this.store.getResolution(input.resolutionId)
    const runtimeVersion = await this.dshRuntimeVersion(resolution.cwd, exec.signal)
    let review: ReviewRecord
    let qualitySource: CommunityQualitySource | undefined
    if (input.sourceKind === 'github') {
      if (!input.repository) throw new EvolutionError('invalid_input', 'repository is required for a GitHub review')
      resolution = await this.ensureInspectFromLastMessage(resolution, input.repository, exec)
      const selected = (resolution.selectedRepositories ?? []).map((item) => item.toLowerCase())
      if (!selected.includes(input.repository.toLowerCase())) {
        throw new EvolutionError(
          'invalid_input',
          'This repository was not selected by the user for this resolution',
          { repository: input.repository },
        )
      }
      const candidate = resolution.remoteCandidates.find((item) => item.repository.toLowerCase() === input.repository?.toLowerCase())
      if (!candidate) {
        throw new EvolutionError('invalid_input', 'The repository is not a candidate from this resolution', {
          repository: input.repository,
        })
      }
      review = await reviewGithubPlugin({
        runner: this.runner,
        config: this.config,
        cwd: resolution.cwd,
        repository: candidate.repository,
        ref: input.ref ?? candidate.defaultBranch ?? 'HEAD',
        resolutionId: resolution.id,
        requirement: resolution.requirement,
        ...(runtimeVersion ? { runtimeVersion } : {}),
        signal: exec.signal,
      })
      qualitySource = {
        repository: review.sourceSnapshot.kind === 'github' ? review.sourceSnapshot.repository : candidate.repository,
        commit: review.sourceSnapshot.kind === 'github' ? review.sourceSnapshot.commit : '',
        localModification: false,
      }
    } else {
      if (!input.path || !input.baseReviewId) throw new EvolutionError('invalid_input', 'path and baseReviewId are required for a local review')
      const prior = await this.store.listReviews(resolution.id)
      const current = authorizationForResolution(resolution, prior)
      if (current.state !== 'modify_review') {
        throw new EvolutionError(
          'invalid_input',
          'A local modification review requires the user to choose improve-this first',
          { state: current.state },
        )
      }
      const base = await this.store.getReview(input.baseReviewId)
      const lineage = [base, ...prior]
      const root = lineageRootReview(base, lineage)
      if (base.resolutionId !== resolution.id || root.resolutionId !== resolution.id || root.sourceSnapshot.kind !== 'github') {
        throw new EvolutionError('invalid_input', 'baseReviewId must belong to a GitHub review lineage on the same resolution')
      }
      const local = await reviewLocalPlugin({
        runner: this.runner,
        config: this.config,
        workspaceRoot: resolution.cwd,
        path: input.path,
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
      review = local.record
      qualitySource = {
        repository: root.sourceSnapshot.repository,
        commit: root.sourceSnapshot.commit,
        localModification: true,
      }
    }
    await this.store.put('reviews', review)
    if (qualitySource) {
      try {
        await this.quality.recordReview(qualitySource, review)
      } catch {
        // Quality reporting is optional and must never change review behavior.
      }
    }
    const waiting = withNextStep(this.waitingConfirmation(resolution, review))
    await this.store.put('resolutions', waiting)
    this.creationGuard.applyReviewAuthorization(exec.agent, waiting.authorization!)
    return {
      ...review,
      authorization: waiting.authorization!,
      ...(waiting.nextStep !== undefined ? { nextStep: waiting.nextStep } : {}),
    }
  }

  async decide(input: DecideInput, exec: ToolRunContext): Promise<ResolutionRecord> {
    const resolution = await this.store.getResolution(input.resolutionId)
    if (resolution.authorization?.state === 'market_required') {
      throw new EvolutionError(
        'invalid_input',
        'Finish marketplace setup and call capability_resolve again before recording a decision',
      )
    }
    const reviews = await this.store.listReviews(resolution.id)
    const current = authorizationForResolution(resolution, reviews)
    const phase = current.state === 'confirmation_required'
      || current.state === 'use_review'
      || current.state === 'modify_review'
      || reviews.length > 0
      || Boolean(input.reviewId)
      ? 'gate2'
      : 'gate1'
    const parsed = resolveDecision({
      userMessage: input.userMessage,
      remotes: resolution.remoteCandidates,
      locals: resolution.localCandidates,
      phase,
      previouslySelected: resolution.selectedRepositories ?? [],
      ...(input.action !== undefined ? { claimedAction: input.action } : {}),
      ...(input.repositories !== undefined ? { claimedRepositories: input.repositories } : {}),
    })

    const chinese = prefersChinese(resolution.requirement)
    if (parsed.searchMore) {
      const authorization: ResolutionAuthorization = {
        state: 'selection_required',
        resolutionId: resolution.id,
        reason: chinese
          ? '你选择继续找插件。请再调用 capability_resolve 做一次远程发现。'
          : 'The user asked to search for plugins. Call capability_resolve again so remote discovery can run.',
      }
      const next = withNextStep({
        ...resolution,
        authorization,
        reasons: [...resolution.reasons, authorization.reason],
      })
      await this.store.put('resolutions', next)
      this.creationGuard.applyReviewAuthorization(exec.agent, authorization)
      return next
    }

    if (parsed.action === 'use_this' || parsed.action === 'modify_this') {
      const review = await this.reviewForDecision(resolution.id, input.reviewId, reviews)
      const selected = resolution.selectedRepositories ?? parsed.selectedRepositories
      const receipt = newDecisionReceipt('gate2', parsed.action, selected, {
        reviewId: review.id,
        reviewIdentity: reviewIdentity(review),
        userMessage: input.userMessage,
      })
      const authorization = authorizationFromDecision(resolution.id, parsed.action, selected, review)
      const next = withNextStep({
        ...resolution,
        authorization,
        selectedRepositories: selected,
        decisions: [...(resolution.decisions ?? []), receipt],
        reasons: [...resolution.reasons, authorization.reason],
      })
      await this.store.put('resolutions', next)
      this.creationGuard.applyReviewAuthorization(exec.agent, authorization)
      return next
    }

    let nextRecord = resolution
    const selected = [...parsed.selectedRepositories]
    for (const repository of selected) {
      if (!nextRecord.remoteCandidates.some((item) => item.repository.toLowerCase() === repository.toLowerCase())) {
        nextRecord = addExplicitCandidate(nextRecord, repository).resolution
      }
    }
    const receipt = newDecisionReceipt('gate1', parsed.action, selected, { userMessage: input.userMessage })
    const authorization = authorizationFromDecision(nextRecord.id, parsed.action, selected)
    const next = withNextStep({
      ...nextRecord,
      authorization,
      selectedRepositories: selected,
      decisions: [...(nextRecord.decisions ?? []), receipt],
      reasons: [...nextRecord.reasons, authorization.reason],
      decision: parsed.action === 'inspect' && selected.length > 0
        ? 'inspect_remote'
        : parsed.action === 'use_local'
          ? 'use_local'
          : nextRecord.decision,
    })
    await this.store.put('resolutions', next)
    this.creationGuard.applyReviewAuthorization(exec.agent, authorization)
    return next
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

  private async ensureInspectFromLastMessage(
    resolution: ResolutionRecord,
    repository: string,
    exec: ToolRunContext,
  ): Promise<ResolutionRecord> {
    const selected = (resolution.selectedRepositories ?? []).map((item) => item.toLowerCase())
    if (selected.includes(repository.toLowerCase())) return resolution
    const userMessage = this.creationGuard.lastUserMessage(exec.agent)
    if (!userMessage) return resolution
    try {
      return await this.decide({ resolutionId: resolution.id, userMessage }, exec)
    } catch {
      return resolution
    }
  }

  private async ensureUseThisFromLastMessage(review: ReviewRecord, exec: ToolRunContext): Promise<void> {
    const resolution = await this.store.getResolution(review.resolutionId)
    try {
      this.creationGuard.assertInstallAuthorized(exec.agent, review, resolution)
      return
    } catch (error) {
      const userMessage = this.creationGuard.lastUserMessage(exec.agent)
      if (!userMessage) throw error
      try {
        await this.decide({
          resolutionId: resolution.id,
          userMessage,
          reviewId: review.id,
        }, exec)
      } catch {
        throw error
      }
      const updated = await this.store.getResolution(review.resolutionId)
      this.creationGuard.assertInstallAuthorized(exec.agent, review, updated)
    }
  }

  private async reviewForDecision(
    resolutionId: string,
    reviewId: string | undefined,
    reviews: readonly ReviewRecord[],
  ): Promise<ReviewRecord> {
    if (reviewId) {
      const review = await this.store.getReview(reviewId)
      if (review.resolutionId !== resolutionId) {
        throw new EvolutionError('invalid_input', 'review_id does not belong to this resolution', { reviewId })
      }
      return review
    }
    const latest = [...reviews].sort((left, right) => left.createdAt.localeCompare(right.createdAt)).at(-1)
    if (!latest) {
      throw new EvolutionError('invalid_input', 'A review is required before use-this or improve-this')
    }
    return latest
  }

  async install(input: InstallInput, exec: ToolRunContext): Promise<InstallationRecord> {
    const review = await this.store.getReview(input.reviewId)
    await this.ensureUseThisFromLastMessage(review, exec)
    const record = await this.installer.install(input, exec)
    try {
      const review = await this.store.getReview(record.reviewId)
      const source = await this.qualitySourceForReview(review)
      if (source) await this.quality.recordInstallation(source, review, record)
    } catch {
      // Quality reporting is optional and must never change install behavior.
    }
    return record
  }

  remove(input: RemoveInput, exec: ToolRunContext): Promise<RemovalResult> {
    return this.remover.remove(input, exec)
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

  private async qualitySourceForReview(review: ReviewRecord): Promise<CommunityQualitySource | undefined> {
    if (review.sourceSnapshot.kind === 'github') {
      return {
        repository: review.sourceSnapshot.repository,
        commit: review.sourceSnapshot.commit,
        localModification: false,
      }
    }
    const base = await this.store.getReview(review.sourceSnapshot.baseReviewId)
    if (base.sourceSnapshot.kind !== 'github') return undefined
    return {
      repository: base.sourceSnapshot.repository,
      commit: base.sourceSnapshot.commit,
      localModification: true,
    }
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
