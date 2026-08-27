import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { RuntimeConfig } from './config.js'
import {
  DEFAULT_REQUEST_INTENT,
  POLICY_VERSION,
  type AdoptInput,
  type EvolutionTarget,
  type InstallationRecord,
  type NavigationInput,
  type RemoveInput,
  type RequestIntent,
  type ResolutionAuthorization,
  type ResolutionRecord,
  type ResumeInput,
  type ReviewMode,
  type ReviewRecord,
  type RollbackInput,
  type VersionsInput,
} from './contracts.js'
import type { CreationGuard } from './creation-guard.js'
import {
  createCreatorFoundation,
  type CreatorFoundation,
} from './creator-foundation.js'
import { discoverRemoteCandidates } from './discovery/remote.js'
import { EvolutionError } from './errors.js'
import { validateGithubRepository } from './github/index.js'
import {
  authorizationFromDecision,
  newDecisionReceipt,
  reviewIdentity,
} from './lifecycle/decide.js'
import { sessionCwd } from './host-identity.js'
import { prefersChinese } from './i18n.js'
import { PluginInstaller } from './lifecycle/install.js'
import { DshLauncher } from './lifecycle/launcher.js'
import { PluginRemover, type RemovalResult } from './lifecycle/remove.js'
import type { ManagedChildHost } from './managed-child.js'
import type { CommandRunner } from './process/runner.js'
import { applyIntentToCandidate } from './resolver/intent.js'
import {
  isFailedSameSpecification,
  lineageCandidateFromRecords,
  managedSnapshotRootReview,
  mergeLineageCandidate,
  shouldSkipRemoteDiscovery,
} from './resolver/lineage.js'
import { resolveLocalCapabilities } from './resolver/local.js'
import { resolveBundledDshRoot } from './resolver/host-bundled.js'
import { builtinMountPresent, builtinReceiptSpec, enableBuiltinMount, parseBuiltinReceiptSpec } from './lifecycle/enable-builtin.js'
import { resolveCurrentProfileOwner } from './resolver/profile.js'
import {
  assertDirectUseAllowed,
  isDirectlyUsableReview,
  reviewGithubPluginWithFiles,
  reviewLocalPlugin,
} from './review/index.js'
import { reviewCandidateDigest, reviewSnapshotDigest } from './review/direct-use.js'
import type { ContentFile } from './review/review.js'
import {
  childCheckEvidence,
  modificationAcceptance,
  modificationBlockers,
  modificationDelta,
  modificationWorkOrder,
} from './service-modification.js'
import {
  finishManagedWork,
  prepareManagedCreation,
  prepareManagedModification,
  type ManagedWorkDeps,
} from './service-managed-work.js'
import {
  addExplicitCandidate,
  assertRequirement,
  authorizationForResolution,
  newResolutionId,
  waitingAuthorization,
  waitingConfirmation,
  withNextStep,
} from './service-resolution.js'
import {
  dshRuntimeVersion,
  lineageRootReview,
  materialReviewFacts,
  revalidateReview,
  reviewAndFreezeManagedSource,
  shouldReviewAdaptiveThird,
} from './service-review.js'
import {
  assertSemanticReviewerBinding,
  attachSemanticReview,
  boundedReviewerFiles,
} from './service-semantic-review.js'
import type { SemanticReviewerHost } from './semantic-reviewer.js'
import type { SemanticVerifierHost } from './semantic-verifier.js'
import { SourceManager } from './source-manager.js'
import { hashObject } from './state/hashes.js'
import type { StateStore } from './state/store.js'
import {
  adoptInstallation,
  scanOrphanedInstallations,
  type AdoptDeps,
  type OrphanScan,
} from './service-adopt.js'
import {
  checkCapabilityUpdates,
  type CapabilityUpdateReport,
  type UpdateTrackingDeps,
} from './service-updates.js'
import {
  listCapabilityVersions,
  rollbackInstallation,
  type CapabilityVersionList,
  type VersionTrackingDeps,
} from './service-versions.js'
import { runInWorkspace } from './workspace-layout.js'
import { WorkflowEngine } from './workflow/engine.js'
import type {
  MarketplaceStepResult,
  DiscoveryPresentInput,
  DiscoveryRefineInput,
  ValidatedResume,
  WorkflowDiagnoseInput,
  WorkflowExec,
  WorkflowHost,
  WorkflowPendingInstall,
  WorkflowRecord,
  WorkflowRecoveryInput,
  WorkflowView,
} from './workflow/contracts.js'

export { addExplicitCandidate } from './service-resolution.js'
export { lineageRootReview } from './service-review.js'
export { reviewCandidateDigest, reviewSnapshotDigest } from './review/direct-use.js'
export {
  assertSemanticReviewerBinding,
  attachSemanticReview,
  boundedReviewerFiles,
} from './service-semantic-review.js'

function asToolExec(exec: WorkflowExec): ToolRunContext {
  return exec as ToolRunContext
}

const profileMutationTails = new Map<string, Promise<void>>()

async function serializeProfileMutation<T>(dshHome: string, profile: string, operation: () => Promise<T>): Promise<T> {
  const key = `${path.resolve(dshHome).toLowerCase()}\u0000${profile.toLowerCase()}`
  const predecessor = profileMutationTails.get(key) ?? Promise.resolve()
  let release!: () => void
  const turn = new Promise<void>((resolve) => { release = resolve })
  const tail = predecessor.catch(() => undefined).then(() => turn)
  profileMutationTails.set(key, tail)
  await predecessor.catch(() => undefined)
  try {
    return await operation()
  } finally {
    release()
    if (profileMutationTails.get(key) === tail) profileMutationTails.delete(key)
  }
}

export class CapabilityEvolutionService implements WorkflowHost {
  readonly installer: PluginInstaller
  readonly remover: PluginRemover
  readonly sources: SourceManager
  private readonly launcher: DshLauncher
  private readonly engine: WorkflowEngine
  private readonly creatorFoundation: CreatorFoundation

  constructor(
    private readonly ctx: Context,
    private readonly config: RuntimeConfig,
    private readonly runner: CommandRunner,
    private readonly store: StateStore,
    private readonly creationGuard: CreationGuard,
    _managedChild?: ManagedChildHost,
    _semanticReviewer?: SemanticReviewerHost,
    _semanticVerifier?: SemanticVerifierHost,
    creatorFoundation?: CreatorFoundation,
  ) {
    this.launcher = new DshLauncher(runner, config)
    this.sources = new SourceManager(config, runner)
    this.creatorFoundation = creatorFoundation ?? createCreatorFoundation(ctx)
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
      undefined,
      undefined,
      () => this.currentProfileOwner(),
    )
    this.remover = new PluginRemover(ctx, config, store, this.launcher, () => this.currentProfileOwner())
    this.engine = new WorkflowEngine(store, creationGuard, this, true)
  }

  private managedWorkDeps(): ManagedWorkDeps {
    return {
      runner: this.runner,
      config: this.config,
      launcher: this.launcher,
      store: this.store,
      sources: this.sources,
      creatorFoundation: this.creatorFoundation,
    }
  }

  private withWorkspace<T>(exec: { agent?: ToolRunContext['agent'] }, fn: () => T): T {
    return runInWorkspace(sessionCwd(exec.agent), fn)
  }

  start(
    requirement: string,
    exec: ToolRunContext,
    intent: RequestIntent = DEFAULT_REQUEST_INTENT,
    clarificationQuestion?: string,
  ): Promise<WorkflowView> {
    return this.withWorkspace(exec, () => this.engine.start(requirement, exec, intent, clarificationQuestion))
  }

  resume(input: ResumeInput, exec: ToolRunContext): Promise<WorkflowView> {
    return this.withWorkspace(exec, () => this.engine.resume(input, exec))
  }

  refine(input: DiscoveryRefineInput, exec: ToolRunContext): Promise<WorkflowView> {
    return this.withWorkspace(exec, () => this.engine.refine(input, exec))
  }

  present(input: DiscoveryPresentInput, exec: ToolRunContext): Promise<WorkflowView> {
    return this.withWorkspace(exec, () => this.engine.present(input, exec))
  }

  diagnose(input: WorkflowDiagnoseInput, exec: ToolRunContext): Promise<WorkflowView> {
    return this.withWorkspace(exec, () => this.engine.diagnose(input, exec))
  }

  recover(input: WorkflowRecoveryInput, exec: ToolRunContext): Promise<WorkflowView> {
    return this.withWorkspace(exec, () => this.engine.recover(input, exec))
  }

  async remove(input: RemoveInput, exec: ToolRunContext): Promise<RemovalResult> {
    return this.withWorkspace(exec, async () => {
      const record = await this.store.getInstallation(input.installationId)
      return serializeProfileMutation(record.dshHome, record.targetProfile, () => this.remover.remove(input, exec))
    })
  }

  listVersions(input: VersionsInput): Promise<CapabilityVersionList> {
    return listCapabilityVersions(this.versionTrackingDeps(), input)
  }

  async rollback(input: RollbackInput, exec: ToolRunContext): Promise<InstallationRecord> {
    return this.withWorkspace(exec, async () => {
      const record = await this.store.getInstallation(input.installationId)
      return serializeProfileMutation(record.dshHome, record.targetProfile, () =>
        rollbackInstallation(this.versionTrackingDeps(), input, exec))
    })
  }

  scanOrphans(): Promise<OrphanScan> {
    return scanOrphanedInstallations(this.adoptDeps())
  }

  async adopt(input: AdoptInput): Promise<InstallationRecord> {
    const profile = await this.currentProfileOwner()
    return serializeProfileMutation(this.config.dshHome, profile, () =>
      adoptInstallation({ ...this.adoptDeps(), currentProfile: async () => profile }, input))
  }

  checkUpdates(exec: ToolRunContext): Promise<CapabilityUpdateReport> {
    const deps: UpdateTrackingDeps = {
      store: this.store,
      config: this.config,
      runner: this.runner,
      cwd: sessionCwd(exec.agent) ?? process.cwd(),
    }
    return checkCapabilityUpdates(deps, { ...(exec.signal ? { signal: exec.signal } : {}) })
  }

  private adoptDeps(): AdoptDeps {
    return {
      store: this.store,
      config: this.config,
      currentProfile: () => this.currentProfileOwner(),
    }
  }

  private versionTrackingDeps(): VersionTrackingDeps {
    return {
      store: this.store,
      config: this.config,
      launcher: this.launcher,
      // No workflow-commitment authorizer: rollback is not bound to a capability
      // workflow, but the installer still requests one-time user approval.
      createRollbackInstaller: () => new PluginInstaller(
        this.ctx,
        this.config,
        this.store,
        this.launcher,
        (review, signal) => this.revalidate(review, signal),
        undefined,
        undefined,
        undefined,
        undefined,
        () => this.currentProfileOwner(),
      ),
    }
  }

  async cleanupInstallation(installationId: string, exec: WorkflowExec): Promise<RemovalResult> {
    return this.withWorkspace(exec, async () => {
      const record = await this.store.getInstallation(installationId)
      return serializeProfileMutation(record.dshHome, record.targetProfile, () =>
        this.remover.remove({ installationId }, asToolExec(exec)))
    })
  }

  async bootstrapResolution(requirementInput: string, exec: WorkflowExec, intent: RequestIntent = DEFAULT_REQUEST_INTENT): Promise<ResolutionRecord> {
    const requirement = assertRequirement(requirementInput)
    const activeProfile = await this.currentProfileOwner().catch(() => undefined)
    const dshPackageRoot = await resolveBundledDshRoot({
      dshHome: this.config.dshHome,
      config: this.config,
      runner: this.runner,
      ...(exec.signal ? { signal: exec.signal } : {}),
    }).catch(() => undefined)
    const local = await resolveLocalCapabilities(this.ctx, requirement, asToolExec(exec), {
      dshHome: this.config.dshHome,
      intent,
      ...(activeProfile ? { activeProfile } : {}),
      ...(dshPackageRoot ? { dshPackageRoot } : {}),
    })
    const [reviews, installations] = await Promise.all([
      this.store.listAllReviews(),
      this.store.listInstallations(),
    ])
    const reviewById = new Map(reviews.map((item) => [item.id, item]))
    const managedReviewIds: string[] = []
    for (const review of reviews) {
      if (review.sourceSnapshot.kind !== 'local' || !review.installSpec) continue
      const root = managedSnapshotRootReview(review, reviewById)
      const completed = await this.sources.validateCompletedSnapshot({
        path: review.sourceSnapshot.path,
        reviewId: review.id,
        repository: root?.sourceSnapshot.kind === 'github' ? root.sourceSnapshot.repository : null,
        baseCommit: root?.sourceSnapshot.kind === 'github'
          ? root.sourceSnapshot.commit
          : review.sourceSnapshot.baseCommit,
        workspaceCwd: local.cwd,
        ...(exec.signal ? { signal: exec.signal } : {}),
      }).catch(() => undefined)
      if (completed) managedReviewIds.push(review.id)
    }
    const lineage = lineageCandidateFromRecords({
      requirement,
      intent,
      reviews,
      installations,
      managedReviewIds,
      ...(activeProfile ? { profile: activeProfile } : {}),
    })
    const candidates = mergeLineageCandidate(local.candidates, lineage)
      .map((item) => applyIntentToCandidate(item, intent))
    const skipRemote = shouldSkipRemoteDiscovery(candidates, intent)
    const decision: ResolutionRecord['decision'] = skipRemote ? 'use_local' : 'none'
    const id = newResolutionId(requirement)
    const authorization = waitingAuthorization(id, decision, skipRemote)
    const record: ResolutionRecord = {
      schemaVersion: 2,
      id,
      policyVersion: POLICY_VERSION,
      createdAt: new Date().toISOString(),
      requirement,
      cwd: local.cwd,
      decision,
      localCandidates: candidates,
      remoteCandidates: [],
      remoteDiscoveryComplete: skipRemote,
      authorization,
      queries: [],
      reasons: skipRemote && lineage
        ? [...local.reasons, 'Host found a previously reviewed exact GitHub source; remote search was skipped.']
        : [...local.reasons],
      intent,
    }
    const waiting = withNextStep(record)
    await this.store.put('resolutions', waiting)
    return waiting
  }

  async discoverRemote(resolution: ResolutionRecord, exec: WorkflowExec): Promise<ResolutionRecord> {
    const discovery = await discoverRemoteCandidates({
      runner: this.runner,
      config: this.config,
      cwd: resolution.cwd,
      requirement: resolution.requirement,
      ...(exec.signal ? { signal: exec.signal } : {}),
    })
    const decision: ResolutionRecord['decision'] = discovery.candidates.length > 0
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
          runner: this.runner,
          config: this.config,
          cwd: resolution.cwd,
          requirement: resolution.requirement,
          queries: input.queries,
          ...(exec.signal ? { signal: exec.signal } : {}),
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
    const rediscovered = await this.discoverRemote(resolution, exec)
    return {
      resolution: rediscovered,
      market: {
        status: 'empty',
        reason: prefersChinese(resolution.requirement)
          ? '远端发现改走 Host 侧 GitHub topic 搜索，不再安装市场插件。'
          : 'Remote discovery now uses Host-owned GitHub topic search and no longer installs a marketplace plugin.',
      },
    }
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
    const runtimeVersion = await dshRuntimeVersion(this.managedWorkDeps(), resolution.cwd, exec.signal)
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
    const waiting = withNextStep(waitingConfirmation(resolution, review, workflow))
    await this.store.put('resolutions', waiting)
    return { resolution: waiting, review }
  }

  async reviewExisting(
    resolution: ResolutionRecord,
    target: EvolutionTarget,
    exec: WorkflowExec,
    workflow?: WorkflowRecord,
  ): Promise<{ resolution: ResolutionRecord; review: ReviewRecord }> {
    const expected = workflow?.candidateSnapshot
      ?.find((item) => item.id === workflow.pendingReviewedCandidateId)
      ?.evolutionTarget
    if (!expected || hashObject(expected) !== hashObject(target)) {
      throw new EvolutionError('invalid_input', 'Installed-source review must use the frozen Host evolution target')
    }
    if (target.kind === 'managed_local') {
      const priorReview = target.reviewId
        ? await this.store.getReview(target.reviewId).catch(() => undefined)
        : undefined
      if (!workflow || priorReview?.sourceSnapshot.kind !== 'local' || !target.sourceId) {
        throw new EvolutionError('review_rejected', 'Managed local review is missing its completed Host source')
      }
      const receipt = await this.sources.validateCompletedSnapshot({
        path: priorReview.sourceSnapshot.path,
        reviewId: priorReview.id,
        repository: null,
        baseCommit: target.commit,
        workspaceCwd: resolution.cwd,
        ...(exec.signal ? { signal: exec.signal } : {}),
      })
      if (!receipt
        || receipt.sourceId !== target.sourceId
        || priorReview.sourceSnapshot.baseCommit.toLowerCase() !== target.commit.toLowerCase()
        || priorReview.installSpec !== target.dependencySpec
        || priorReview.manifest.packageName !== target.packageName) {
        throw new EvolutionError('review_rejected', 'Managed local capability failed frozen provenance validation')
      }
      await this.sources.claimCompletedSourceForWorkflow(target.sourceId, workflow.id, exec.signal)
      workflow.managedSourceId = target.sourceId
      workflow.updatedAt = new Date().toISOString()
      await this.store.put('workflows', workflow)
      try {
        return await reviewAndFreezeManagedSource(this.managedWorkDeps(), {
          resolution,
          sourceId: target.sourceId,
          path: receipt.path,
          baseReviewId: priorReview.id,
          lineageRootCommit: target.commit,
          workflowId: workflow.id,
          exec,
        })
      } catch (error) {
        await this.sources.completeWorkflow(target.sourceId, workflow.id, exec.signal).catch(() => undefined)
        throw error
      }
    }
    validateGithubRepository(target.repository)
    if (target.kind === 'reviewed_snapshot' || target.kind === 'failed_install') {
      const priorReview = target.reviewId
        ? await this.store.getReview(target.reviewId).catch(() => undefined)
        : undefined
      if (priorReview?.sourceSnapshot.kind === 'local') {
        if (!workflow) {
          throw new EvolutionError('invalid_input', 'Managed snapshot review requires an active workflow')
        }
        const allReviews = await this.store.listAllReviews()
        const root = managedSnapshotRootReview(priorReview, new Map(allReviews.map((item) => [item.id, item])))
        const sourceId = target.sourceId
        if (!root || root.sourceSnapshot.kind !== 'github') {
          throw new EvolutionError('review_rejected', 'Managed repair snapshot has an invalid historical GitHub lineage')
        }
        const receipt = await this.sources.validateCompletedSnapshot({
          path: priorReview.sourceSnapshot.path,
          reviewId: priorReview.id,
          repository: target.repository,
          baseCommit: target.commit,
          workspaceCwd: resolution.cwd,
          ...(exec.signal ? { signal: exec.signal } : {}),
        })
        if (root.sourceSnapshot.repository.toLowerCase() !== target.repository.toLowerCase()
          || root.sourceSnapshot.commit.toLowerCase() !== target.commit.toLowerCase()
          || priorReview.sourceSnapshot.baseCommit.toLowerCase() !== target.commit.toLowerCase()
          || priorReview.installSpec !== target.dependencySpec
          || priorReview.manifest.packageName !== target.packageName
          || !sourceId
          || receipt?.sourceId !== sourceId
          || !receipt) {
          throw new EvolutionError('review_rejected', 'Managed repair snapshot failed frozen lineage and provenance validation')
        }
        const selected = [...new Set([...(resolution.selectedRepositories ?? []), target.repository])]
        const selectedResolution = { ...resolution, selectedRepositories: selected }
        const runtimeVersion = await dshRuntimeVersion(this.managedWorkDeps(), resolution.cwd, exec.signal)
        const upstreamEvidence = await reviewGithubPluginWithFiles({
          runner: this.runner,
          // This immutable upstream snapshot is a lineage anchor only. The
          // managed repair itself is reviewed in full immediately below.
          config: {
            ...this.config,
            maxFiles: Math.min(this.config.maxFiles, 8),
            maxRepositoryBytes: Math.min(this.config.maxRepositoryBytes, 262_144),
          },
          cwd: resolution.cwd,
          repository: target.repository,
          ref: target.commit,
          resolutionId: resolution.id,
          requirement: resolution.requirement,
          ...(runtimeVersion ? { runtimeVersion } : {}),
          ...(exec.signal ? { signal: exec.signal } : {}),
        })
        if (upstreamEvidence.record.sourceSnapshot.kind !== 'github'
          || upstreamEvidence.record.sourceSnapshot.commit.toLowerCase() !== target.commit.toLowerCase()
          || (upstreamEvidence.record.manifest.packageName
            && upstreamEvidence.record.manifest.packageName !== target.packageName)) {
          throw new EvolutionError('review_rejected', 'Fresh upstream review does not match the frozen managed repair root')
        }
        const upstreamReview = await this.persistReviewed(upstreamEvidence.record, upstreamEvidence.files, exec, workflow)
        await this.sources.claimCompletedSourceForWorkflow(sourceId, workflow.id, exec.signal)
        workflow.managedSourceId = sourceId
        workflow.updatedAt = new Date().toISOString()
        await this.store.put('workflows', workflow)
        try {
          return await reviewAndFreezeManagedSource(this.managedWorkDeps(), {
            resolution: selectedResolution,
            sourceId,
            path: receipt.path,
            baseReviewId: upstreamReview.id,
            lineageRootCommit: target.commit,
            workflowId: workflow.id,
            exec,
          })
        } catch (error) {
          await this.sources.completeWorkflow(sourceId, workflow.id, exec.signal).catch(() => undefined)
          throw error
        }
      }
    }
    const runtimeVersion = await dshRuntimeVersion(this.managedWorkDeps(), resolution.cwd, exec.signal)
    const evidence = await reviewGithubPluginWithFiles({
      runner: this.runner,
      config: this.config,
      cwd: resolution.cwd,
      repository: target.repository,
      ref: target.commit,
      resolutionId: resolution.id,
      requirement: resolution.requirement,
      ...(runtimeVersion ? { runtimeVersion } : {}),
      ...(exec.signal ? { signal: exec.signal } : {}),
    })
    if (evidence.record.manifest.packageName && evidence.record.manifest.packageName !== target.packageName) {
      throw new EvolutionError('invalid_input', 'Reviewed package name does not match the frozen installed package')
    }
    const review = await this.persistReviewed(evidence.record, evidence.files, exec, workflow)
    const selected = [...new Set([...(resolution.selectedRepositories ?? []), target.repository])]
    const waiting = withNextStep(waitingConfirmation({ ...resolution, selectedRepositories: selected }, review, workflow))
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
    const runtimeVersion = await dshRuntimeVersion(this.managedWorkDeps(), resolution.cwd, exec.signal)
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
      ? withNextStep(waitingConfirmation({ ...resolution, selectedRepositories: ordered }, primary, workflow))
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
    const runtimeVersion = await dshRuntimeVersion(this.managedWorkDeps(), resolution.cwd, exec.signal)
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
    const waiting = withNextStep(waitingConfirmation(resolution, review, workflow))
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
    const record = await serializeProfileMutation(
      input.retention === 'persistent' ? this.config.dshHome : this.store.root,
      input.targetProfile,
      () => this.installer.install({
        ...(workflow?.pendingInstallationId ? { installationId: workflow.pendingInstallationId } : {}),
        reviewId: review.id,
        targetProfile: input.targetProfile,
        retention: input.retention,
        ...(input.verificationTask !== undefined ? { verificationTask: input.verificationTask } : {}),
        ...(input.verificationExpectedText !== undefined ? { verificationExpectedText: input.verificationExpectedText } : {}),
        ...(provenance?.artifactHash ? { expectedArtifactSha256: provenance.artifactHash } : {}),
        ...(input.replacement ? { replacement: input.replacement } : {}),
      }, asToolExec(exec), {
        ...(workflow ? { workflow } : {}),
        ...(workflow?.actionCommitment ? { commitment: workflow.actionCommitment } : {}),
        ...(workflow?.selectionReceipt ? { receipt: workflow.selectionReceipt } : {}),
        ...(input.retention ? { retention: input.retention } : {}),
      }),
    )
    return record
  }

  private revalidate(review: ReviewRecord, signal?: AbortSignal): Promise<boolean> {
    return revalidateReview(this.managedWorkDeps(), review, signal)
  }

  async prepareModify(
    resolution: ResolutionRecord,
    review: ReviewRecord,
    exec: WorkflowExec,
    workflow: WorkflowRecord,
  ): Promise<{ resolution: ResolutionRecord; path?: string; review?: ReviewRecord }> {
    return prepareManagedModification(this.managedWorkDeps(), resolution, review, exec, workflow)
  }

  async prepareCreate(
    resolution: ResolutionRecord,
    exec: WorkflowExec,
    workflow: WorkflowRecord,
  ): Promise<{ resolution: ResolutionRecord; path?: string; review?: ReviewRecord }> {
    return prepareManagedCreation(this.managedWorkDeps(), resolution, exec, workflow)
  }

  async finishManagedWork(
    resolution: ResolutionRecord,
    exec: WorkflowExec,
    workflow: WorkflowRecord,
  ): Promise<{ resolution: ResolutionRecord; path?: string; review?: ReviewRecord; continueConstruction?: boolean }> {
    return finishManagedWork(this.managedWorkDeps(), resolution, exec, workflow)
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
        'This older receipt is still parked on marketplace setup. Call capability_workflow again before recording a decision',
      )
    }
    if (resume.optionId === 'use_this' && (!review || !isDirectlyUsableReview(review, workflow))) {
      throw new EvolutionError('review_rejected', 'The selected review is not directly installable', {
        reviewId: review?.id,
      })
    }
    const failedTarget = workflow?.candidateSnapshot?.find((item) => item.id === resume.candidateId)?.evolutionTarget
      ?? workflow?.candidateSnapshot?.find((item) => item.evolutionTarget)?.evolutionTarget
    if (resume.optionId === 'use_this' && isFailedSameSpecification(failedTarget, review?.installSpec)) {
      throw new EvolutionError(
        'invalid_input',
        'Host will not reinstall the failed specification; improve the reviewed source first',
      )
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

  async findInstallationForWorkflow(workflowId: string): Promise<InstallationRecord | undefined> {
    return this.store.findInstallationForWorkflow(workflowId)
  }

  listInstallProfiles(): Promise<string[]> {
    return this.currentProfileOwner().then((profile) => [profile])
  }

  managedWorkAvailable(exec: WorkflowExec): boolean {
    return this.creationGuard.isManagedWorkAvailable(exec.agent)
  }

  enableTargetProfile(): Promise<string | undefined> {
    return this.currentProfileOwner().catch(() => undefined)
  }

  async enableBuiltin(workflow: WorkflowRecord, exec: WorkflowExec): Promise<InstallationRecord> {
    const commitment = workflow.actionCommitment
    const endpoint = commitment?.endpoint
    if (!commitment || commitment.requestedAction !== 'enable_builtin' || endpoint?.kind !== 'host_bundled_enable') {
      throw new EvolutionError('invalid_input', 'enable_builtin requires a frozen host-bundled enablement commitment')
    }
    const bundledRoot = await resolveBundledDshRoot({
      dshHome: this.config.dshHome,
      config: this.config,
      runner: this.runner,
      ...(exec.signal ? { signal: exec.signal } : {}),
    }).catch(() => undefined)
    if (!bundledRoot) {
      throw new EvolutionError('command_failed', 'The Host dsh package root is unavailable; cannot revalidate the built-in capability', {
        command: this.config.dshCommand,
      })
    }
    return await serializeProfileMutation(this.config.dshHome, endpoint.targetProfile, async () => {
      const createdAt = new Date().toISOString()
      const installationId = workflow.pendingInstallationId
        ?? `installation_${hashObject({ workflowId: workflow.id, endpoint, createdAt, nonce: randomUUID() }).slice(0, 24)}`
      let provisional = await this.store.getInstallation(installationId).catch((error: unknown) => {
        if (error instanceof EvolutionError && error.code === 'not_found') return undefined
        throw error
      })
      if (provisional) {
        const spec = parseBuiltinReceiptSpec(provisional.installSpec)
        if (provisional.workflowId !== workflow.id
          || provisional.packageName !== endpoint.packageName
          || provisional.targetProfile !== endpoint.targetProfile
          || !spec
          || spec.version !== endpoint.version
          || spec.mountId !== endpoint.mountId) {
          throw new EvolutionError('review_expired', 'The provisional built-in receipt no longer matches the selected target')
        }
        if (provisional.installPhase === 'completed' && provisional.installed) return provisional
      } else {
        const presentBefore = await builtinMountPresent({
          dshHome: this.config.dshHome,
          targetProfile: endpoint.targetProfile,
          mountId: endpoint.mountId,
          packageName: endpoint.packageName,
        })
        provisional = {
          schemaVersion: 1,
          id: installationId,
          createdAt,
          workflowId: workflow.id,
          targetProfile: endpoint.targetProfile,
          retention: 'persistent',
          dshHome: this.config.dshHome,
          packageName: endpoint.packageName,
          installSpec: builtinReceiptSpec({ version: endpoint.version, mountId: endpoint.mountId, wrote: !presentBefore }),
          installPhase: 'prepared',
          installState: 'unknown',
          installOutcome: 'pending',
          installed: false,
          loaded: false,
          verified: false,
          restartRequired: false,
          removed: false,
          verification: {
            attempted: false,
            expectedTools: [],
            calledTools: [],
            resultTools: [],
            failedTools: [],
            sessionFiles: [],
            taskResultObserved: false,
            reason: 'Built-in enablement is prepared and linked to this workflow.',
          },
        }
        await this.store.put('installations', provisional)
      }
      await enableBuiltinMount({
        launcher: this.launcher,
        dshHome: this.config.dshHome,
        bundledRoot,
        endpoint,
        cwd: workflow.cwd ?? process.cwd(),
        ...(exec.signal ? { signal: exec.signal } : {}),
      })
      const ownership = parseBuiltinReceiptSpec(provisional.installSpec)!.wrote
      const record: InstallationRecord = {
        ...provisional,
        installSpec: builtinReceiptSpec({ version: endpoint.version, mountId: endpoint.mountId, wrote: ownership }),
        installPhase: 'completed',
        installState: 'installed',
        installOutcome: 'pending',
        installed: true,
        loaded: false,
        verified: false,
        restartRequired: ownership,
        removed: false,
        verification: {
          attempted: false,
          expectedTools: [],
          calledTools: [],
          resultTools: [],
          failedTools: [],
          sessionFiles: [],
          taskResultObserved: false,
          reason: ownership
            ? 'The built-in mount was added and the composed profile was validated; restart is required for the serving process.'
            : 'The exact built-in mount already existed; no profile file was changed.',
        },
      }
      await this.store.put('installations', record)
      return record
    })
  }

  private currentProfileOwner(): Promise<string> {
    return resolveCurrentProfileOwner({
      dshHome: this.config.dshHome,
      baseUrl: Reflect.get(this.ctx as object, 'baseUrl'),
      argv: process.argv.slice(2),
    })
  }

  private async persistReviewed(
    record: ReviewRecord,
    files: readonly ContentFile[],
    exec: WorkflowExec,
    workflow?: WorkflowRecord,
  ): Promise<ReviewRecord> {
    void files
    void exec
    void workflow
    await this.store.put('reviews', record)
    return record
  }

  async releaseManagedSource(workflow: WorkflowRecord, _exec: WorkflowExec): Promise<void> {
    if (!workflow.managedSourceId) return
    // Lock release is Host cleanup. It must outlive an aborted user turn and is
    // already bounded by the command runner's timeout.
    await this.sources.completeWorkflow(workflow.managedSourceId, workflow.id)
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
  modificationWorkOrder,
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
  serializeProfileMutation,
}
