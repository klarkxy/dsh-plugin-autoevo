import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { RuntimeConfig } from './config.js'
import { POLICY_VERSION, type InstallInput, type InstallationRecord, type RemoveInput, type ResolutionRecord, type ReviewInput, type ReviewRecord } from './contracts.js'
import { EvolutionError, errorMessage } from './errors.js'
import { discoverGithubCandidates } from './github/index.js'
import { PluginInstaller } from './lifecycle/install.js'
import { DshLauncher } from './lifecycle/launcher.js'
import { PluginRemover, type RemovalResult } from './lifecycle/remove.js'
import type { CommandRunner } from './process/runner.js'
import { capabilityQueries } from './resolver/keywords.js'
import { resolveLocalCapabilities } from './resolver/local.js'
import { reviewGithubPlugin, reviewLocalPlugin } from './review/index.js'
import { hashObject } from './state/hashes.js'
import type { StateStore } from './state/store.js'

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
  }
}

function assertRequirement(requirement: string): string {
  const value = requirement.normalize('NFKC').trim()
  if (!value || value.length > 2_000) {
    throw new EvolutionError('invalid_input', 'requirement must contain 1 to 2000 characters')
  }
  return value
}

function githubQueries(requirement: string): string[] {
  const capabilities = capabilityQueries(requirement)
  if (capabilities.length === 0) return []
  return [
    `${capabilities[0]} topic:dsh-plugin`,
    ...capabilities.slice(0, 4).map((query) => `${query} dsh`),
  ]
}

export class CapabilityEvolutionService {
  readonly installer: PluginInstaller
  readonly remover: PluginRemover

  constructor(
    private readonly ctx: Context,
    private readonly config: RuntimeConfig,
    private readonly runner: CommandRunner,
    private readonly store: StateStore,
  ) {
    const launcher = new DshLauncher(runner, config)
    this.installer = new PluginInstaller(ctx, config, store, launcher, (review, signal) => this.revalidate(review, signal))
    this.remover = new PluginRemover(ctx, config, store, launcher)
  }

  async resolve(requirementInput: string, exec: ToolRunContext): Promise<ResolutionRecord> {
    const requirement = assertRequirement(requirementInput)
    const local = await resolveLocalCapabilities(this.ctx, requirement, exec)
    const queries = githubQueries(requirement)
    let remoteCandidates: ResolutionRecord['remoteCandidates'] = []
    const reasons = [...local.reasons]
    if (local.githubShouldRun) {
      try {
        remoteCandidates = await discoverGithubCandidates({
          runner: this.runner,
          config: this.config,
          cwd: local.cwd,
          queries,
          signal: exec.signal,
        })
        reasons.push(remoteCandidates.length > 0
          ? `GitHub discovery returned ${remoteCandidates.length} bounded candidate summaries.`
          : 'GitHub discovery returned no reusable DSH plugin candidates.')
      } catch (error) {
        reasons.push(`GitHub discovery was unavailable: ${errorMessage(error)}`)
      }
    }
    const record: ResolutionRecord = {
      schemaVersion: 1,
      id: newResolutionId(requirement),
      policyVersion: POLICY_VERSION,
      createdAt: new Date().toISOString(),
      requirement,
      cwd: local.cwd,
      decision: !local.githubShouldRun ? 'use_local' : remoteCandidates.length > 0 ? 'inspect_remote' : 'none',
      localCandidates: local.candidates,
      remoteCandidates,
      queries,
      reasons,
    }
    await this.store.put('resolutions', record)
    return record
  }

  async review(input: ReviewInput, exec: ToolRunContext): Promise<ReviewRecord> {
    const resolution = await this.store.getResolution(input.resolutionId)
    let review: ReviewRecord
    if (input.sourceKind === 'github') {
      if (!input.repository) throw new EvolutionError('invalid_input', 'repository is required for a GitHub review')
      const candidate = resolution.remoteCandidates.find((item) => item.repository.toLowerCase() === input.repository?.toLowerCase())
      if (!candidate) {
        throw new EvolutionError('invalid_input', 'The repository is not a candidate from this resolution', { repository: input.repository })
      }
      review = await reviewGithubPlugin({
        runner: this.runner,
        config: this.config,
        cwd: resolution.cwd,
        repository: candidate.repository,
        ref: input.ref ?? candidate.defaultBranch ?? 'HEAD',
        resolutionId: resolution.id,
        requirement: resolution.requirement,
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
      })
      if (local.record.sourceSnapshot.kind !== 'local'
        || local.record.sourceSnapshot.baseCommit.toLowerCase() !== base.sourceSnapshot.commit.toLowerCase()) {
        throw new EvolutionError('review_rejected', 'The local checkout HEAD does not match the reviewed upstream commit')
      }
      review = local.record
    }
    await this.store.put('reviews', review)
    return review
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
          })).record
        }
        return hashObject(materialReviewFacts(current)) === hashObject(materialReviewFacts(review))
      } catch {
        if (attempt === 1) return false
      }
    }
    return false
  }
}

export const _testing = { assertRequirement, githubQueries, materialReviewFacts }
