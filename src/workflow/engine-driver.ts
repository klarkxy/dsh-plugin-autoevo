import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  DEFAULT_REQUEST_INTENT,
  POLICY_VERSION,
  type RequestIntent,
} from '../contracts.js'
import { EvolutionError } from '../errors.js'
import {
  newInterruptId,
  normalizeRequirement,
  ownerSessionId,
  sessionCwd,
} from '../host-identity.js'
import {
  INSTALL_SUCCESS_OUTCOMES,
  INTERRUPT_NODES,
  MODEL_CONTROL_NODES,
  TERMINAL_NODES,
  type DiagnosticFact,
  type DiscoveryPresentInput,
  type DiscoveryRefineInput,
  type WorkflowDiagnoseInput,
  type WorkflowDiagnosis,
  type WorkflowExec,
  type WorkflowRecord,
  type WorkflowView,
} from './contracts.js'
import { executeNode, interruptPayload } from './graph.js'
import { boundedAgentText as boundedDiagnosticText } from './sanitize.js'
import {
  DISCOVERY_POOL_MAX,
  SEALED_SHORTLIST_MAX,
  candidateId,
  candidateSnapshotFor,
  discoveryBudget,
  excludedCandidateIds,
  newWorkflowId,
  normalizeRefinementQuery,
  registerReviewedCandidate,
  snapshotDigestFor,
} from './candidates.js'
import { WorkflowEngineCore } from './engine-core.js'

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new EvolutionError('command_failed', 'Workflow cancelled')
  }
}

export abstract class WorkflowEngineDriver extends WorkflowEngineCore {
  async start(
    requirement: string,
    exec: ToolRunContext,
    intent: RequestIntent = DEFAULT_REQUEST_INTENT,
    clarificationQuestion?: string,
  ): Promise<WorkflowView> {
    const requestSummary = normalizeRequirement(requirement)
    if (!requestSummary || requestSummary.length > 2_000) {
      throw new EvolutionError('invalid_input', 'requirement must contain 1 to 2000 characters')
    }
    const capturedRequirement = this.creationGuard.lastUserMessage(exec.agent)
    const originalRequirement = capturedRequirement ?? (this.requireHostCapturedRequirement ? undefined : requirement)
    const normalized = originalRequirement ? normalizeRequirement(originalRequirement) : ''
    if (!originalRequirement || !normalized || normalized.length > 2_000) {
      throw new EvolutionError('invalid_input', 'A current Host-captured user requirement of 1 to 2000 characters is required')
    }
    const question = clarificationQuestion?.trim()
    if (question && question.length > 300) {
      throw new EvolutionError('invalid_input', 'clarification_question must contain at most 300 characters')
    }
    const sessionId = ownerSessionId(exec.agent)
    if (!sessionId) {
      throw new EvolutionError('invalid_input', 'A live Agent session identity is required to start a workflow')
    }
    const cwd = sessionCwd(exec.agent)
    const workflowId = newWorkflowId(originalRequirement)
    await this.supersedePendingClarifications(sessionId, cwd, this.creationGuard.currentTurnId(exec.agent), workflowId, exec)
    await this.invalidateStalePolicyWorkflows(sessionId, normalized, exec)
    const existing = await this.findReusableWorkflow(sessionId, cwd, normalized, intent)
    if (existing) {
      return await this.withLock(existing.id, async () => {
        const latest = await this.store.getWorkflow(existing.id)
        if (latest.status === 'running') {
          if (latest.bootId === this.creationGuard.bootId) {
            throw new EvolutionError('invalid_input', 'This workflow is already running')
          }
          latest.bootId = this.creationGuard.bootId
          latest.cursor = 'recovery_required'
          latest.status = 'interrupted'
          latest.lastFailure = {
            stage: 'workflow',
            code: 'service_restart_incomplete',
            message: 'The service restarted while this workflow was running. Side effects are not retried automatically; recovery is required.',
            retryable: false,
          }
          delete latest.interrupt
          this.clearWorkflowGrant(latest)
          this.creationGuard.setConstructionRoot(exec.agent, undefined)
          this.creationGuard.invalidateExecutionLease(exec.agent)
          await this.host.releaseManagedSource?.(latest, exec as WorkflowExec).catch(() => undefined)
          await this.issueRecoveryInterrupt(latest, exec)
          this.syncGuard(latest, exec, undefined)
          const interruptedResolution = latest.resolutionId ? await this.host.getResolution(latest.resolutionId) : undefined
          return await this.view(latest, interruptedResolution, { status: 'parked', alreadyWaiting: true })
        }
        if (latest.bootId !== this.creationGuard.bootId && latest.status === 'interrupted' && latest.interrupt) {
          this.creationGuard.invalidateExecutionLease(exec.agent)
          await this.reissueInterrupt(latest, exec)
        }
        let resolution = latest.resolutionId ? await this.host.getResolution(latest.resolutionId) : undefined
        return await this.view(latest, resolution)
      })
    }

    const startedTurnId = this.creationGuard.currentTurnId(exec.agent)
    return await this.startFresh(originalRequirement, normalized, sessionId, cwd, exec, intent, undefined, workflowId, {
      requestSummary,
      ...(question ? { clarificationQuestion: question } : {}),
      ...(startedTurnId ? { startedTurnId } : {}),
    })
  }

  private async supersedePendingClarifications(
    sessionId: string,
    cwd: string,
    currentTurnId: string | undefined,
    supersedingWorkflowId: string,
    exec: ToolRunContext,
  ): Promise<void> {
    if (!currentTurnId) return
    const workflows = await this.store.listWorkflows()
    const pending = workflows.filter((item) => item.policyVersion === POLICY_VERSION
      && item.ownerSessionId === sessionId
      && item.cwd === cwd
      && item.status === 'interrupted'
      && item.cursor === 'await_clarification'
      && item.startedTurnId !== currentTurnId)
    for (const item of pending) {
      await this.withLock(item.id, async () => {
        const latest = await this.store.getWorkflow(item.id)
        if (latest.status !== 'interrupted' || latest.cursor !== 'await_clarification') return
        delete latest.interrupt
        this.clearWorkflowGrant(latest)
        latest.status = 'completed'
        latest.cursor = 'superseded'
        latest.supersededByWorkflowId = supersedingWorkflowId
        latest.supersededAt = new Date().toISOString()
        await this.checkpoint(latest)
      })
    }
    if (pending.length > 0) this.creationGuard.invalidateExecutionLease(exec.agent)
  }

  protected async startFresh(
    requirement: string,
    normalized: string,
    sessionId: string,
    cwd: string,
    exec: ToolRunContext,
    intent: RequestIntent = DEFAULT_REQUEST_INTENT,
    recoveredFromWorkflowId?: string,
    workflowId = newWorkflowId(requirement),
    startOptions: {
      requestSummary?: string
      clarificationQuestion?: string
      startedTurnId?: string
    } = {},
  ): Promise<WorkflowView> {
    const now = new Date().toISOString()
    const workflow: WorkflowRecord = {
      schemaVersion: 3,
      id: workflowId,
      policyVersion: POLICY_VERSION,
      createdAt: now,
      updatedAt: now,
      requirement,
      requirementNormalized: normalized,
      requestSummary: startOptions.requestSummary ?? normalized,
      searchRequirement: requirement,
      ...(startOptions.clarificationQuestion ? { clarificationQuestion: startOptions.clarificationQuestion } : {}),
      ...(startOptions.startedTurnId ? { startedTurnId: startOptions.startedTurnId } : {}),
      cwd,
      ownerSessionId: sessionId,
      bootId: this.creationGuard.bootId,
      status: 'running',
      cursor: startOptions.clarificationQuestion ? 'await_clarification' : 'resolve_local',
      generation: 1,
      consumedInterruptIds: [],
      intent,
      ...(recoveredFromWorkflowId ? { recoveredFromWorkflowId } : {}),
    }
    this.creationGuard.invalidateExecutionLease(exec.agent)
    const guardGeneration = this.creationGuard.beginResolution(exec.agent)
    return await this.withLock(workflow.id, () => this.runUntilPark(workflow, exec, guardGeneration))
  }

  async refine(input: DiscoveryRefineInput, exec: ToolRunContext): Promise<WorkflowView> {
    return await this.withLock(input.workflowId, async () => {
      const workflow = await this.store.getWorkflow(input.workflowId)
      this.assertDiscoveryControl(workflow, exec)
      if (!workflow.resolutionId) throw new EvolutionError('invalid_input', 'Discovery workflow has no resolution')
      if (!this.host.refineRemote) throw new EvolutionError('invalid_input', 'This workflow host does not support autonomous refinement')
      const budget = workflow.discoveryBudget ?? discoveryBudget()
      if (budget.refinementRoundsUsed >= budget.maxRefinementRounds) {
        throw new EvolutionError('invalid_input', 'Discovery refinement round budget is exhausted')
      }
      const usedQueries = new Set(budget.refinementQueriesUsed.map((item) => item.toLowerCase()))
      const queries = [...new Set((input.queries ?? [])
        .map(normalizeRefinementQuery)
        .filter((item) => item.length >= 2 && !usedQueries.has(item.toLowerCase())))]
      if (budget.refinementQueriesUsed.length + queries.length > budget.maxRefinementQueries) {
        throw new EvolutionError('invalid_input', 'Discovery refinement query budget would be exceeded', {
          remaining: budget.maxRefinementQueries - budget.refinementQueriesUsed.length,
        })
      }
      const usedRepositories = new Set(budget.explicitRepositories.map((item) => item.toLowerCase()))
      const repositories = [...new Set((input.repositories ?? [])
        .map((item) => item.normalize('NFKC').trim())
        .filter((item) => item && !usedRepositories.has(item.toLowerCase())))]
        .slice(0, 5)
      if (queries.length === 0 && repositories.length === 0) {
        throw new EvolutionError('invalid_input', 'Refinement requires at least one new query or repository')
      }
      const resolution = await this.host.getResolution(workflow.resolutionId)
      const nextResolution = await this.host.refineRemote(resolution, { queries, repositories }, exec as WorkflowExec)
      delete workflow.lastDiagnosis
      workflow.discoveryBudget = {
        ...budget,
        refinementRoundsUsed: budget.refinementRoundsUsed + 1,
        refinementQueriesUsed: [...budget.refinementQueriesUsed, ...queries],
        explicitRepositories: [...budget.explicitRepositories, ...repositories],
      }
      workflow.discoveryPool = candidateSnapshotFor(
        nextResolution,
        excludedCandidateIds(workflow),
        DISCOVERY_POOL_MAX,
      )
      const refinementExhausted = workflow.discoveryBudget.refinementRoundsUsed
        >= workflow.discoveryBudget.maxRefinementRounds
      const hasReviewableCandidate = workflow.discoveryPool.some((candidate) => (
        candidate.kind === 'remote' || (candidate.kind === 'local' && candidate.fit === 'full')
      ))
      workflow.generation += 1
      if (refinementExhausted && !hasReviewableCandidate) {
        workflow.cursor = 'await_confirmation'
        workflow.status = 'running'
        workflow.candidateSnapshot = []
        delete workflow.interrupt
        await this.checkpoint(workflow)
        return await this.runUntilPark(workflow, exec, undefined, nextResolution)
      }
      await this.checkpoint(workflow)
      this.syncGuard(workflow, exec, undefined, nextResolution)
      return await this.view(workflow, nextResolution)
    })
  }

  async present(input: DiscoveryPresentInput, exec: ToolRunContext): Promise<WorkflowView> {
    return await this.withLock(input.workflowId, async () => {
      const workflow = await this.store.getWorkflow(input.workflowId)
      this.assertDiscoveryControl(workflow, exec)
      const ids = [...new Set(input.candidateIds)]
      if (ids.length !== input.candidateIds.length) {
        throw new EvolutionError('invalid_input', 'Presented candidate_ids must be unique')
      }
      if (ids.length > SEALED_SHORTLIST_MAX) {
        throw new EvolutionError('invalid_input', 'Present accepts zero to five discovery candidate_ids')
      }
      const pool = workflow.discoveryPool ?? []
      const selected = ids.map((id) => pool.find((item) => item.id === id))
      if (selected.some((item) => !item)) {
        throw new EvolutionError('invalid_input', 'Presented candidate is outside the Host discovery pool')
      }
      workflow.candidateSnapshot = selected.map((item, index) => ({ ...item!, index: index + 1 }))
      workflow.cursor = 'await_selection'
      workflow.status = 'running'
      workflow.generation += 1
      delete workflow.interrupt
      delete workflow.invalidResumeAttempt
      delete workflow.lastDiagnosis
      return await this.runUntilPark(workflow, exec)
    })
  }

  async diagnose(input: WorkflowDiagnoseInput, exec: ToolRunContext): Promise<WorkflowView> {
    return await this.withLock(input.workflowId, async () => {
      const workflow = await this.store.getWorkflow(input.workflowId)
      this.assertOwner(workflow, exec)
      const probes = [...new Set(input.probes)].slice(0, 8)
      if (probes.length === 0) throw new EvolutionError('invalid_input', 'Diagnose requires at least one probe')
      const priorDiagnosis = workflow.lastDiagnosis
      const priorCalls = priorDiagnosis?.budget.usedCalls ?? 0
      const priorProbeUses = priorDiagnosis?.budget.usedProbes ?? 0
      if (priorCalls >= 2) {
        throw new EvolutionError('invalid_input', 'Diagnostic call budget is exhausted for this failure episode')
      }
      if (priorProbeUses + probes.length > 8) {
        throw new EvolutionError('invalid_input', 'Diagnostic probe budget would be exceeded', {
          remaining: Math.max(0, 8 - priorProbeUses),
        })
      }
      const resolution = workflow.resolutionId
        ? await this.host.getResolution(workflow.resolutionId).catch(() => undefined)
        : undefined
      const reviews = await this.reviewsForWorkflow(workflow)
      const installation = workflow.lastInstallationId
        ? await this.host.getInstallation(workflow.lastInstallationId).catch(() => undefined)
        : undefined
      const diagnosticAvailable = Boolean(
        workflow.lastFailure
        || workflow.reviewFailures?.length
        || workflow.status === 'failed'
        || workflow.error
        || (resolution && !resolution.remoteDiscoveryComplete)
        || (installation
          && !installation.verified
          && !(INSTALL_SUCCESS_OUTCOMES as readonly string[]).includes(installation.installOutcome ?? '')),
      )
      if (!diagnosticAvailable) {
        throw new EvolutionError('invalid_input', 'No failed or incomplete workflow stage is available for diagnosis')
      }
      const facts: DiagnosticFact[] = []
      for (const probe of probes) {
        if (probe === 'discovery') {
          facts.push({
            probe,
            status: !resolution ? 'unknown' : resolution.remoteDiscoveryComplete ? 'pass' : 'failed',
            code: !resolution ? 'discovery_missing' : resolution.remoteDiscoveryComplete ? 'search_complete' : 'search_incomplete',
            summary: boundedDiagnosticText((resolution?.reasons ?? []).at(-1) ?? 'No discovery result is linked.'),
            observed: Boolean(resolution),
            facts: {
              queries: (resolution?.queries ?? []).map((query) => boundedDiagnosticText(query, 120)).slice(0, 10),
              candidateCount: resolution?.remoteCandidates.length ?? 0,
            },
          })
        } else if (probe === 'review') {
          const failures = workflow.reviewFailures ?? []
          facts.push({
            probe,
            status: failures.length > 0 ? 'failed' : reviews.length > 0 ? 'pass' : 'unknown',
            code: failures[0]?.code ?? (reviews.length > 0 ? 'review_available' : 'review_missing'),
            summary: boundedDiagnosticText(failures[0]?.message ?? (reviews.length > 0
              ? `${reviews.length} bounded review record(s) are linked.`
              : 'No review record is linked.')),
            observed: failures.length > 0 || reviews.length > 0,
            facts: { reviewCount: reviews.length, failureCount: failures.length },
          })
        } else if (probe === 'installation') {
          facts.push({
            probe,
            status: !installation
              ? 'unknown'
              : (INSTALL_SUCCESS_OUTCOMES as readonly string[]).includes(installation.installOutcome ?? '')
                ? 'pass'
                : 'failed',
            code: installation?.installFailure?.code ?? installation?.installOutcome ?? 'installation_missing',
            summary: boundedDiagnosticText(installation?.installFailure?.message
              ?? installation?.verification.reason
              ?? 'No installation record is linked.'),
            observed: Boolean(installation),
            ...(installation?.installFailure?.diagnosticHash
              ? { evidenceHash: installation.installFailure.diagnosticHash }
              : {}),
            ...(installation ? { facts: {
              installState: installation.installState ?? 'unknown',
              removed: installation.removed,
              loaded: installation.loaded,
              verified: installation.verified,
            } } : {}),
          })
        } else if (probe === 'verification') {
          const verification = installation?.verification
          facts.push({
            probe,
            status: !verification ? 'unknown' : installation?.verified ? 'pass' : 'failed',
            code: !verification ? 'verification_missing' : installation?.verified ? 'verified' : 'verification_failed',
            summary: boundedDiagnosticText(verification?.reason ?? 'No verification record is linked.'),
            observed: Boolean(verification),
            ...(verification?.launchEvidence?.diagnosticHash
              ? { evidenceHash: verification.launchEvidence.diagnosticHash }
              : {}),
            ...(verification ? { facts: {
              exitCode: verification.exitCode ?? -1,
              taskResultObserved: verification.taskResultObserved,
              calledTools: verification.calledTools.slice(0, 16),
              failedTools: verification.failedTools.slice(0, 16),
              routeMatchedExpectation: verification.routeMatchedExpectation ?? true,
              processOutcome: verification.launchEvidence?.processOutcome ?? 'unknown',
              observerEventCount: verification.launchEvidence?.observerEventCount ?? 0,
            } } : {}),
          })
        } else if (probe === 'cleanup') {
          facts.push({
            probe,
            status: !installation ? 'unknown' : installation.removed ? 'pass' : 'failed',
            code: !installation ? 'cleanup_unknown' : installation.removed ? 'cleanup_recorded' : 'target_may_remain',
            summary: installation?.removed
              ? 'The linked installation record reports cleanup completed.'
              : 'The linked installation record does not prove cleanup completed.',
            observed: Boolean(installation),
            ...(installation ? { facts: {
              removed: installation.removed,
              installState: installation.installState ?? 'unknown',
            } } : {}),
          })
        } else {
          const failure = workflow.lastFailure
          facts.push({
            probe,
            status: failure?.stage === 'managed_child' ? 'failed' : 'unknown',
            code: failure?.code ?? 'managed_child_unknown',
            summary: boundedDiagnosticText(failure?.message ?? 'No managed-child failure is linked.'),
            observed: failure?.stage === 'managed_child',
            ...(failure?.diagnosticHash ? { evidenceHash: failure.diagnosticHash } : {}),
          })
        }
      }
      const priorFacts = new Map((priorDiagnosis?.facts ?? []).map((fact) => [fact.probe, fact] as const))
      for (const fact of facts) priorFacts.set(fact.probe, fact)
      const diagnosis: WorkflowDiagnosis = {
        createdAt: new Date().toISOString(),
        probes: [...new Set([...(priorDiagnosis?.probes ?? []), ...probes])],
        facts: [...priorFacts.values()],
        budget: {
          maxCalls: 2,
          usedCalls: priorCalls + 1,
          maxProbes: 8,
          usedProbes: priorProbeUses + probes.length,
          maxRecordReads: 4,
          usedRecordReads: 1 + (reviews.length > 0 ? 1 : 0) + (installation ? 1 : 0),
        },
      }
      workflow.lastDiagnosis = diagnosis
      await this.checkpoint(workflow)
      return await this.view(workflow, resolution, { diagnosis, skipLinkedReads: true })
    })
  }

  protected async runUntilPark(
    workflow: WorkflowRecord,
    exec: ToolRunContext,
    guardGeneration?: number,
    resolution?: WorkflowView['resolution'],
  ): Promise<WorkflowView> {
    if (!resolution && workflow.resolutionId) {
      resolution = await this.host.getResolution(workflow.resolutionId)
    }
    try {
      while (true) {
        throwIfAborted(exec.signal)
        await this.checkpoint(workflow)
        this.syncGuard(workflow, exec, guardGeneration, resolution)

        if (MODEL_CONTROL_NODES.has(workflow.cursor)) {
          if (!resolution && workflow.resolutionId) {
            resolution = await this.host.getResolution(workflow.resolutionId)
          }
          if (!resolution) throw new EvolutionError('invalid_input', 'Discovery checkpoint is missing a resolution')
          workflow.status = 'interrupted'
          delete workflow.interrupt
          if (workflow.cursor === 'await_modify_work') {
            this.creationGuard.setConstructionRoot(exec.agent, workflow.pendingPath)
            await this.checkpoint(workflow)
            this.syncGuard(workflow, exec, guardGeneration, resolution)
            return await this.view(workflow, resolution)
          }
          workflow.discoveryPool = candidateSnapshotFor(
            resolution,
            excludedCandidateIds(workflow),
            DISCOVERY_POOL_MAX,
          )
          workflow.discoveryBudget ??= discoveryBudget()
          delete workflow.candidateSnapshot
          this.clearWorkflowGrant(workflow)
          this.creationGuard.setConstructionRoot(exec.agent, undefined)
          this.creationGuard.invalidateExecutionLease(exec.agent)
          await this.checkpoint(workflow)
          this.syncGuard(workflow, exec, guardGeneration, resolution)
          return await this.view(workflow, resolution)
        }

        if (INTERRUPT_NODES.has(workflow.cursor)) {
          this.creationGuard.setConstructionRoot(exec.agent, undefined)
          if (workflow.cursor === 'await_clarification') {
            this.creationGuard.invalidateExecutionLease(exec.agent)
            await this.issueClarificationInterrupt(workflow, exec)
            this.syncGuard(workflow, exec, guardGeneration, undefined)
            return await this.view(workflow, undefined)
          }
          if (!resolution && workflow.resolutionId) {
            resolution = await this.host.getResolution(workflow.resolutionId)
          }
          if (!resolution) {
            throw new EvolutionError('invalid_input', 'Workflow interrupt is missing a resolution')
          }
          if (!workflow.candidateSnapshot) {
            workflow.candidateSnapshot = candidateSnapshotFor(resolution, excludedCandidateIds(workflow))
          }
          if (workflow.cursor === 'await_selection' || workflow.cursor === 'await_confirmation') {
            this.creationGuard.invalidateExecutionLease(exec.agent)
            if (workflow.actionCommitment?.requestedAction === 'use_this') {
              this.clearWorkflowGrant(workflow)
            }
          }
          const reviews = await this.reviewsForWorkflow(workflow)
          workflow.status = 'interrupted'
          const installProfiles = workflow.cursor === 'await_confirmation'
            ? await this.host.listInstallProfiles?.() ?? []
            : []
          const managedActionsAvailable = workflow.cursor === 'await_confirmation'
            ? await this.host.managedWorkAvailable?.(exec as WorkflowExec) ?? true
            : true
          const base = interruptPayload(workflow.cursor, resolution, reviews, {
            ...(workflow.lastFailure ? { lastFailure: workflow.lastFailure } : {}),
            ...(installProfiles.length > 0 ? { installProfiles } : {}),
            ...(workflow.pendingPath ? { pendingPath: workflow.pendingPath } : {}),
            workflow,
            managedActionsAvailable,
          })
          const sessionId = workflow.ownerSessionId ?? ownerSessionId(exec.agent)
          if (!sessionId) {
            throw new EvolutionError('invalid_input', 'Cannot issue interrupt without an owner session')
          }
          const validAfterTurnId = this.creationGuard.currentTurnId(exec.agent) ?? `turn_${'0'.repeat(24)}`
          const snapshotDigest = snapshotDigestFor(base.kind, resolution, reviews, workflow)
          workflow.bootId = this.creationGuard.bootId
          workflow.ownerSessionId = sessionId
          workflow.interrupt = {
            ...base,
            interruptId: newInterruptId({
              ownerSessionId: sessionId,
              bootId: this.creationGuard.bootId,
              validAfterTurnId,
              snapshotDigest,
            }),
            ownerSessionId: sessionId,
            bootId: this.creationGuard.bootId,
            validAfterTurnId,
            snapshotDigest,
          }
          await this.checkpoint(workflow)
          this.syncGuard(workflow, exec, guardGeneration, resolution)
          return await this.view(workflow, resolution)
        }

        if (TERMINAL_NODES.has(workflow.cursor)) {
          this.creationGuard.setConstructionRoot(exec.agent, undefined)
          this.settleTerminalGrant(workflow, exec)
          await this.host.releaseManagedSource?.(workflow, exec as WorkflowExec)
          if (workflow.cursor === 'recovery_required') {
            await this.issueRecoveryInterrupt(workflow, exec)
            this.syncGuard(workflow, exec, guardGeneration, resolution)
            return await this.view(workflow, resolution, { status: 'parked', alreadyWaiting: true })
          }
          this.markInstallCompletion(workflow, exec)
          workflow.status = 'completed'
          delete workflow.interrupt
          await this.checkpoint(workflow)
          this.syncGuard(workflow, exec, guardGeneration, resolution)
          return await this.view(workflow, resolution)
        }

        workflow.status = 'running'
        const result = await executeNode(workflow.cursor, {
          host: this.host,
          workflow,
          exec: exec as WorkflowExec,
          ...(resolution ? { resolution } : {}),
        })
        if (result.resolution) resolution = result.resolution
        if (result.node === 'await_discovery' && result.resolution) {
          workflow.discoveryPool = candidateSnapshotFor(
            result.resolution,
            excludedCandidateIds(workflow),
            DISCOVERY_POOL_MAX,
          )
          workflow.discoveryBudget ??= discoveryBudget()
        } else if (result.node === 'review_github' && result.resolution && !workflow.candidateSnapshot) {
          workflow.candidateSnapshot = candidateSnapshotFor(result.resolution, excludedCandidateIds(workflow))
        }
        if (result.review) {
          workflow.lastReviewId = result.review.id
          workflow.lineageTipReviewId = result.review.id
          registerReviewedCandidate(workflow, result.review)
        }
        if (result.reviews) {
          for (const review of result.reviews) {
            registerReviewedCandidate(workflow, review)
          }
          const reviewed = new Set(workflow.reviewedCandidateIds ?? [])
          workflow.reviewQueue = (workflow.reviewQueue ?? []).filter((id) => !reviewed.has(id))
          const first = result.reviews[0]
          if (first) workflow.lastReviewId = first.id
        }
        if (result.reviewFailures) {
          workflow.reviewFailures = result.reviewFailures.map((failure) => ({
            candidateId: workflow.candidateSnapshot?.find((item) => item.repository?.toLowerCase()
              === failure.repository.toLowerCase())?.id ?? candidateId('remote', failure.repository),
            code: failure.code,
            message: failure.message,
          }))
        }
        if (result.installation) workflow.lastInstallationId = result.installation.id
        if (result.kind === 'next') {
          workflow.cursor = result.node
          continue
        }
        workflow.cursor = result.node
        this.creationGuard.setConstructionRoot(exec.agent, undefined)
        this.settleTerminalGrant(workflow, exec)
        await this.host.releaseManagedSource?.(workflow, exec as WorkflowExec)
        if (workflow.cursor === 'recovery_required') {
          await this.issueRecoveryInterrupt(workflow, exec)
          this.syncGuard(workflow, exec, guardGeneration, resolution)
          return await this.view(workflow, resolution, { status: 'parked', alreadyWaiting: true })
        }
        this.markInstallCompletion(workflow, exec)
        workflow.status = 'completed'
        delete workflow.interrupt
        await this.checkpoint(workflow)
        this.syncGuard(workflow, exec, guardGeneration, resolution)
        return await this.view(workflow, resolution)
      }
    } catch (error) {
      this.creationGuard.setConstructionRoot(exec.agent, undefined)
      this.creationGuard.invalidateExecutionLease(exec.agent)
      await this.host.releaseManagedSource?.(workflow, exec as WorkflowExec).catch(() => undefined)
      workflow.status = 'failed'
      workflow.error = {
        code: error instanceof EvolutionError ? error.code : 'command_failed',
        message: error instanceof Error ? error.message : String(error),
      }
      await this.checkpoint(workflow).catch(() => undefined)
      throw error
    }
  }
}
