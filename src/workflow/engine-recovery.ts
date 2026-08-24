import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  DEFAULT_REQUEST_INTENT,
  type RequestIntent,
} from '../contracts.js'
import { EvolutionError } from '../errors.js'
import { normalizeRequirement, ownerSessionId, sessionCwd } from '../host-identity.js'
import {
  COMPLETED_CLEANUP_NODES,
  INSTALL_SUCCESS_OUTCOMES,
  type WorkflowExec,
  type WorkflowHost,
  type WorkflowRecord,
  type WorkflowRecoveryInput,
  type WorkflowView,
} from './contracts.js'
import { newWorkflowId } from './candidates.js'
import { WorkflowEngineDriver } from './engine-driver.js'

interface RestartPlan {
  requirement: string
  normalized: string
  sessionId: string
  cwd: string
  intent: RequestIntent
  oldWorkflowId: string
  workflowId: string
}

export abstract class WorkflowEngineRecovery extends WorkflowEngineDriver {
  async recover(input: WorkflowRecoveryInput, exec: ToolRunContext): Promise<WorkflowView> {
    let restart: RestartPlan | undefined
    const lockedView = await this.withLock(input.workflowId, async () => {
      const workflow = await this.store.getWorkflow(input.workflowId)
      this.assertOwner(workflow, exec)
      if (this.isSealedRecovery(workflow)) {
        return await this.recoverSealedInterrupt(workflow, input, exec, (next) => { restart = next })
      }
      if (this.isCompletedCleanup(workflow)) {
        return await this.recoverCompletedInstallation(workflow, input, exec, (next) => { restart = next })
      }
      throw new EvolutionError('invalid_input', 'Workflow is not waiting for a recovery decision')
    })
    if (!restart) return lockedView
    return await this.startFresh(
      restart.requirement,
      restart.normalized,
      restart.sessionId,
      restart.cwd,
      exec,
      restart.intent,
      restart.oldWorkflowId,
      restart.workflowId,
    )
  }

  private isSealedRecovery(workflow: WorkflowRecord): boolean {
    return workflow.cursor === 'recovery_required'
      && workflow.status === 'interrupted'
      && workflow.interrupt?.kind === 'await_recovery'
  }

  private isCompletedCleanup(workflow: WorkflowRecord): boolean {
    return workflow.status === 'completed'
      && COMPLETED_CLEANUP_NODES.has(workflow.cursor)
      && !workflow.recovery
  }

  private async recoverSealedInterrupt(
    workflow: WorkflowRecord,
    input: WorkflowRecoveryInput,
    exec: ToolRunContext,
    setRestart: (restart: RestartPlan) => void,
  ): Promise<WorkflowView> {
    const interrupt = workflow.interrupt
    if (!interrupt || interrupt.kind !== 'await_recovery') {
      throw new EvolutionError('invalid_input', 'Workflow is not waiting for a recovery decision')
    }
    if (!input.interruptId || interrupt.interruptId !== input.interruptId) {
      throw new EvolutionError('invalid_input', 'interrupt_id does not match the current recovery interrupt')
    }
    const expectedRecoveryDigest = this.recoverySnapshotDigest(workflow)
    if (interrupt.snapshotDigest !== expectedRecoveryDigest) {
      throw new EvolutionError('invalid_input', 'Recovery control no longer matches the sealed workflow state; no cleanup was attempted')
    }
    if (interrupt.bootId !== this.creationGuard.bootId || workflow.bootId !== this.creationGuard.bootId) {
      await this.reissueInterrupt(workflow, exec)
      throw new EvolutionError('invalid_input', 'Recovery interrupt was invalidated by a service restart; present the reissued recovery choice and obtain a fresh user confirmation', {
        workflowId: workflow.id,
        interruptId: workflow.interrupt?.interruptId,
      })
    }
    if (this.creationGuard.isAwaitingFreshUserTurn(exec.agent, interrupt)) {
      return await this.view(workflow, undefined, { status: 'parked', alreadyWaiting: true })
    }
    this.creationGuard.previewDecisionTurn(exec.agent, interrupt)
    const linkedInstallation = workflow.lastInstallationId
      ? await this.host.getInstallation(workflow.lastInstallationId)
      : undefined
    if (linkedInstallation?.workflowId !== workflow.id) {
      throw new EvolutionError('invalid_input', 'Linked installation is not owned by this recovery workflow; no cleanup was attempted')
    }
    if (linkedInstallation && !linkedInstallation.removed && !this.host.cleanupInstallation) {
      throw new EvolutionError('invalid_input', 'This workflow host does not support owned installation cleanup')
    }
    const turn = this.creationGuard.consumeDecisionTurn(exec.agent, interrupt)
    const { cleanup, restartRequired } = await this.cleanupOwnedInstallation(workflow, linkedInstallation, exec)
    return await this.finishCleanupAndRestart(workflow, exec, {
      hostTurnId: turn.turnId,
      cleanup,
      restartRequired,
      consumeInterruptId: interrupt.interruptId,
    }, setRestart)
  }

  private async recoverCompletedInstallation(
    workflow: WorkflowRecord,
    input: WorkflowRecoveryInput,
    exec: ToolRunContext,
    setRestart: (restart: RestartPlan) => void,
  ): Promise<WorkflowView> {
    if (input.interruptId) {
      throw new EvolutionError(
        'invalid_input',
        'Completed-install restart is driven by a fresh explicit user request; omit interrupt_id and do not reuse a recovery interrupt',
      )
    }
    const turnId = this.creationGuard.currentTurnId(exec.agent)
    if (!turnId || turnId === workflow.completionTurnId) {
      return await this.view(workflow, undefined, { status: 'parked', alreadyWaiting: true })
    }
    if (!workflow.lastInstallationId) {
      throw new EvolutionError('invalid_input', 'Completed-install restart requires the workflow-linked installation receipt; no cleanup was attempted')
    }
    const linkedInstallation = await this.requireOwnedLinkedInstallation(workflow)
    if (!linkedInstallation) {
      throw new EvolutionError('invalid_input', 'Completed-install restart requires the workflow-linked installation receipt; no cleanup was attempted')
    }
    if (!(INSTALL_SUCCESS_OUTCOMES as readonly string[]).includes(linkedInstallation.installOutcome ?? '')) {
      throw new EvolutionError('invalid_input', 'Completed-install restart requires an unreplaced success receipt; no cleanup was attempted')
    }
    if (!linkedInstallation.removed && !this.host.cleanupInstallation) {
      throw new EvolutionError('invalid_input', 'This workflow host does not support owned installation cleanup')
    }
    const { cleanup, restartRequired } = await this.cleanupOwnedInstallation(workflow, linkedInstallation, exec)
    return await this.finishCleanupAndRestart(workflow, exec, {
      hostTurnId: turnId,
      cleanup,
      restartRequired,
    }, setRestart)
  }

  private async requireOwnedLinkedInstallation(workflow: WorkflowRecord) {
    if (!workflow.lastInstallationId) return undefined
    const linkedInstallation = await this.host.getInstallation(workflow.lastInstallationId)
    if (linkedInstallation.workflowId !== workflow.id || linkedInstallation.id !== workflow.lastInstallationId) {
      throw new EvolutionError('invalid_input', 'Linked installation is not owned by this recovery workflow; no cleanup was attempted')
    }
    return linkedInstallation
  }

  private async cleanupOwnedInstallation(
    workflow: WorkflowRecord,
    linkedInstallation: Awaited<ReturnType<WorkflowHost['getInstallation']>> | undefined,
    exec: ToolRunContext,
  ): Promise<{ cleanup: 'not_required' | 'already_removed' | 'removed'; restartRequired: boolean }> {
    let cleanup: 'not_required' | 'already_removed' | 'removed' = 'not_required'
    let restartRequired = false
    if (linkedInstallation && workflow.lastInstallationId) {
      if (linkedInstallation.removed) {
        cleanup = 'already_removed'
        restartRequired = linkedInstallation.retention === 'persistent'
      } else {
        const removal = await this.host.cleanupInstallation!(workflow.lastInstallationId, exec as WorkflowExec)
        if (!removal.removed || removal.installationId !== workflow.lastInstallationId) {
          throw new EvolutionError('command_failed', 'Host cleanup did not remove the exact linked installation receipt')
        }
        cleanup = 'removed'
        restartRequired = removal.restartRequired
      }
    }
    return { cleanup, restartRequired }
  }

  private async finishCleanupAndRestart(
    workflow: WorkflowRecord,
    exec: ToolRunContext,
    input: {
      hostTurnId: string
      cleanup: 'not_required' | 'already_removed' | 'removed'
      restartRequired: boolean
      consumeInterruptId?: string
    },
    setRestart: (restart: RestartPlan) => void,
  ): Promise<WorkflowView> {
    const sessionId = ownerSessionId(exec.agent)!
    const normalized = workflow.requirementNormalized ?? normalizeRequirement(workflow.requirement)
    const cwd = workflow.cwd ?? sessionCwd(exec.agent)
    const restartedAsWorkflowId = newWorkflowId(workflow.requirement)
    workflow.status = 'completed'
    workflow.generation += 1
    if (input.consumeInterruptId) {
      workflow.consumedInterruptIds = [...(workflow.consumedInterruptIds ?? []), input.consumeInterruptId]
    }
    delete workflow.interrupt
    workflow.recovery = {
      action: 'cleanup_and_restart',
      hostTurnId: input.hostTurnId,
      cleanup: input.cleanup,
      ...(workflow.lastInstallationId ? { installationId: workflow.lastInstallationId } : {}),
      restartRequired: input.restartRequired,
      restartedAsWorkflowId,
      completedAt: new Date().toISOString(),
    }
    await this.checkpoint(workflow)
    setRestart({
      requirement: workflow.requirement,
      normalized,
      sessionId,
      cwd,
      intent: workflow.intent ?? DEFAULT_REQUEST_INTENT,
      oldWorkflowId: workflow.id,
      workflowId: restartedAsWorkflowId,
    })
    return await this.view(workflow)
  }
}
