import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { valid } from 'semver'
import type { RuntimeConfig } from './config.js'
import {
  POLICY_VERSION,
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
import { PluginInstaller } from './lifecycle/install.js'
import { DshLauncher } from './lifecycle/launcher.js'
import { installMarketplace } from './lifecycle/marketplace.js'
import { PluginRemover, type RemovalResult } from './lifecycle/remove.js'
import type { CommandRunner } from './process/runner.js'
import { resolveLocalCapabilities } from './resolver/local.js'
import { reviewGithubPlugin, reviewLocalPlugin } from './review/index.js'
import { hashObject } from './state/hashes.js'
import type { StateStore } from './state/store.js'

function prefersChinese(text: string): boolean {
  return /[\p{Script=Han}]/u.test(text)
}

export function adoptGithubCandidate(
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
  const reason = prefersChinese(resolution.requirement)
    ? `已把 ${repository} 纳入审查。先看现成插件怎么写，不要直接自建。`
    : `Adopted ${repository} for review. Inspect the existing plugin before creating one.`
  const authorization: ResolutionAuthorization = {
    state: 'review_required',
    resolutionId: resolution.id,
    reason,
  }
  return {
    candidate,
    resolution: {
      ...resolution,
      decision: 'inspect_remote',
      remoteCandidates: [...resolution.remoteCandidates, candidate],
      remoteCandidateSource: resolution.remoteCandidateSource === 'marketplace-setup' || !resolution.remoteCandidateSource
        ? 'github'
        : resolution.remoteCandidateSource,
      authorization,
      reasons: [...resolution.reasons, reason],
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

function initialAuthorization(
  resolutionId: string,
  decision: ResolutionRecord['decision'],
  remoteDiscoveryComplete: boolean,
  remoteCandidateSource?: ResolutionRecord['remoteCandidateSource'],
): ResolutionAuthorization {
  if (decision === 'use_local') {
    return { state: 'reuse_required', resolutionId, reason: 'A sufficiently relevant local capability is already available.' }
  }
  if (decision === 'inspect_remote' && remoteCandidateSource === 'marketplace-setup') {
    return {
      state: 'market_required',
      resolutionId,
      reason: 'The DSH plugin marketplace (dsh-find-plugin) must finish installing and loading before capability search. Restart is required only when current-process loading fails. It is infrastructure, not the requested capability.',
    }
  }
  if (decision === 'inspect_remote') {
    return { state: 'review_required', resolutionId, reason: 'Review every discovered candidate before scratch development.' }
  }
  return remoteDiscoveryComplete
    ? { state: 'scratch_ready', resolutionId, reason: 'Local and remote discovery completed without a reusable candidate; one new Cordis Plugin may be defined.' }
    : { state: 'review_required', resolutionId, reason: 'Remote discovery did not complete; retry capability_resolve before scratch development.' }
}

function authorizationForResolution(
  resolution: ResolutionRecord,
  reviews: readonly ReviewRecord[],
): ResolutionAuthorization {
  const legacy = resolution.schemaVersion !== 2 || resolution.policyVersion !== POLICY_VERSION || !resolution.authorization
  if (legacy) {
    return {
      state: 'review_required',
      resolutionId: resolution.id,
      reason: 'This resolution predates the current fail-closed policy; run capability_resolve again.',
    }
  }
  if (resolution.decision === 'use_local') return resolution.authorization!
  if (resolution.decision === 'none') return resolution.authorization!

  const marketplaceSetup = resolution.remoteCandidateSource === 'marketplace-setup'
  const latestForCandidate = resolution.remoteCandidates.map((candidate) => {
    const roots = reviews.filter((review) => review.sourceSnapshot.kind === 'github'
      && review.sourceSnapshot.repository.toLowerCase() === candidate.repository.toLowerCase())
    const lineage = roots.flatMap((root) => [
      root,
      ...reviews.filter((review) => review.sourceSnapshot.kind === 'local'
        && review.sourceSnapshot.baseReviewId === root.id),
    ])
    return lineage.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))[0]
  })

  if (latestForCandidate.some((review) => review?.recommendation === 'use')) {
    return {
      state: 'reuse_required',
      resolutionId: resolution.id,
      reason: marketplaceSetup
        ? 'Install the reviewed DSH plugin marketplace, restart DSH, then call capability_resolve again.'
        : 'At least one reviewed candidate is a complete reusable fit.',
    }
  }
  if (latestForCandidate.some((review) => review?.recommendation === 'modify')) {
    return {
      state: 'modify_required',
      resolutionId: resolution.id,
      reason: 'At least one reviewed candidate can be improved instead of replaced.',
    }
  }
  if (latestForCandidate.some((review) => review === undefined)) {
    return {
      state: marketplaceSetup ? 'market_required' : 'review_required',
      resolutionId: resolution.id,
      reason: marketplaceSetup
        ? 'Install the DSH plugin marketplace (awesome-dsh-plugin/dsh-find-plugin) first, or skip it only if the user declines. Direct GitHub search is not used as a fallback.'
        : 'Every discovered candidate must reach a terminal review before scratch development.',
    }
  }
  return {
    state: 'scratch_ready',
    resolutionId: resolution.id,
    reason: marketplaceSetup
      ? 'The user declined the plugin marketplace; one new Cordis Plugin may be defined.'
      : 'Every discovered candidate was reviewed and rejected; one new Cordis Plugin may be defined.',
  }
}

export class CapabilityEvolutionService {
  readonly installer: PluginInstaller
  readonly remover: PluginRemover
  private readonly launcher: DshLauncher

  constructor(
    private readonly ctx: Context,
    private readonly config: RuntimeConfig,
    private readonly runner: CommandRunner,
    private readonly store: StateStore,
    private readonly creationGuard: CreationGuard,
  ) {
    this.launcher = new DshLauncher(runner, config)
    this.installer = new PluginInstaller(ctx, config, store, this.launcher, (review, signal) => this.revalidate(review, signal))
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
    const reasons = [...local.reasons]
    if (local.githubShouldRun) {
      const discovery = await discoverRemoteCandidates({
        ctx: this.ctx,
        config: this.config,
        runner: this.runner,
        cwd: local.cwd,
        requirement,
        exec,
      })
      remoteCandidates = discovery.candidates
      remoteCandidateSource = discovery.source
      remoteDiscoveryComplete = discovery.complete
      queries = discovery.queries
      reasons.push(...discovery.reasons)
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
          })
          remoteCandidates = again.candidates
          remoteCandidateSource = again.source
          remoteDiscoveryComplete = again.complete
          queries = [...queries, ...again.queries]
          reasons.push(...again.reasons)
        }
      }
    }
    const decision: ResolutionRecord['decision'] = !local.githubShouldRun
      ? 'use_local'
      : remoteCandidateSource === 'marketplace-setup' || remoteCandidates.length > 0
        ? 'inspect_remote'
        : 'none'
    const id = newResolutionId(requirement)
    const authorization = initialAuthorization(id, decision, remoteDiscoveryComplete, remoteCandidateSource)
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
      authorization,
      queries,
      reasons,
    }
    await this.store.put('resolutions', record)
    this.creationGuard.applyResolutionAuthorization(exec.agent, authorization, guardGeneration)
    return record
  }

  async review(input: ReviewInput, exec: ToolRunContext): Promise<ReviewResult> {
    let resolution = await this.store.getResolution(input.resolutionId)
    const runtimeVersion = await this.dshRuntimeVersion(resolution.cwd, exec.signal)
    let review: ReviewRecord
    if (input.sourceKind === 'github') {
      if (!input.repository) throw new EvolutionError('invalid_input', 'repository is required for a GitHub review')
      let candidate = resolution.remoteCandidates.find((item) => item.repository.toLowerCase() === input.repository?.toLowerCase())
      if (!candidate) {
        const adopted = adoptGithubCandidate(resolution, input.repository)
        resolution = adopted.resolution
        candidate = adopted.candidate
        await this.store.put('resolutions', resolution)
        this.creationGuard.applyReviewAuthorization(exec.agent, resolution.authorization!)
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
    } else {
      if (!input.path || !input.baseReviewId) throw new EvolutionError('invalid_input', 'path and baseReviewId are required for a local review')
      const base = await this.store.getReview(input.baseReviewId)
      if (base.resolutionId !== resolution.id || base.sourceSnapshot.kind !== 'github') {
        throw new EvolutionError('invalid_input', 'baseReviewId must be a GitHub review for the same resolution')
      }
      const local = await reviewLocalPlugin({
        runner: this.runner,
        config: this.config,
        workspaceRoot: resolution.cwd,
        path: input.path,
        baseReviewId: base.id,
        resolutionId: resolution.id,
        requirement: resolution.requirement,
        ...(runtimeVersion ? { runtimeVersion } : {}),
      })
      if (local.record.sourceSnapshot.kind !== 'local'
        || local.record.sourceSnapshot.baseCommit.toLowerCase() !== base.sourceSnapshot.commit.toLowerCase()) {
        throw new EvolutionError('review_rejected', 'The local checkout HEAD does not match the reviewed upstream commit')
      }
      review = local.record
    }
    await this.store.put('reviews', review)
    const authorization = authorizationForResolution(resolution, await this.store.listReviews(resolution.id))
    this.creationGuard.applyReviewAuthorization(exec.agent, authorization)
    return { ...review, authorization }
  }

  install(input: InstallInput, exec: ToolRunContext): Promise<InstallationRecord> {
    return this.installer.install(input, exec)
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
          current = (await reviewLocalPlugin({
            runner: this.runner,
            config: this.config,
            workspaceRoot: resolution.cwd,
            path: review.sourceSnapshot.path,
            baseReviewId: review.sourceSnapshot.baseReviewId,
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
  adoptGithubCandidate,
  assertRequirement,
  authorizationForResolution,
  initialAuthorization,
  materialReviewFacts,
}
