import { randomUUID } from 'node:crypto'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { POLICY_VERSION, type ResolutionAuthorization, type ResumeInput } from '../contracts.js'
import type { CreationGuard } from '../creation-guard.js'
import { EvolutionError } from '../errors.js'
import { nextStepForAuthorization } from '../lifecycle/decide.js'
import { validateResume } from '../lifecycle/decide.js'
import { hashObject } from '../state/hashes.js'
import type { StateStore } from '../state/store.js'
import {
  INTERRUPT_NODES,
  TERMINAL_NODES,
  isInterruptKind,
  isWorkflowOptionId,
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

export class WorkflowEngine {
  private readonly inflight = new Set<string>()

  constructor(
    private readonly store: StateStore,
    private readonly creationGuard: CreationGuard,
    private readonly host: WorkflowHost,
  ) {}

  async start(requirement: string, exec: ToolRunContext): Promise<WorkflowView> {
    const now = new Date().toISOString()
    const workflow: WorkflowRecord = {
      schemaVersion: 1,
      id: newWorkflowId(requirement),
      policyVersion: POLICY_VERSION,
      createdAt: now,
      updatedAt: now,
      requirement,
      status: 'running',
      cursor: 'resolve_local',
      generation: 1,
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
      if (!isWorkflowOptionId(input.optionId)) {
        throw new EvolutionError('invalid_input', 'option_id is not a known workflow option', { optionId: input.optionId })
      }
      if (!workflow.resolutionId) {
        throw new EvolutionError('invalid_input', 'This workflow has no resolution to resume')
      }
      const resolution = await this.host.getResolution(workflow.resolutionId)
      const resume = validateResume({
        guard: this.creationGuard,
        agent: exec.agent,
        interrupt: workflow.interrupt,
        userMessage: input.userMessage,
        optionId: input.optionId,
        remotes: resolution.remoteCandidates,
        ...(input.repositories !== undefined ? { repositories: input.repositories } : {}),
        ...(input.path !== undefined ? { path: input.path } : {}),
        ...(input.ref !== undefined ? { ref: input.ref } : {}),
        ...(input.reviewId !== undefined ? { reviewId: input.reviewId } : {}),
        ...(input.targetProfile !== undefined ? { targetProfile: input.targetProfile } : {}),
        ...(input.retention !== undefined ? { retention: input.retention } : {}),
        ...(input.verificationTask !== undefined ? { verificationTask: input.verificationTask } : {}),
        ...(input.verificationExpectedText !== undefined ? { verificationExpectedText: input.verificationExpectedText } : {}),
      })

      const latest = await this.store.getWorkflow(workflow.id)
      if (latest.generation !== workflow.generation || latest.status !== 'interrupted') {
        throw new EvolutionError('invalid_input', 'This workflow is already running or has moved on')
      }
      latest.generation += 1
      latest.status = 'running'
      delete latest.lastFailure
      latest.pendingRepositories = resume.repositories
      if (resume.ref) latest.pendingRef = resume.ref
      else delete latest.pendingRef
      if (resume.path) latest.pendingPath = resume.path
      else delete latest.pendingPath
      if (resume.install) latest.pendingInstall = resume.install
      else delete latest.pendingInstall
      latest.forceRemoteDiscovery = resume.optionId === 'search_more'
      const review = resume.optionId === 'use_this' || resume.optionId === 'modify_this' || resume.optionId === 'resume_modify'
        ? await this.host.latestReview(resolution.id, resume.reviewId ?? latest.lineageTipReviewId ?? latest.lastReviewId)
        : undefined
      const nextResolution = await this.host.applyDecision(resolution, resume, review)
      if (resume.optionId === 'modify_this' && review) {
        latest.lineageTipReviewId = review.id
      }
      latest.cursor = transition(latest.cursor, resume.optionId)
      delete latest.interrupt
      return await this.runUntilPark(latest, exec, undefined, nextResolution)
    })
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
          workflow.interrupt = interruptPayload(workflow.cursor, resolution, review, {
            ...(workflow.lastFailure ? { lastFailure: workflow.lastFailure } : {}),
            ...(installProfiles.length > 0 ? { installProfiles } : {}),
          })
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
