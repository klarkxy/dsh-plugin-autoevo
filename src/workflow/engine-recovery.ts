import { realpath } from 'node:fs/promises'
import path from 'node:path'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  DEFAULT_REQUEST_INTENT,
  POLICY_VERSION,
  type RequestIntent,
} from '../contracts.js'
import { EvolutionError } from '../errors.js'
import { normalizeRequirement, ownerSessionId, sessionCwd } from '../host-identity.js'
import { parseRequestIntent } from '../resolver/intent.js'
import { hashObject } from '../state/hashes.js'
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
  cleanup: 'not_required' | 'already_removed' | 'removed'
  restartRequired: boolean
  installationId?: string
}

const RETRYABLE_PREAUTHORIZATION_CURSORS = new Set<WorkflowRecord['cursor']>([
  'resolve_local',
  'discover_remote',
  'ensure_market',
  'await_discovery',
  'await_selection',
  'review_github',
  'review_existing',
])

function normalizedAbsolutePath(value: string): string {
  const normalized = path.resolve(value).normalize('NFKC')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isStateId(value: unknown, prefix: 'workflow' | 'installation'): value is string {
  return typeof value === 'string'
    && value.startsWith(`${prefix}_`)
    && /^[a-z]+_[a-f0-9]{16,64}$/u.test(value)
}

function isAbsoluteWorkflowPath(value: string): boolean {
  return path.isAbsolute(value) || path.win32.isAbsolute(value) || path.posix.isAbsolute(value)
}

function invalidCommittedRestart(): EvolutionError {
  return new EvolutionError('invalid_input', 'Committed recovery restart plan is malformed; no child workflow was started')
}

function restartRequiredForRetention(retention: unknown): boolean {
  if (retention !== 'temporary' && retention !== 'persistent') {
    throw new EvolutionError(
      'invalid_input',
      'Recovery installation retention is malformed; no cleanup or child workflow was started',
    )
  }
  return retention === 'persistent'
}

export abstract class WorkflowEngineRecovery extends WorkflowEngineDriver {
  async recover(input: WorkflowRecoveryInput, exec: ToolRunContext): Promise<WorkflowView> {
    let restart: RestartPlan | undefined
    const lockedView = await this.withLock(input.workflowId, async () => {
      const workflow = await this.awaitPreEffect(
        () => this.store.getWorkflow(input.workflowId),
        exec.signal,
      )
      this.assertSameOwner(workflow, exec)
      const committedRestart = this.committedRestartPlan(workflow)
      if (committedRestart) {
        const child = await this.committedRestartChildView(committedRestart, exec)
        if (child) return child
        restart = committedRestart
        return undefined
      }
      if (workflow.policyVersion !== POLICY_VERSION && !this.isCompletedCleanup(workflow)) {
        await this.invalidateLegacyPolicyWorkflow(workflow, exec)
        return await this.view(workflow, undefined, {}, exec.signal)
      }
      if (this.isSealedRecovery(workflow)) {
        return await this.recoverSealedInterrupt(workflow, input, exec, (next) => { restart = next })
      }
      if (this.isCompletedCleanup(workflow)) {
        return await this.recoverCompletedInstallation(workflow, input, exec, (next) => { restart = next })
      }
      throw new EvolutionError('invalid_input', 'Workflow is not waiting for a recovery decision')
    })
    if (!restart) return lockedView!
    await this.assertCommittedCleanupProof(restart, exec)
    await this.assertRestartPublicationCwd(restart, exec)
    exec.signal?.throwIfAborted()
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

  private committedRestartPlan(workflow: WorkflowRecord): RestartPlan | undefined {
    const rawRecovery: unknown = workflow.recovery
    if (rawRecovery === undefined) return undefined
    if (!isPlainObject(rawRecovery)) throw invalidCommittedRestart()
    const allowedRecoveryKeys = new Set([
      'action',
      'hostTurnId',
      'cleanup',
      'installationId',
      'restartRequired',
      'restartedAsWorkflowId',
      'restart',
      'completedAt',
    ])
    if (Object.keys(rawRecovery).some((key) => !allowedRecoveryKeys.has(key))
      || workflow.status !== 'completed'
      || rawRecovery.action !== 'cleanup_and_restart'
      || typeof rawRecovery.hostTurnId !== 'string'
      || !rawRecovery.hostTurnId
      || (rawRecovery.cleanup !== 'not_required'
        && rawRecovery.cleanup !== 'already_removed'
        && rawRecovery.cleanup !== 'removed')
      || typeof rawRecovery.restartRequired !== 'boolean'
      || !isStateId(rawRecovery.restartedAsWorkflowId, 'workflow')
      || rawRecovery.restartedAsWorkflowId === workflow.id
      || typeof rawRecovery.completedAt !== 'string'
      || !rawRecovery.completedAt
      || !workflow.ownerSessionId) {
      throw invalidCommittedRestart()
    }
    const installationId = rawRecovery.installationId
    if ((rawRecovery.cleanup === 'not_required' && installationId !== undefined)
      || (rawRecovery.cleanup !== 'not_required' && !isStateId(installationId, 'installation'))
      || (rawRecovery.cleanup === 'not_required' && rawRecovery.restartRequired !== false)
      || installationId !== this.installationReceiptId(workflow)) {
      throw invalidCommittedRestart()
    }
    const restart = rawRecovery.restart
    if (!isPlainObject(restart)
      || Object.keys(restart).some((key) => !['requirement', 'normalized', 'cwd', 'intent'].includes(key))
      || typeof restart.requirement !== 'string'
      || !normalizeRequirement(restart.requirement)
      || typeof restart.normalized !== 'string'
      || normalizeRequirement(restart.requirement) !== restart.normalized
      || typeof restart.cwd !== 'string'
      || !restart.cwd
      || !isAbsoluteWorkflowPath(restart.cwd)) {
      throw invalidCommittedRestart()
    }
    let intent: RequestIntent
    try {
      intent = parseRequestIntent(restart.intent)
      if (hashObject(intent) !== hashObject(restart.intent)) throw invalidCommittedRestart()
    } catch {
      throw invalidCommittedRestart()
    }
    return {
      requirement: restart.requirement,
      normalized: restart.normalized,
      sessionId: workflow.ownerSessionId,
      cwd: restart.cwd,
      intent,
      oldWorkflowId: workflow.id,
      workflowId: rawRecovery.restartedAsWorkflowId,
      cleanup: rawRecovery.cleanup,
      restartRequired: rawRecovery.restartRequired,
      ...(typeof installationId === 'string' ? { installationId } : {}),
    }
  }

  private async committedRestartChildView(
    plan: RestartPlan,
    exec: ToolRunContext,
  ): Promise<WorkflowView | undefined> {
    return await this.withLock(plan.workflowId, async () => {
      let child: WorkflowRecord
      try {
        child = await this.awaitPreEffect(() => this.store.getWorkflow(plan.workflowId), exec.signal)
      } catch (error) {
        if (error instanceof EvolutionError && error.code === 'not_found') return undefined
        throw error
      }
      if (!child.cwd || !child.intent) {
        throw new EvolutionError('invalid_input', 'Committed recovery child is missing its fixed workflow identity')
      }
      const [childCwd, planCwd] = await this.awaitPreEffect(
        async () => await Promise.all([
          this.canonicalWorkflowCwd(child.cwd!, exec.signal),
          this.canonicalWorkflowCwd(plan.cwd, exec.signal),
        ]),
        exec.signal,
      )
      if (child.recoveredFromWorkflowId !== plan.oldWorkflowId
        || child.ownerSessionId !== plan.sessionId
        || childCwd !== planCwd
        || child.requirement !== plan.requirement
        || child.requirementNormalized !== plan.normalized
        || hashObject(child.intent) !== hashObject(plan.intent)) {
        throw new EvolutionError('invalid_input', 'Committed recovery child does not match its fixed restart plan')
      }
      const safePreAuthorizationFailure = child.status === 'failed'
        && child.error?.code === 'command_failed'
        && RETRYABLE_PREAUTHORIZATION_CURSORS.has(child.cursor)
        && !child.selectionReceipt
        && !child.actionCommitment
        && !child.pendingInstallationId
        && !child.lastInstallationId
        && !child.managedSourceId
        && !child.pendingPath
        && !child.pendingWorkOrder
        && !(child.creatorRecords?.length)
      if (safePreAuthorizationFailure) return undefined
      await this.assertCommittedCleanupProof(plan, exec)
      if (child.status === 'running' && child.bootId !== this.creationGuard.bootId) {
        return await this.settleStaleRunningWorkflow(child, exec)
      }
      return await this.view(child, undefined, {}, exec.signal)
    })
  }

  private async assertCommittedCleanupProof(plan: RestartPlan, exec: ToolRunContext): Promise<void> {
    if (plan.cleanup === 'not_required') {
      if (plan.installationId !== undefined) throw invalidCommittedRestart()
      return
    }
    if (!plan.installationId) throw invalidCommittedRestart()
    const installation = await this.awaitPreEffect(
      () => this.host.getInstallation(plan.installationId!),
      exec.signal,
    )
    const durableRestartRequired = restartRequiredForRetention(installation.retention)
    if (installation.id !== plan.installationId
      || installation.workflowId !== plan.oldWorkflowId
      || installation.removed !== true
      || plan.restartRequired !== durableRestartRequired) {
      throw new EvolutionError(
        'invalid_input',
        'Committed recovery cleanup proof does not match the exact removed parent-owned installation; no child workflow was started',
      )
    }
  }

  private async assertRestartPublicationCwd(plan: RestartPlan, exec: ToolRunContext): Promise<void> {
    const currentCwd = sessionCwd(exec.agent)
    const [caller, fixed] = await this.awaitPreEffect(
      async () => await Promise.all([
        this.canonicalWorkflowCwd(currentCwd, exec.signal),
        this.canonicalWorkflowCwd(plan.cwd, exec.signal),
      ]),
      exec.signal,
    )
    if (caller !== fixed) {
      throw new EvolutionError(
        'invalid_input',
        'Committed recovery must be resumed from its fixed workspace before child publication',
      )
    }
  }

  protected async resolveWorkflowRealpath(value: string): Promise<string> {
    return await realpath(value)
  }

  protected async canonicalWorkflowCwd(value: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    const absolute = normalizedAbsolutePath(value)
    try {
      const canonical = normalizedAbsolutePath(await this.resolveWorkflowRealpath(absolute))
      signal?.throwIfAborted()
      return canonical
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return absolute
      throw error
    }
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
  ): Promise<WorkflowView | undefined> {
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
      return await this.view(workflow, undefined, { status: 'parked', alreadyWaiting: true }, exec.signal)
    }
    this.creationGuard.previewDecisionTurn(exec.agent, interrupt)
    const installationId = this.installationReceiptId(workflow)
    const linkedInstallation = installationId
      ? await this.awaitPreEffect(() => this.host.getInstallation(installationId), exec.signal)
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
  ): Promise<WorkflowView | undefined> {
    if (input.interruptId) {
      throw new EvolutionError(
        'invalid_input',
        'Completed-install restart is driven by a fresh explicit user request; omit interrupt_id and do not reuse a recovery interrupt',
      )
    }
    const turnId = this.creationGuard.currentTurnId(exec.agent)
    if (!turnId || turnId === workflow.completionTurnId) {
      return await this.view(workflow, undefined, { status: 'parked', alreadyWaiting: true }, exec.signal)
    }
    if (workflow.policyVersion !== POLICY_VERSION && !this.creationGuard.lastUserMessage(exec.agent)) {
      throw new EvolutionError('invalid_input', 'Legacy completed-install cleanup requires the current top-level user message before a fresh current-policy workflow can start')
    }
    if (!this.installationReceiptId(workflow)) {
      throw new EvolutionError('invalid_input', 'Completed-install restart requires the workflow-linked installation receipt; no cleanup was attempted')
    }
    const linkedInstallation = await this.requireOwnedLinkedInstallation(workflow, exec)
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

  private async requireOwnedLinkedInstallation(workflow: WorkflowRecord, exec: ToolRunContext) {
    const installationId = this.installationReceiptId(workflow)
    if (!installationId) return undefined
    const linkedInstallation = await this.awaitPreEffect(
      () => this.host.getInstallation(installationId),
      exec.signal,
    )
    if (linkedInstallation.workflowId !== workflow.id || linkedInstallation.id !== installationId) {
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
    const installationId = this.installationReceiptId(workflow)
    if (linkedInstallation && installationId) {
      const durableRestartRequired = restartRequiredForRetention(linkedInstallation.retention)
      if (linkedInstallation.removed) {
        cleanup = 'already_removed'
        restartRequired = durableRestartRequired
      } else {
        const removal = await this.host.cleanupInstallation!(installationId, exec as WorkflowExec)
        if (!removal.removed || removal.installationId !== installationId) {
          throw new EvolutionError('command_failed', 'Host cleanup did not remove the exact linked installation receipt')
        }
        cleanup = 'removed'
        restartRequired = durableRestartRequired
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
  ): Promise<WorkflowView | undefined> {
    await this.host.releaseManagedSource?.(workflow, this.cleanupExec(exec))
    const sessionId = ownerSessionId(exec.agent)!
    const legacy = workflow.policyVersion !== POLICY_VERSION
    const currentMessage = legacy ? this.creationGuard.lastUserMessage(exec.agent) : undefined
    const requirement = currentMessage ?? workflow.requirement
    const normalized = normalizeRequirement(requirement)
    const cwd = workflow.cwd ?? sessionCwd(exec.agent)
    const restartedAsWorkflowId = newWorkflowId(requirement)
    workflow.status = 'completed'
    workflow.generation += 1
    if (input.consumeInterruptId) {
      workflow.consumedInterruptIds = [...(workflow.consumedInterruptIds ?? []), input.consumeInterruptId]
    }
    delete workflow.interrupt
    const installationId = this.installationReceiptId(workflow)
    workflow.recovery = {
      action: 'cleanup_and_restart',
      hostTurnId: input.hostTurnId,
      cleanup: input.cleanup,
      ...(installationId ? { installationId } : {}),
      restartRequired: input.restartRequired,
      restartedAsWorkflowId,
      restart: {
        requirement,
        normalized,
        cwd,
        intent: legacy ? DEFAULT_REQUEST_INTENT : (workflow.intent ?? DEFAULT_REQUEST_INTENT),
      },
      completedAt: new Date().toISOString(),
    }
    await this.checkpoint(workflow)
    setRestart({
      requirement,
      normalized,
      sessionId,
      cwd,
      intent: legacy ? DEFAULT_REQUEST_INTENT : (workflow.intent ?? DEFAULT_REQUEST_INTENT),
      oldWorkflowId: workflow.id,
      workflowId: restartedAsWorkflowId,
      cleanup: input.cleanup,
      restartRequired: input.restartRequired,
      ...(installationId ? { installationId } : {}),
    })
    return undefined
  }
}
