import { randomUUID } from 'node:crypto'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { POLICY_VERSION, type ResolutionAuthorization, type ResumeInput } from '../contracts.js'
import type { CreationGuard } from '../creation-guard.js'
import { EvolutionError } from '../errors.js'
import {
  newInterruptId,
  normalizeRequirement,
  ownerSessionId,
  sessionCwd,
} from '../host-identity.js'
import { nextStepForAuthorization, resolveDecisionFromHost } from '../lifecycle/decide.js'
import { hashObject } from '../state/hashes.js'
import type { StateStore } from '../state/store.js'
import {
  INTERRUPT_NODES,
  TERMINAL_NODES,
  isInterruptKind,
  type InterruptPayload,
  type WorkflowExec,
  type WorkflowHost,
  type WorkflowRecord,
  type WorkflowView,
} from './contracts.js'
import { executeNode, interruptPayload, transition } from './graph.js'

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new EvolutionError('command_failed', 'Workflow cancelled')
  }
}

function newWorkflowId(requirement: string): string {
  return `workflow_${hashObject({ requirement, at: new Date().toISOString(), nonce: randomUUID() }).slice(0, 24)}`
}

function snapshotDigestFor(
  kind: InterruptPayload['kind'],
  resolution: WorkflowView['resolution'],
  review?: WorkflowView['review'],
  pendingPath?: string,
): string {
  if (kind === 'await_confirmation') {
    if (!review) throw new EvolutionError('invalid_input', 'Confirmation interrupt requires a review snapshot')
    return hashObject({
      kind,
      reviewId: review.id,
      reviewIdentity: review.sourceSnapshot.kind === 'github'
        ? review.sourceSnapshot.commit
        : review.sourceSnapshot.statusHash,
      installSpec: review.installSpec,
      inspectedFiles: review.inspectedFiles,
      manifest: review.manifest,
    })
  }
  if (kind === 'await_modify_work') {
    if (review) {
      return hashObject({
        kind,
        reviewId: review.id,
        reviewIdentity: review.sourceSnapshot.kind === 'github'
          ? review.sourceSnapshot.commit
          : review.sourceSnapshot.statusHash,
        path: pendingPath,
      })
    }
    if (!pendingPath) throw new EvolutionError('invalid_input', 'Create-work interrupt requires a managed source path snapshot')
    return hashObject({ kind, path: pendingPath, resolutionId: resolution?.id })
  }
  if (!resolution) throw new EvolutionError('invalid_input', 'Selection interrupt requires a resolution snapshot')
  return hashObject({
    kind,
    localCandidates: resolution.localCandidates,
    remoteCandidates: resolution.remoteCandidates.map((item) => ({
      repository: item.repository,
      name: item.name,
      stars: item.stars,
      updatedAt: item.updatedAt,
    })),
    remoteDiscoveryComplete: resolution.remoteDiscoveryComplete,
    remoteCandidateSource: resolution.remoteCandidateSource,
  })
}

function isUnfinished(status: WorkflowRecord['status']): boolean {
  return status === 'interrupted' || status === 'running'
}

export class WorkflowEngine {
  private readonly inflight = new Set<string>()

  constructor(
    private readonly store: StateStore,
    private readonly creationGuard: CreationGuard,
    private readonly host: WorkflowHost,
  ) {}

  async start(requirement: string, exec: ToolRunContext): Promise<WorkflowView> {
    const normalized = normalizeRequirement(requirement)
    if (!normalized || normalized.length > 2_000) {
      throw new EvolutionError('invalid_input', 'requirement must contain 1 to 2000 characters')
    }
    const sessionId = ownerSessionId(exec.agent)
    if (!sessionId) {
      throw new EvolutionError('invalid_input', 'A live Agent session identity is required to start a workflow')
    }
    const cwd = sessionCwd(exec.agent)
    const existing = await this.findReusableWorkflow(sessionId, cwd, normalized)
    if (existing) {
      return await this.withLock(existing.id, async () => {
        const latest = await this.store.getWorkflow(existing.id)
        if (latest.bootId !== this.creationGuard.bootId && latest.status === 'interrupted' && latest.interrupt) {
          await this.reissueInterrupt(latest, exec)
        }
        let resolution = latest.resolutionId ? await this.host.getResolution(latest.resolutionId) : undefined
        return await this.view(latest, resolution)
      })
    }

    const now = new Date().toISOString()
    const workflow: WorkflowRecord = {
      schemaVersion: 1,
      id: newWorkflowId(requirement),
      policyVersion: POLICY_VERSION,
      createdAt: now,
      updatedAt: now,
      requirement,
      requirementNormalized: normalized,
      cwd,
      ownerSessionId: sessionId,
      bootId: this.creationGuard.bootId,
      status: 'running',
      cursor: 'resolve_local',
      generation: 1,
      consumedInterruptIds: [],
    }
    const guardGeneration = this.creationGuard.beginResolution(exec.agent)
    return await this.withLock(workflow.id, () => this.runUntilPark(workflow, exec, guardGeneration))
  }

  async resume(input: ResumeInput, exec: ToolRunContext): Promise<WorkflowView> {
    return await this.withLock(input.workflowId, async () => {
      const workflow = await this.store.getWorkflow(input.workflowId)
      if (workflow.policyVersion !== POLICY_VERSION) {
        throw new EvolutionError('invalid_input', 'This workflow predates the current policy; start capability_workflow again')
      }
      if (workflow.status !== 'interrupted' || !workflow.interrupt || !INTERRUPT_NODES.has(workflow.cursor)) {
        throw new EvolutionError('invalid_input', 'This workflow is not waiting for a user decision', {
          status: workflow.status,
          cursor: workflow.cursor,
        })
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

      const sessionId = ownerSessionId(exec.agent)
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
      if (!workflow.resolutionId) {
        throw new EvolutionError('invalid_input', 'This workflow has no resolution to resume')
      }
      const resolution = await this.host.getResolution(workflow.resolutionId)
      const review = workflow.lastReviewId ? await this.host.getReview(workflow.lastReviewId) : undefined
      const expectedDigest = snapshotDigestFor(workflow.interrupt.kind, resolution, review, workflow.pendingPath)
      if (expectedDigest !== workflow.interrupt.snapshotDigest) {
        throw new EvolutionError('invalid_input', 'Interrupt candidate/review snapshot digest mismatch', {
          expected: expectedDigest,
          actual: workflow.interrupt.snapshotDigest,
        })
      }

      const resume = resolveDecisionFromHost({
        guard: this.creationGuard,
        agent: exec.agent,
        interrupt: workflow.interrupt,
        remotes: resolution.remoteCandidates,
        requirement: workflow.requirement,
        ...(review ? { reviewId: review.id } : {}),
      })

      const latest = await this.store.getWorkflow(workflow.id)
      if (latest.generation !== workflow.generation || latest.status !== 'interrupted') {
        throw new EvolutionError('invalid_input', 'This workflow is already running or has moved on')
      }
      latest.generation += 1
      latest.status = 'running'
      delete latest.lastFailure
      latest.consumedInterruptIds = [...(latest.consumedInterruptIds ?? []), input.interruptId]
      latest.pendingRepositories = resume.repositories
      if (resume.ref) latest.pendingRef = resume.ref
      else delete latest.pendingRef
      if (resume.path) latest.pendingPath = resume.path
      else delete latest.pendingPath
      if (resume.install) latest.pendingInstall = resume.install
      else delete latest.pendingInstall
      latest.forceRemoteDiscovery = resume.optionId === 'search_more'
      const decisionReview = resume.optionId === 'use_this' || resume.optionId === 'modify_this'
        ? await this.host.latestReview(resolution.id, resume.reviewId ?? latest.lineageTipReviewId ?? latest.lastReviewId)
        : undefined
      const nextResolution = await this.host.applyDecision(resolution, resume, decisionReview)
      if (resume.optionId === 'modify_this' && decisionReview) {
        latest.lineageTipReviewId = decisionReview.id
      }
      latest.cursor = transition(latest.cursor, resume.optionId)
      delete latest.interrupt
      return await this.runUntilPark(latest, exec, undefined, nextResolution)
    })
  }

  private async findReusableWorkflow(
    sessionId: string,
    cwd: string,
    requirementNormalized: string,
  ): Promise<WorkflowRecord | undefined> {
    const workflows = await this.store.listWorkflows()
    const matches = workflows
      .filter((item) => isUnfinished(item.status)
        && item.ownerSessionId === sessionId
        && item.cwd === cwd
        && item.requirementNormalized === requirementNormalized
        && item.policyVersion === POLICY_VERSION)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    return matches[0]
  }

  private async reissueInterrupt(workflow: WorkflowRecord, exec: ToolRunContext): Promise<void> {
    if (!workflow.resolutionId || !INTERRUPT_NODES.has(workflow.cursor)) return
    const resolution = await this.host.getResolution(workflow.resolutionId)
    const review = workflow.lastReviewId ? await this.host.getReview(workflow.lastReviewId) : undefined
    const installProfiles = workflow.cursor === 'await_confirmation'
      ? await this.host.listInstallProfiles?.() ?? []
      : []
    const base = interruptPayload(workflow.cursor, resolution, review, {
      ...(workflow.lastFailure ? { lastFailure: workflow.lastFailure } : {}),
      ...(installProfiles.length > 0 ? { installProfiles } : {}),
      ...(workflow.pendingPath ? { pendingPath: workflow.pendingPath } : {}),
    })
    const sessionId = workflow.ownerSessionId ?? ownerSessionId(exec.agent)
    if (!sessionId) {
      throw new EvolutionError('invalid_input', 'Cannot reissue interrupt without an owner session')
    }
    const validAfterTurnId = this.creationGuard.currentTurnId(exec.agent) ?? `turn_${'0'.repeat(24)}`
    const snapshotDigest = snapshotDigestFor(base.kind, resolution, review, workflow.pendingPath)
    workflow.bootId = this.creationGuard.bootId
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
    workflow.status = 'interrupted'
    await this.checkpoint(workflow)
  }

  private async withLock<T>(id: string, run: () => Promise<T>): Promise<T> {
    if (this.inflight.has(id)) {
      throw new EvolutionError('invalid_input', 'This workflow is already running')
    }
    this.inflight.add(id)
    try {
      return await run()
    } finally {
      this.inflight.delete(id)
    }
  }

  private async runUntilPark(
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

        if (INTERRUPT_NODES.has(workflow.cursor)) {
          if (!resolution && workflow.resolutionId) {
            resolution = await this.host.getResolution(workflow.resolutionId)
          }
          if (!resolution) {
            throw new EvolutionError('invalid_input', 'Workflow interrupt is missing a resolution')
          }
          const review = workflow.lastReviewId
            ? await this.host.getReview(workflow.lastReviewId)
            : undefined
          workflow.status = 'interrupted'
          const installProfiles = workflow.cursor === 'await_confirmation'
            ? await this.host.listInstallProfiles?.() ?? []
            : []
          const base = interruptPayload(workflow.cursor, resolution, review, {
            ...(workflow.lastFailure ? { lastFailure: workflow.lastFailure } : {}),
            ...(installProfiles.length > 0 ? { installProfiles } : {}),
            ...(workflow.pendingPath ? { pendingPath: workflow.pendingPath } : {}),
          })
          const sessionId = workflow.ownerSessionId ?? ownerSessionId(exec.agent)
          if (!sessionId) {
            throw new EvolutionError('invalid_input', 'Cannot issue interrupt without an owner session')
          }
          const validAfterTurnId = this.creationGuard.currentTurnId(exec.agent) ?? `turn_${'0'.repeat(24)}`
          const snapshotDigest = snapshotDigestFor(base.kind, resolution, review, workflow.pendingPath)
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
        if (result.review) {
          workflow.lastReviewId = result.review.id
          workflow.lineageTipReviewId = result.review.id
        }
        if (result.installation) workflow.lastInstallationId = result.installation.id
        if (result.kind === 'next') {
          workflow.cursor = result.node
          continue
        }
        workflow.cursor = result.node
        workflow.status = 'completed'
        delete workflow.interrupt
        await this.checkpoint(workflow)
        this.syncGuard(workflow, exec, guardGeneration, resolution)
        return await this.view(workflow, resolution)
      }
    } catch (error) {
      workflow.status = 'failed'
      workflow.error = {
        code: error instanceof EvolutionError ? error.code : 'command_failed',
        message: error instanceof Error ? error.message : String(error),
      }
      await this.checkpoint(workflow).catch(() => undefined)
      throw error
    }
  }

  private async checkpoint(workflow: WorkflowRecord): Promise<void> {
    workflow.updatedAt = new Date().toISOString()
    await this.store.put('workflows', workflow)
  }

  private syncGuard(
    workflow: WorkflowRecord,
    exec: ToolRunContext,
    guardGeneration: number | undefined,
    resolution?: { authorization?: ResolutionAuthorization },
  ): void {
    const authorization = resolution?.authorization
    if (authorization && exec.agent) {
      if (guardGeneration !== undefined) {
        this.creationGuard.applyResolutionAuthorization(exec.agent, authorization, guardGeneration)
      } else {
        this.creationGuard.applyReviewAuthorization(exec.agent, authorization)
      }
    }
    this.creationGuard.setWaiting(exec.agent, isInterruptKind(workflow.cursor) ? workflow.cursor : undefined)
  }

  private async view(workflow: WorkflowRecord, resolution?: WorkflowView['resolution']): Promise<WorkflowView> {
    const current = resolution ?? (workflow.resolutionId ? await this.host.getResolution(workflow.resolutionId) : undefined)
    const review = workflow.lastReviewId ? await this.host.getReview(workflow.lastReviewId) : undefined
    const installation = workflow.lastInstallationId
      ? await this.host.getInstallation(workflow.lastInstallationId)
      : undefined
    const baseNextStep = current?.authorization
      ? nextStepForAuthorization(workflow.requirement, current.authorization)
      : current?.nextStep
    const nextStep = workflow.lastFailure
      ? [baseNextStep, `Previous install failed (${workflow.lastFailure.code}): ${workflow.lastFailure.message}`]
        .filter(Boolean)
        .join(' ')
      : baseNextStep
    return JSON.parse(JSON.stringify({
      workflow,
      ...(current ? { resolution: current } : {}),
      ...(review ? { review } : {}),
      ...(installation ? { installation } : {}),
      ...(nextStep ? { nextStep } : {}),
    })) as WorkflowView
  }
}
