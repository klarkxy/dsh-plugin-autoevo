import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  FORGED_RESUME_HOST_KEYS,
  POLICY_VERSION,
  type NavigationInput,
  type ResolutionRecord,
  type ResumeInput,
  type ReviewRecord,
} from '../contracts.js'
import { EvolutionError } from '../errors.js'
import { normalizeRequirement, ownerSessionId } from '../host-identity.js'
import { composeDiscoveryRequirement } from '../resolver/keywords.js'
import { assertOptionAllowed, resolveDecisionFromModel, resolveDecisionTarget } from '../lifecycle/decide.js'
import {
  INTERRUPT_NODES,
  type CandidateSnapshotItem,
  type InterruptPayload,
  type ValidatedResume,
  type WorkflowExec,
  type WorkflowRecord,
  type WorkflowView,
} from './contracts.js'
import { retryableResumeHint } from './agent-view.js'
import { transition } from './graph.js'
import { snapshotDigestFor } from './candidates.js'
import {
  assertBuiltinEnablementBinding,
  endpointForLocalReuse,
  mintActionCommitment,
  mintSelectionReceipt,
} from './grants.js'
import { WorkflowEngineRecovery } from './engine-recovery.js'
import type { PreparedDiscoveryRefinement } from './engine-driver.js'

const EXACT_GITHUB_REPOSITORY_URL = /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,37})\/[A-Za-z0-9_.-]+?(?:\.git)?\/?$/iu

function exactGithubRepositoryUrl(message: string): string | undefined {
  const value = message.normalize('NFKC').trim()
  return EXACT_GITHUB_REPOSITORY_URL.test(value) ? value : undefined
}

function assertResumeDoesNotForgeHostFacts(input: ResumeInput): void {
  const record = input as unknown as Record<string, unknown>
  for (const key of FORGED_RESUME_HOST_KEYS) {
    if (record[key] !== undefined) {
      throw new EvolutionError('invalid_input', 'ResumeInput does not accept Host-owned selection, commitment, or lease fields', {
        key,
      })
    }
  }
}

export class WorkflowEngine extends WorkflowEngineRecovery {
  async resume(input: ResumeInput, exec: ToolRunContext): Promise<WorkflowView> {
    return await this.withLock(input.workflowId, async () => {
      assertResumeDoesNotForgeHostFacts(input)
      const workflow = await this.awaitPreEffect(
        () => this.store.getWorkflow(input.workflowId),
        exec.signal,
      )
      const callerSessionId = ownerSessionId(exec.agent)
      if (!callerSessionId || callerSessionId !== workflow.ownerSessionId) {
        throw new EvolutionError('invalid_input', 'Workflow belongs to a different owner session', {
          expected: workflow.ownerSessionId,
          actual: callerSessionId,
        })
      }
      if (workflow.policyVersion !== POLICY_VERSION) {
        await this.invalidateLegacyPolicyWorkflow(workflow, exec)
        const resolution = workflow.resolutionId
          ? await this.host.getResolution(workflow.resolutionId).catch(() => undefined)
          : undefined
        return await this.view(workflow, resolution, {}, exec.signal)
      }
      if (input.navigation?.kind === 'finish_managed_work') {
        return await this.resumeFinishManagedWork(workflow, input, exec)
      }
      if (workflow.status !== 'interrupted' || !workflow.interrupt || !INTERRUPT_NODES.has(workflow.cursor)) {
        throw new EvolutionError('invalid_input', 'This workflow is not waiting for a user decision', {
          status: workflow.status,
          cursor: workflow.cursor,
        })
      }
      if (!input.interruptId) {
        throw new EvolutionError('invalid_input', 'interrupt_id is required at a user gate')
      }
      if (workflow.consumedInterruptIds?.includes(input.interruptId)) {
        throw new EvolutionError('invalid_input', 'This interrupt_id was already consumed (replay rejected)', {
          interruptId: input.interruptId,
        })
      }
      if (workflow.interrupt.interruptId !== input.interruptId) {
        throw new EvolutionError('invalid_input', 'interrupt_id does not match the current workflow interrupt', {
          expected: workflow.interrupt.interruptId,
          actual: input.interruptId,
        })
      }

      const sessionId = callerSessionId
      if (!sessionId || sessionId !== workflow.ownerSessionId || sessionId !== workflow.interrupt.ownerSessionId) {
        throw new EvolutionError('invalid_input', 'Workflow interrupt belongs to a different owner session', {
          expected: workflow.ownerSessionId,
          actual: sessionId,
        })
      }
      if (workflow.interrupt.bootId !== this.creationGuard.bootId || workflow.bootId !== this.creationGuard.bootId) {
        await this.reissueInterrupt(workflow, exec)
        throw new EvolutionError('invalid_input', 'Workflow interrupt was invalidated by a service restart; present the reissued interrupt and obtain a fresh user confirmation', {
          workflowId: workflow.id,
          interruptId: workflow.interrupt?.interruptId,
        })
      }
      if (workflow.interrupt.kind !== workflow.cursor) {
        throw new EvolutionError('invalid_input', 'Workflow interrupt kind does not match its current control node; no decision was applied')
      }
      if (workflow.cursor === 'await_clarification') {
        const expectedControl = await this.canonicalInterruptPayload(workflow, undefined, [], exec)
        this.assertCanonicalInterrupt(workflow, expectedControl)
        const expectedDigest = this.clarificationSnapshotDigest(workflow)
        if (expectedDigest !== workflow.interrupt.snapshotDigest) {
          throw new EvolutionError('invalid_input', 'Clarification interrupt snapshot digest mismatch')
        }
        if (this.creationGuard.isAwaitingFreshUserTurn(exec.agent, workflow.interrupt)) {
          return await this.view(workflow, undefined, { status: 'parked', alreadyWaiting: true }, exec.signal)
        }
        if (input.decision || !input.navigation) {
          return await this.invalidResumeView(workflow, undefined, exec, input, 'Clarification accepts read-only navigation only')
        }
        if (input.navigation.kind === 'stop') {
          this.creationGuard.consumeDecisionTurn(exec.agent, workflow.interrupt)
          workflow.generation += 1
          workflow.status = 'running'
          workflow.consumedInterruptIds = [...(workflow.consumedInterruptIds ?? []), input.interruptId]
          delete workflow.interrupt
          this.clearWorkflowGrant(workflow)
          workflow.cursor = 'stopped'
          return await this.runUntilPark(workflow, exec)
        }
        if (input.navigation.kind !== 'clarify_requirement' || !input.navigation.clarifiedIntent) {
          return await this.invalidResumeView(workflow, undefined, exec, input, 'Clarification requires clarify_requirement with clarified_intent')
        }
        if (input.navigation.candidateIds?.length || input.navigation.reviewMode
          || input.navigation.repositories?.length) {
          return await this.invalidResumeView(workflow, undefined, exec, input, 'Clarification does not accept candidate_ids, review_mode, or repositories')
        }
        const turn = this.creationGuard.previewDecisionTurn(exec.agent, workflow.interrupt)
        const normalizedAnswer = normalizeRequirement(turn.message)
        if (!normalizedAnswer) {
          return await this.invalidResumeView(workflow, undefined, exec, input, 'Clarification answer must not be empty')
        }
        const discoveryQueries = this.normalizeBaselineDiscoveryQueries(input.navigation.queries)
        this.creationGuard.consumeDecisionTurn(exec.agent, workflow.interrupt)
        workflow.clarificationAnswer = turn.message
        workflow.clarifiedIntent = input.navigation.clarifiedIntent
        workflow.searchRequirement = composeDiscoveryRequirement(workflow.requirement, turn.message)
        workflow.startedTurnId = turn.turnId
        if (discoveryQueries) workflow.discoveryQueries = discoveryQueries
        else delete workflow.discoveryQueries
        workflow.generation += 1
        workflow.status = 'running'
        workflow.consumedInterruptIds = [...(workflow.consumedInterruptIds ?? []), input.interruptId]
        delete workflow.interrupt
        delete workflow.invalidResumeAttempt
        this.clearWorkflowGrant(workflow)
        workflow.cursor = 'resolve_local'
        return await this.runUntilPark(workflow, exec)
      }
      if (!workflow.resolutionId) {
        throw new EvolutionError('invalid_input', 'This workflow has no resolution to resume')
      }
      const resolution = await this.host.getResolution(workflow.resolutionId)
      const reviews = await this.reviewsForWorkflow(workflow, exec.signal)
      const expectedControl = await this.canonicalInterruptPayload(workflow, resolution, reviews, exec)
      this.assertCanonicalInterrupt(workflow, expectedControl)
      const expectedDigest = snapshotDigestFor(workflow.interrupt.kind, resolution, reviews, workflow)
      if (expectedDigest !== workflow.interrupt.snapshotDigest) {
        throw new EvolutionError('invalid_input', 'Interrupt candidate/review snapshot digest mismatch', {
          expected: expectedDigest,
          actual: workflow.interrupt.snapshotDigest,
        })
      }

      if (this.creationGuard.isAwaitingFreshUserTurn(exec.agent, workflow.interrupt)) {
        return await this.view(workflow, resolution, {
          status: 'parked',
          alreadyWaiting: true,
        }, exec.signal)
      }

      const currentTurnId = this.creationGuard.currentTurnId(exec.agent)
      const invalidAttempt = workflow.invalidResumeAttempt
      if (invalidAttempt && invalidAttempt.hostTurnId === currentTurnId && invalidAttempt.count >= 2) {
        return await this.view(workflow, resolution, {
          status: 'invalid_resume',
          resumeHint: 'Repeated invalid action is blocked until a fresh user turn.',
        }, exec.signal)
      }
      if (workflow.invalidResumeAttempt && workflow.invalidResumeAttempt.hostTurnId !== currentTurnId) {
        delete workflow.invalidResumeAttempt
        await this.checkpoint(workflow)
      }

      if (input.navigation && input.decision) {
        return await this.invalidResumeView(workflow, resolution, exec, input, 'Provide either navigation or decision, not both')
      }
      if (input.navigation) {
        try {
          return await this.resumeNavigation(workflow, resolution, input.navigation, input.interruptId, exec)
        } catch (error) {
          const hint = retryableResumeHint(error)
          if (hint) return await this.invalidResumeView(workflow, resolution, exec, input, hint)
          throw error
        }
      }
      const emptyCandidateGate = workflow.cursor === 'await_selection'
        && (workflow.candidateSnapshot?.length ?? 0) === 0
      if (workflow.cursor !== 'await_confirmation' && !emptyCandidateGate) {
        return await this.invalidResumeView(
          workflow,
          resolution,
          exec,
          input,
          'This gate accepts read-only navigation rather than a final authorization action',
        )
      }
      if (!input.decision) {
        return await this.invalidResumeView(
          workflow,
          resolution,
          exec,
          input,
          'Final confirmation requires a model-interpreted decision bound to the fresh user turn',
        )
      }
      let decisionReview
      let resume
      try {
        resolveDecisionTarget(input.decision, workflow.interrupt)
        decisionReview = input.decision.action === 'use_this'
          || input.decision.action === 'apply_recovery'
          || input.decision.action === 'modify_this'
          ? await this.reviewForAuthorization(workflow, reviews, input.decision.candidateId)
          : undefined
        resume = resolveDecisionFromModel({
          guard: this.creationGuard,
          agent: exec.agent,
          interrupt: workflow.interrupt,
          decision: input.decision,
          requirement: workflow.requirement,
          ...(decisionReview ? { reviewId: decisionReview.id } : {}),
          ...(decisionReview?.runtimeSurface?.verificationLayer
            ? { verificationLayer: decisionReview.runtimeSurface.verificationLayer }
            : {}),
        })
      } catch (error) {
        const hint = retryableResumeHint(error)
        if (hint) return await this.invalidResumeView(workflow, resolution, exec, input, hint)
        throw error
      }

      const latest = await this.awaitPreEffect(
        () => this.store.getWorkflow(workflow.id),
        exec.signal,
      )
      if (latest.generation !== workflow.generation
        || latest.status !== 'interrupted'
        || latest.cursor !== workflow.cursor
        || latest.interrupt?.interruptId !== input.interruptId) {
        throw new EvolutionError('invalid_input', 'This workflow is already running or has moved on')
      }
      if ((resume.optionId === 'use_this' || resume.optionId === 'apply_recovery') && decisionReview) {
        await this.clearErroneousVerificationAttempt(latest, decisionReview, exec.signal)
      }
      latest.generation += 1
      latest.status = 'running'
      delete latest.lastFailure
      delete latest.lastDiagnosis
      delete latest.invalidResumeAttempt
      latest.consumedInterruptIds = [...(latest.consumedInterruptIds ?? []), input.interruptId]
      latest.pendingRepositories = resume.repositories
      if (resume.ref) latest.pendingRef = resume.ref
      else delete latest.pendingRef
      if (resume.path) latest.pendingPath = resume.path
      else delete latest.pendingPath
      if (resume.install) latest.pendingInstall = resume.install
      else delete latest.pendingInstall
      if (decisionReview) {
        // Downstream graph nodes consume lastReviewId; pin it to the exact
        // candidate selected by the model instead of the review display order.
        latest.lastReviewId = decisionReview.id
      }
      if (resume.optionId === 'modify_this' && decisionReview) {
        latest.lineageTipReviewId = decisionReview.id
      }
      latest.cursor = resume.optionId === 'enable_builtin'
        ? 'enable_builtin'
        : transition(latest.cursor, resume.optionId)
      const consumedInterrupt = workflow.interrupt
      delete latest.interrupt
      this.grantFinalDecision({
        workflow: latest,
        interrupt: consumedInterrupt,
        resume,
        ...(decisionReview ? { review: decisionReview } : {}),
        exec,
      })
      // The workflow record is the single-Host execution claim. Persist the
      // consumed interrupt and exact grant before any Host decision or node
      // can publish side effects. A restart settles this running record
      // through the ordinary stale-workflow recovery path.
      await this.checkpoint(latest)
      let nextResolution: ResolutionRecord
      try {
        nextResolution = await this.host.applyDecision(resolution, resume, decisionReview, latest)
      } catch {
        return await this.settleCommittedFinalDecisionFailure(latest, resolution, exec)
      }
      return await this.runUntilPark(latest, exec, undefined, nextResolution)
    })
  }

  private async settleCommittedFinalDecisionFailure(
    workflow: WorkflowRecord,
    resolution: ResolutionRecord,
    exec: ToolRunContext,
  ): Promise<WorkflowView> {
    workflow.cursor = 'recovery_required'
    workflow.status = 'interrupted'
    workflow.lastFailure = {
      stage: 'workflow',
      code: 'final_decision_application_failed',
      message: 'The final decision was checkpointed but Host application did not complete; recovery is required.',
      retryable: false,
    }
    delete workflow.interrupt
    delete workflow.lastDiagnosis
    delete workflow.invalidResumeAttempt
    this.clearWorkflowGrant(workflow)
    this.creationGuard.invalidateHostGrant(exec.agent)
    await this.host.releaseManagedSource?.(workflow, this.cleanupExec(exec))
    await this.issueRecoveryInterrupt(workflow, exec)
    this.syncGuard(workflow, exec, undefined, resolution)
    if (exec.signal?.aborted) throw exec.signal.reason
    return await this.view(workflow, resolution, { status: 'parked', alreadyWaiting: true }, exec.signal)
  }

  private async resumeFinishManagedWork(
    workflow: WorkflowRecord,
    input: ResumeInput,
    exec: ToolRunContext,
  ): Promise<WorkflowView> {
    if (input.decision) {
      const resolution = workflow.resolutionId
        ? await this.readOptionalBeforeEffect(
            () => this.host.getResolution(workflow.resolutionId!),
            exec.signal,
          )
        : undefined
      if (!resolution) throw new EvolutionError('invalid_input', 'This workflow has no resolution to resume')
      return await this.invalidResumeView(
        workflow,
        resolution,
        exec,
        input,
        'Provide finish_managed_work without a final decision',
      )
    }
    if (workflow.cursor !== 'await_modify_work' || workflow.status !== 'interrupted' || workflow.interrupt) {
      throw new EvolutionError('invalid_input', 'This workflow is not waiting for managed construction to finish', {
        status: workflow.status,
        cursor: workflow.cursor,
      })
    }
    if (!workflow.resolutionId) {
      throw new EvolutionError('invalid_input', 'This workflow has no resolution to resume')
    }
    const latest = await this.awaitPreEffect(
      () => this.store.getWorkflow(workflow.id),
      exec.signal,
    )
    if (latest.generation !== workflow.generation || latest.status !== 'interrupted') {
      throw new EvolutionError('invalid_input', 'This workflow is already running or has moved on')
    }
    const resolution = await this.awaitPreEffect(
      () => this.host.getResolution(latest.resolutionId!),
      exec.signal,
    )
    latest.generation += 1
    latest.status = 'running'
    delete latest.lastFailure
    delete latest.lastDiagnosis
    delete latest.invalidResumeAttempt
    latest.cursor = transition(latest.cursor, 'finish_managed_work')
    return await this.runUntilPark(latest, exec, undefined, resolution)
  }

  private async resumeNavigation(
    workflow: WorkflowRecord,
    resolution: ResolutionRecord,
    navigation: NavigationInput,
    interruptId: string,
    exec: ToolRunContext,
  ): Promise<WorkflowView> {
    const latest = await this.store.getWorkflow(workflow.id)
    if (latest.generation !== workflow.generation || latest.status !== 'interrupted') {
      throw new EvolutionError('invalid_input', 'This workflow is already running or has moved on')
    }
    const interrupt = workflow.interrupt
    if (!interrupt) {
      throw new EvolutionError('invalid_input', 'This workflow is not waiting for a user decision')
    }
    const snapshot = latest.candidateSnapshot ?? []
    const requestedIds = [...new Set(navigation.candidateIds ?? [])]
    for (const id of requestedIds) {
      if (!snapshot.some((item) => item.id === id)) {
        throw new EvolutionError('invalid_input', 'Navigation candidate is outside the current candidate snapshot', {
          candidateId: id,
        })
      }
    }
    assertOptionAllowed(interrupt, navigation.kind)

    if (navigation.kind !== 'search_more'
      && ((navigation.queries?.length ?? 0) > 0 || (navigation.repositories?.length ?? 0) > 0)) {
      throw new EvolutionError('invalid_input', 'queries and repositories are legal only for search_more')
    }
    let refinement: PreparedDiscoveryRefinement | undefined
    if (navigation.kind === 'search_more') {
      const freshTurn = this.creationGuard.previewDecisionTurn(exec.agent, interrupt)
      const repositoryFromTurn = exactGithubRepositoryUrl(freshTurn.message)
      const repositories = [...(navigation.repositories ?? []), ...(repositoryFromTurn ? [repositoryFromTurn] : [])]
      if ((navigation.queries?.length ?? 0) > 0 || repositories.length > 0) {
        refinement = this.prepareDiscoveryRefinement(latest, {
          ...(navigation.queries ? { queries: navigation.queries } : {}),
          repositories,
        }, { allowGithubRootUrl: true, turnId: freshTurn.turnId })
      }
    }

    let repositories: string[] = []
    let pendingReviewIds: string[] = []
    let reuseCandidate: CandidateSnapshotItem | undefined
    let builtinCandidate: CandidateSnapshotItem | undefined
    if (navigation.kind === 'review_candidates') {
      if (requestedIds.length < 1 || requestedIds.length > 3) {
        throw new EvolutionError('invalid_input', 'review_candidates requires one to three candidate_ids')
      }
      const selected = snapshot
        .filter((item) => requestedIds.includes(item.id))
        .sort((left, right) => left.index - right.index)
      if (selected.some((item) => item.kind !== 'remote' || !item.repository)) {
        throw new EvolutionError('invalid_input', 'review_candidates accepts remote candidates only')
      }
      const alreadyReviewed = new Set(latest.reviewedCandidateIds ?? [])
      const pending = selected.filter((item) => !alreadyReviewed.has(item.id))
      if (pending.length === 0) {
        throw new EvolutionError('invalid_input', 'Every selected candidate was already reviewed')
      }
      repositories = pending.map((item) => item.repository!)
      pendingReviewIds = pending.map((item) => item.id)
    } else if (navigation.kind === 'review_existing') {
      if (requestedIds.length !== 1) {
        throw new EvolutionError('invalid_input', 'review_existing requires exactly one candidate_id')
      }
      const candidate = snapshot.find((item) => item.id === requestedIds[0])
      const target = candidate?.evolutionTarget
      if (!candidate || candidate.kind !== 'local' || !target) {
        throw new EvolutionError('invalid_input', 'review_existing requires an installed candidate with Host-derived source provenance')
      }
      repositories = [target.repository]
      pendingReviewIds = [candidate.id]
      latest.pendingReviewedCandidateId = candidate.id
      latest.pendingRef = target.commit
    } else if (navigation.kind === 'reuse_local') {
      if (requestedIds.length !== 1) {
        throw new EvolutionError('invalid_input', 'reuse_local requires exactly one candidate_id')
      }
      const candidate = snapshot.find((item) => item.id === requestedIds[0])
      if (!candidate || candidate.kind !== 'local' || !(candidate.reuseEligible ?? candidate.fit === 'full')) {
        throw new EvolutionError('invalid_input', 'reuse_local requires a reusable local candidate from this snapshot')
      }
      reuseCandidate = candidate
    } else if (navigation.kind === 'enable_builtin') {
      if (requestedIds.length !== 1) {
        throw new EvolutionError('invalid_input', 'enable_builtin requires exactly one candidate_id')
      }
      const candidate = snapshot.find((item) => item.id === requestedIds[0])
      if (!candidate || candidate.kind !== 'local' || candidate.availability !== 'host_bundled' || !candidate.hostBundled) {
        throw new EvolutionError('invalid_input', 'enable_builtin requires a host-bundled local candidate from this snapshot')
      }
      builtinCandidate = candidate
    }

    const turn = this.creationGuard.consumeDecisionTurn(exec.agent, interrupt)
    const receiptCandidateIds = navigation.kind === 'search_more'
      ? []
      : navigation.kind === 'stop'
        ? []
        : requestedIds
    const receipt = mintSelectionReceipt({
      workflowId: latest.id,
      interrupt,
      phase: 'gate1',
      kind: navigation.kind,
      candidateIds: receiptCandidateIds,
      snapshot,
      hostTurnId: turn.turnId,
    })

    latest.generation += 1
    latest.status = 'running'
    latest.consumedInterruptIds = [...(latest.consumedInterruptIds ?? []), interruptId]
    delete latest.interrupt
    delete latest.lastFailure
    delete latest.lastDiagnosis
    delete latest.invalidResumeAttempt

    if (navigation.kind === 'review_candidates' || navigation.kind === 'review_existing') {
      this.creationGuard.invalidateHostGrant(exec.agent)
      latest.selectionReceipt = receipt
      latest.actionCommitment = mintActionCommitment({
        receipt,
        action: navigation.kind,
        endpoint: { kind: 'none' },
      })
      latest.reviewPlan = {
        mode: navigation.reviewMode ?? 'fixed',
        candidateIds: pendingReviewIds,
        maxReviews: Math.min(3, pendingReviewIds.length) as 1 | 2 | 3,
      }
      latest.reviewQueue = [...latest.reviewPlan.candidateIds]
      latest.pendingRepositories = repositories
      latest.cursor = navigation.kind === 'review_existing' ? 'review_existing' : 'review_github'
    } else if (navigation.kind === 'search_more') {
      this.creationGuard.invalidateHostGrant(exec.agent)
      const currentIds = snapshot.map((item) => item.id)
      latest.seenCandidateIds = [...new Set([...(latest.seenCandidateIds ?? []), ...currentIds])]
      latest.rejectedCandidateIds = [...new Set([...(latest.rejectedCandidateIds ?? []), ...currentIds])]
      latest.forceRemoteDiscovery = refinement ? false : true
      this.clearWorkflowGrant(latest)
      delete latest.candidateSnapshot
      delete latest.discoveryPool
      delete latest.candidatePreviews
      delete latest.candidatePreviewFailures
      delete latest.reviewPlan
      delete latest.reviewQueue
      delete latest.pendingRepositories
      latest.cursor = refinement ? 'await_discovery' : 'discover_remote'
    } else if (navigation.kind === 'reuse_local') {
      const candidate = reuseCandidate!
      const endpoint = endpointForLocalReuse(candidate)
      const commitment = mintActionCommitment({
        receipt,
        action: 'reuse_local',
        candidate,
        endpoint,
      })
      this.creationGuard.grantHostSelection(exec.agent, receipt, commitment)
      latest.selectionReceipt = receipt
      latest.actionCommitment = commitment
      latest.cursor = 'reuse_local'
    } else if (navigation.kind === 'enable_builtin') {
      const candidate = builtinCandidate!
      const bundled = candidate.hostBundled!
      let targetProfile: string | undefined
      exec.signal?.throwIfAborted()
      try {
        targetProfile = this.host.enableTargetProfile
          ? await this.host.enableTargetProfile(exec as WorkflowExec)
          : undefined
        exec.signal?.throwIfAborted()
      } catch (error) {
        if (exec.signal?.aborted) throw exec.signal.reason
        throw error
      }
      if (!targetProfile) {
        throw new EvolutionError('invalid_input', 'enable_builtin requires an active Host profile')
      }
      const commitment = mintActionCommitment({
        receipt,
        action: 'enable_builtin',
        candidate,
        endpoint: {
          kind: 'host_bundled_enable',
          packageName: bundled.packageName,
          version: bundled.version,
          mountId: bundled.mountId,
          targetProfile,
        },
        targetProfile,
      })
      this.creationGuard.invalidateHostGrant(exec.agent)
      latest.selectionReceipt = receipt
      latest.actionCommitment = commitment
      latest.cursor = 'await_confirmation'
    } else {
      this.creationGuard.invalidateHostGrant(exec.agent)
      latest.selectionReceipt = receipt
      latest.actionCommitment = mintActionCommitment({
        receipt,
        action: 'stop',
        endpoint: { kind: 'none' },
      })
      latest.cursor = 'stopped'
    }

    let nextResolution: ResolutionRecord
    try {
      nextResolution = await this.host.applyNavigation(resolution, navigation, repositories)
      if (refinement) {
        nextResolution = await this.applyDiscoveryRefinement(latest, nextResolution, refinement, exec)
        this.parkIfDiscoveryTurnExhausted(latest, refinement.nextBudget)
      }
    } catch (error) {
      if (navigation.kind !== 'search_more') throw error

      // The fresh user turn is already consumed. Persist a new retry gate instead
      // of leaving the previous interrupt replayable or the workflow half-running.
      let currentResolution: ResolutionRecord
      exec.signal?.throwIfAborted()
      try {
        currentResolution = await this.host.getResolution(resolution.id)
        exec.signal?.throwIfAborted()
      } catch (readError) {
        if (exec.signal?.aborted) throw exec.signal.reason
        throw readError
      }
      const incompleteResolution = { ...currentResolution, remoteDiscoveryComplete: false }
      exec.signal?.throwIfAborted()
      await this.store.put('resolutions', incompleteResolution)
      exec.signal?.throwIfAborted()
      latest.lastFailure = {
        stage: 'discovery',
        code: error instanceof EvolutionError ? error.code : 'command_failed',
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      }
      latest.forceRemoteDiscovery = false
      latest.status = 'running'
      latest.cursor = 'await_selection'
      latest.candidateSnapshot = []
      delete latest.discoveryPool
      delete latest.interrupt
      return await this.runUntilPark(latest, exec, undefined, incompleteResolution)
    }
    return await this.runUntilPark(latest, exec, undefined, nextResolution)
  }

  private grantFinalDecision(input: {
    workflow: WorkflowRecord
    interrupt: InterruptPayload | undefined
    resume: ValidatedResume
    review?: ReviewRecord
    exec: ToolRunContext
  }): void {
    const interrupt = input.interrupt
    if (!interrupt) {
      throw new EvolutionError('invalid_input', 'Final decision requires the consumed interrupt')
    }
    const snapshot = input.workflow.candidateSnapshot ?? []
    const needsCandidate = input.resume.optionId === 'use_this'
      || input.resume.optionId === 'apply_recovery'
      || input.resume.optionId === 'modify_this'
      || input.resume.optionId === 'enable_builtin'
    const candidate = input.resume.candidateId
      ? snapshot.find((item) => item.id === input.resume.candidateId)
      : undefined
    if (needsCandidate && !candidate) {
      throw new EvolutionError('invalid_input', 'Final use/modify/enable commitment requires the interrupt-bound candidate', {
        candidateId: input.resume.candidateId,
      })
    }
    if ((input.resume.optionId === 'use_this'
      || input.resume.optionId === 'apply_recovery'
      || input.resume.optionId === 'modify_this') && !input.review) {
      throw new EvolutionError('invalid_input', 'Final use/modify commitment requires the selected review', {
        candidateId: input.resume.candidateId,
      })
    }
    const builtinBinding = input.resume.optionId === 'enable_builtin'
      ? assertBuiltinEnablementBinding(input.workflow, 'gate1')
      : undefined
    if (builtinBinding && builtinBinding.candidate.id !== candidate?.id) {
      throw new EvolutionError('review_expired', 'Gate-2 enablement does not match the exact Gate-1 built-in candidate')
    }
    const receipt = mintSelectionReceipt({
      workflowId: input.workflow.id,
      interrupt,
      phase: 'gate2',
      kind: input.resume.optionId,
      candidateIds: candidate ? [candidate.id] : [],
      ...(input.resume.recoveryId ? { recoveryId: input.resume.recoveryId } : {}),
      snapshot,
      hostTurnId: input.resume.hostTurnId,
    })
    const commitment = mintActionCommitment({
      receipt,
      action: input.resume.optionId,
      ...(candidate ? { candidate } : {}),
      endpoint: builtinBinding?.endpoint ?? { kind: 'none' },
      ...((input.resume.optionId === 'use_this' || input.resume.optionId === 'apply_recovery') && input.resume.install?.retention
        ? { retention: input.resume.install.retention }
        : {}),
      ...((input.resume.optionId === 'use_this' || input.resume.optionId === 'apply_recovery') && input.resume.install?.targetProfile
        ? { targetProfile: input.resume.install.targetProfile }
        : {}),
      ...(input.resume.optionId === 'apply_recovery' && input.resume.install?.recoveryPlan
        ? { recoveryPlan: input.resume.install.recoveryPlan }
        : {}),
      ...(builtinBinding ? { targetProfile: builtinBinding.endpoint.targetProfile } : {}),
      ...(needsCandidate && input.review ? { review: input.review } : {}),
      workflow: input.workflow,
    })
    input.workflow.selectionReceipt = receipt
    input.workflow.actionCommitment = commitment
    this.creationGuard.grantHostSelection(input.exec.agent, receipt, commitment)
  }
}
