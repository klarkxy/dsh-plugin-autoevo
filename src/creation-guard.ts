import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PreToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type {
  ActionCommitment,
  ResolutionAuthorization,
  ResolutionRecord,
  ReviewRecord,
  SelectionReceipt,
} from './contracts.js'
import { EvolutionError } from './errors.js'
import { OUTSIDE_EVOLUTION_MODE_DENIAL } from './evolution-contracts.js'
import { newBootId, newTurnId, ownerSessionId } from './host-identity.js'
import { isRecord } from './internal-utils.js'
import { assertUseThisReceipt } from './lifecycle/decide.js'
import {
  assertDirectUseAllowed,
  frozenManifestDigest,
  reviewCandidateDigest,
  reviewSnapshotDigest,
  type InstallCommitmentBinding,
} from './review/index.js'
import { hashObject } from './state/hashes.js'
import type { InterruptPayload } from './workflow/contracts.js'

/** Minimum Host-owned boundary needed to require a fresh, session-bound user turn. */
export type DecisionTurnBoundary = Pick<
  InterruptPayload,
  'ownerSessionId' | 'bootId' | 'validAfterTurnId'
>

interface AgentGateState {
  generation: number
  activeResolutionId?: string
  authorization?: ResolutionAuthorization
  lastUserMessage?: string
  currentMessageId?: string
  currentTurnId?: string
  turnSequence: number
  seenMessageIds: Set<string>
  consumedMessageIds: Set<string>
  consumedTurnIds: Set<string>
  waitingKind?: 'await_clarification' | 'await_discovery' | 'await_selection' | 'await_confirmation' | 'await_modify_work' | 'await_recovery'
  interruptWatermarkTurnId?: string
  sessionId?: string
  selectionReceipt?: SelectionReceipt
  actionCommitment?: ActionCommitment
  constructionRoot?: string
}

const FIND_PLUGIN_TOOL = 'find_dsh_plugin'
const WEB_SEARCH_TOOL = 'web_search'
const ASK_USER_TOOLS = new Set(['ask_user', 'ask_user_question'])
const SKIP_USER_TEXT = /^(?:Current runtime context\.|<system-reminder>)/u

export interface UserFacingMessage {
  id?: unknown
  role?: unknown
  source?: unknown
  content?: readonly unknown[]
}

export interface ClaimedHostTurn {
  turnId: string
  messageId: string
  message: string
  sequence: number
}

interface TrustedTopLevelUserMessage extends UserFacingMessage {
  id: string
  role: 'user'
  source: { kind: 'user' }
}

/** Runtime provenance boundary for authority-bearing inbox messages. */
export function isTrustedTopLevelUserMessage(message: unknown): message is TrustedTopLevelUserMessage {
  if (!isRecord(message)) return false
  if (typeof message.id !== 'string' || !message.id.trim()) return false
  if (message.role !== 'user' || !isRecord(message.source)) return false
  return message.source.kind === 'user'
}

function hasExplicitMessageIdentity(message: UserFacingMessage): boolean {
  return message.id !== undefined || message.role !== undefined || message.source !== undefined
}

export function extractUserFacingText(message: UserFacingMessage): string {
  const parts: string[] = []
  for (const block of message.content ?? []) {
    if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') continue
    const classified = block.text.normalize('NFKC').trim()
    if (!classified || SKIP_USER_TEXT.test(classified)) continue
    parts.push(block.text)
  }
  return parts.join('\n')
}

function clearHostGrant(state: AgentGateState): void {
  delete state.selectionReceipt
  delete state.actionCommitment
}

function preservesHostGrant(state: ResolutionAuthorization['state']): boolean {
  return state === 'reuse_local'
    || state === 'use_review'
    || state === 'modify_review'
    || state === 'create_authorized'
    || state === 'stopped'
}

export function isNewCordisDefinition(exec: Pick<ToolExecution, 'name' | 'arguments'>): boolean {
  if (exec.name !== 'cordis_define' || !isRecord(exec.arguments)) return false
  const plugin = exec.arguments.plugin
  return isRecord(plugin) && plugin.kind === 'new'
}

function outsideEvolutionModeReason(): string {
  return OUTSIDE_EVOLUTION_MODE_DENIAL
}

export interface CreationGuardOptions {
  /** True only when agentPresets.serviceFor(agent, 'autoevoEvolutionMode') yields exact marker. */
  isEvolutionMode?: (agent: Agent) => boolean
  /** Service boot identity; interrupts bound to a prior boot are invalidated. */
  bootId?: string
}

/** Runtime-only, fail-closed authorization for AutoEvo parent-session decisions. */
export class CreationGuard {
  private readonly states = new WeakMap<Agent, AgentGateState>()
  private nextGeneration = 0
  readonly bootId: string

  constructor(private readonly options: CreationGuardOptions = {}) {
    this.bootId = options.bootId ?? newBootId()
  }

  beginResolution(agent?: Agent): number | undefined {
    if (!agent) return undefined
    const generation = ++this.nextGeneration
    const prior = this.states.get(agent)
    this.states.set(agent, {
      generation,
      turnSequence: prior?.turnSequence ?? 0,
      seenMessageIds: prior?.seenMessageIds ?? new Set<string>(),
      consumedMessageIds: prior?.consumedMessageIds ?? new Set<string>(),
      consumedTurnIds: prior?.consumedTurnIds ?? new Set<string>(),
      ...(prior?.lastUserMessage ? { lastUserMessage: prior.lastUserMessage } : {}),
      ...(prior?.currentMessageId ? { currentMessageId: prior.currentMessageId } : {}),
      ...(prior?.currentTurnId ? { currentTurnId: prior.currentTurnId } : {}),
      ...(prior?.sessionId ? { sessionId: prior.sessionId } : {}),
    })
    return generation
  }

  rememberUserMessage(agent: Agent | undefined, message: UserFacingMessage): boolean {
    if (!agent) return false
    const explicitIdentity = hasExplicitMessageIdentity(message)
    if (explicitIdentity && !isTrustedTopLevelUserMessage(message)) return false
    const text = extractUserFacingText(message)
    if (!text) return false
    const sessionId = ownerSessionId(agent) ?? 'anonymous'
    const state = this.states.get(agent) ?? {
      generation: 0,
      turnSequence: 0,
      seenMessageIds: new Set<string>(),
      consumedMessageIds: new Set<string>(),
      consumedTurnIds: new Set<string>(),
      sessionId,
    }
    const messageId = isTrustedTopLevelUserMessage(message)
      ? message.id.trim()
      : `legacy_${state.turnSequence + 1}`
    if (state.seenMessageIds.has(messageId)) return false
    state.turnSequence += 1
    state.seenMessageIds.add(messageId)
    state.currentMessageId = messageId
    state.currentTurnId = isTrustedTopLevelUserMessage(message)
      ? `turn_${hashObject({ sessionId, messageId }).slice(0, 24)}`
      : newTurnId(sessionId, state.turnSequence)
    state.lastUserMessage = text
    state.sessionId = sessionId
    this.states.set(agent, state)
    return true
  }

  lastUserMessage(agent: Agent | undefined): string | undefined {
    if (!agent) return undefined
    return this.states.get(agent)?.lastUserMessage
  }

  currentTurnId(agent: Agent | undefined): string | undefined {
    if (!agent) return undefined
    return this.states.get(agent)?.currentTurnId
  }

  setConstructionRoot(agent: Agent | undefined, root: string | undefined): void {
    if (!agent) return
    const state = this.states.get(agent)
    if (!state) return
    if (root && root.trim()) state.constructionRoot = root
    else delete state.constructionRoot
  }

  constructionRoot(agent: Agent | undefined): string | undefined {
    if (!agent) return undefined
    return this.states.get(agent)?.constructionRoot
  }

  /**
   * True when resume must park: no claimed turn, or the claimed turn is the
   * interrupt-issuing turn. Does not consume the turn.
   */
  isAwaitingFreshUserTurn(agent: Agent | undefined, interrupt: DecisionTurnBoundary): boolean {
    if (!agent) return true
    const turnId = this.states.get(agent)?.currentTurnId
    return !turnId || turnId === interrupt.validAfterTurnId
  }

  /**
   * Validate and return the latest host-owned user turn without consuming it.
   * Callers use this to finish all local validation before claiming authority.
   */
  previewDecisionTurn(agent: Agent | undefined, interrupt: DecisionTurnBoundary): ClaimedHostTurn {
    if (!agent) {
      throw new EvolutionError('invalid_input', 'A live Agent session is required to resume a workflow decision')
    }
    const sessionId = ownerSessionId(agent)
    if (!sessionId || sessionId !== interrupt.ownerSessionId) {
      throw new EvolutionError('invalid_input', 'Workflow interrupt belongs to a different owner session', {
        expected: interrupt.ownerSessionId,
        actual: sessionId,
      })
    }
    if (interrupt.bootId !== this.bootId) {
      throw new EvolutionError('invalid_input', 'Workflow interrupt was invalidated by a service restart; present the reissued interrupt and obtain a fresh user confirmation', {
        expectedBootId: this.bootId,
        interruptBootId: interrupt.bootId,
      })
    }
    const state = this.states.get(agent)
    const turnId = state?.currentTurnId
    const messageId = state?.currentMessageId
    const message = state?.lastUserMessage
    if (!state || !turnId || !messageId || !message) {
      throw new EvolutionError('invalid_input', 'No host-claimed user turn is available for this decision')
    }
    if (state.consumedTurnIds.has(turnId) || state.consumedMessageIds.has(messageId)) {
      throw new EvolutionError('invalid_input', 'This host user turn was already consumed by a prior resume (replay rejected)', {
        turnId,
        messageId,
      })
    }
    if (this.isAwaitingFreshUserTurn(agent, interrupt)) {
      throw new EvolutionError('invalid_input', 'Decision requires a fresh user turn after the interrupt was issued (stale/previous-turn rejected)', {
        turnId,
        validAfterTurnId: interrupt.validAfterTurnId,
      })
    }
    return { turnId, messageId, message, sequence: state.turnSequence }
  }

  /**
   * Consume the latest host-owned user turn after all caller-side validation.
   * Rejects missing turns, replay, and stale turns before mutating the ledger.
   */
  consumeDecisionTurn(agent: Agent | undefined, interrupt: DecisionTurnBoundary): ClaimedHostTurn {
    const turn = this.previewDecisionTurn(agent, interrupt)
    const state = agent ? this.states.get(agent) : undefined
    if (!state) throw new EvolutionError('invalid_input', 'No host-claimed user turn is available for this decision')
    // Sequence watermark: turn ids are opaque; also compare via remembered order by requiring inequality with watermark
    // and that a new claim happened after interrupt issuance (caller reissues interrupt with current turn as watermark).
    state.consumedTurnIds.add(turn.turnId)
    state.consumedMessageIds.add(turn.messageId)
    return turn
  }

  /**
   * Host-owned grant. Never accepted from ResumeInput.
   */
  grantHostSelection(
    agent: Agent | undefined,
    receipt: SelectionReceipt,
    commitment: ActionCommitment,
  ): void {
    if (!agent) {
      throw new EvolutionError('invalid_input', 'A live Agent session is required to grant a Host selection')
    }
    const sessionId = ownerSessionId(agent)
    if (!sessionId || sessionId !== receipt.ownerSessionId) {
      throw new EvolutionError('invalid_input', 'Selection receipt belongs to a different owner session', {
        expected: receipt.ownerSessionId,
        actual: sessionId,
      })
    }
    if (receipt.bootId !== this.bootId) {
      throw new EvolutionError('invalid_input', 'Selection grant was invalidated by a service restart', {
        expectedBootId: this.bootId,
        receiptBootId: receipt.bootId,
      })
    }
    if (commitment.selectionReceiptId !== receipt.id || commitment.snapshotDigest !== receipt.snapshotDigest) {
      throw new EvolutionError('invalid_input', 'Action commitment is not bound to this selection receipt')
    }
    const state = this.states.get(agent)
    if (!state || state.currentTurnId !== receipt.hostTurnId) {
      throw new EvolutionError('invalid_input', 'Selection receipt is not bound to the current host user turn', {
        hostTurnId: receipt.hostTurnId,
        currentTurnId: state?.currentTurnId,
      })
    }
    state.selectionReceipt = receipt
    state.actionCommitment = commitment
  }

  invalidateHostGrant(agent: Agent | undefined): void {
    if (!agent) return
    const state = this.states.get(agent)
    if (!state) return
    clearHostGrant(state)
  }

  setWaiting(
    agent: Agent | undefined,
    kind?: AgentGateState['waitingKind'],
    watermarkTurnId?: string,
  ): void {
    if (!agent) return
    const state = this.states.get(agent)
    if (!state) {
      if (!kind) return
      const sessionId = ownerSessionId(agent)
      this.states.set(agent, {
        generation: 0,
        turnSequence: 0,
        seenMessageIds: new Set(),
        consumedMessageIds: new Set(),
        consumedTurnIds: new Set(),
        waitingKind: kind,
        ...(watermarkTurnId ? { interruptWatermarkTurnId: watermarkTurnId } : {}),
        ...(sessionId ? { sessionId } : {}),
      })
      return
    }
    if (kind) {
      state.waitingKind = kind
      if (watermarkTurnId) state.interruptWatermarkTurnId = watermarkTurnId
    } else {
      delete state.waitingKind
      delete state.interruptWatermarkTurnId
    }
  }

  applyResolutionAuthorization(
    agent: Agent | undefined,
    authorization: ResolutionAuthorization,
    generation: number | undefined,
  ): boolean {
    if (!agent || generation === undefined) return false
    const state = this.states.get(agent)
    if (!state || state.generation !== generation) return false
    state.activeResolutionId = authorization.resolutionId
    state.authorization = authorization
    if (!preservesHostGrant(authorization.state)) clearHostGrant(state)
    return true
  }

  applyReviewAuthorization(agent: Agent | undefined, authorization: ResolutionAuthorization): boolean {
    if (!agent) return false
    const state = this.states.get(agent)
    if (!state || state.activeResolutionId !== authorization.resolutionId) return false
    state.authorization = authorization
    if (!preservesHostGrant(authorization.state)) clearHostGrant(state)
    return true
  }

  assertInstallAuthorized(
    agent: Agent | undefined,
    review: ReviewRecord,
    resolution: Pick<ResolutionRecord, 'id' | 'decisions'>,
    binding?: InstallCommitmentBinding,
  ): void {
    if (!agent) {
      throw new EvolutionError('review_rejected', 'A live Agent is required to install a reviewed plugin')
    }
    const state = this.states.get(agent)
    const receipt = state?.selectionReceipt
    const commitment = state?.actionCommitment
    if (!state || !receipt || !commitment) {
      throw new EvolutionError('review_rejected', 'Install requires the current Host action commitment', {
        reviewId: review.id,
      })
    }
    if (binding?.receipt && hashObject(binding.receipt) !== hashObject(receipt)) {
      throw new EvolutionError('review_rejected', 'Install receipt does not match the current Host grant')
    }
    if (binding?.commitment && hashObject(binding.commitment) !== hashObject(commitment)) {
      throw new EvolutionError('review_rejected', 'Install commitment does not match the current Host grant')
    }
    const sessionId = ownerSessionId(agent) ?? state.sessionId
    if (!sessionId || receipt.ownerSessionId !== sessionId) {
      throw new EvolutionError('review_rejected', 'Install commitment belongs to a different owner session', {
        expected: receipt.ownerSessionId,
        actual: sessionId,
      })
    }
    if (receipt.bootId !== this.bootId) {
      throw new EvolutionError('review_rejected', 'Install commitment was invalidated by a service restart', {
        expectedBootId: this.bootId,
        receiptBootId: receipt.bootId,
      })
    }
    if (!state.currentTurnId || receipt.hostTurnId !== state.currentTurnId) {
      throw new EvolutionError('review_rejected', 'Install commitment is not bound to the current host user turn', {
        hostTurnId: receipt.hostTurnId,
        currentTurnId: state.currentTurnId,
      })
    }
    if (commitment.selectionReceiptId !== receipt.id || commitment.snapshotDigest !== receipt.snapshotDigest) {
      throw new EvolutionError('review_rejected', 'Install commitment is not bound to the current selection receipt')
    }
    const installActions = new Set(['use_this', 'apply_recovery'])
    if (!installActions.has(commitment.requestedAction) || !installActions.has(receipt.kind)) {
      throw new EvolutionError('review_rejected', 'Install commitment is not an approved install grant', {
        requestedAction: commitment.requestedAction,
      })
    }
    if (commitment.endpoint.kind !== 'none') {
      throw new EvolutionError('review_rejected', 'Install commitment must not fabricate a post-install execution endpoint')
    }
    if (commitment.reviewId !== review.id) {
      throw new EvolutionError('review_rejected', 'Install commitment is bound to a different review', {
        expected: commitment.reviewId,
        actual: review.id,
      })
    }
    if (commitment.reviewSnapshotDigest !== reviewSnapshotDigest(review)) {
      throw new EvolutionError('review_rejected', 'Install commitment review snapshot digest is stale')
    }
    if (commitment.frozenManifestDigest !== frozenManifestDigest(review)
      || (commitment.frozenInstallSpec ?? null) !== (review.installSpec ?? null)) {
      throw new EvolutionError('review_rejected', 'Install commitment manifest or installSpec no longer matches the review')
    }
    const candidateId = commitment.candidateId
    if (!candidateId || (receipt.candidateIds.length > 0 && !receipt.candidateIds.includes(candidateId))) {
      throw new EvolutionError('review_rejected', 'Install commitment candidate is outside the current receipt')
    }
    const currentCandidateDigest = reviewCandidateDigest(review, binding?.workflow)
    if (!commitment.candidateDigest || commitment.candidateDigest !== currentCandidateDigest) {
      throw new EvolutionError('review_rejected', 'Install commitment candidate digest is stale')
    }
    if (binding?.retention && commitment.retention && binding.retention !== commitment.retention) {
      throw new EvolutionError('review_rejected', 'Install retention does not match the Host commitment', {
        expected: commitment.retention,
        actual: binding.retention,
      })
    }
    if (commitment.requestedAction === 'apply_recovery') {
      const plan = commitment.allowedParameterConstraints.recoveryPlan
      if (!plan || !receipt.recoveryId || receipt.recoveryId !== plan.id || commitment.recoveryId !== plan.id) {
        throw new EvolutionError('review_rejected', 'Install recovery is not bound to the selected recovery receipt')
      }
    } else if (receipt.recoveryId || commitment.recoveryId || commitment.allowedParameterConstraints.recoveryPlan) {
      throw new EvolutionError('review_rejected', 'Ordinary install grant must not contain recovery authority')
    }
    if (hashObject(binding?.recoveryPlan ?? null)
      !== hashObject(commitment.allowedParameterConstraints.recoveryPlan ?? null)) {
      throw new EvolutionError('review_rejected', 'Install recovery plan does not match the Host commitment')
    }
    assertDirectUseAllowed(review, binding?.workflow)
    assertUseThisReceipt(review, resolution)
  }

  /** Managed child construction (modify/create) requires the evolution preset. */
  isManagedWorkAvailable(agent: Agent | undefined): boolean {
    if (!agent) return false
    return this.inEvolutionMode(agent)
  }

  private inEvolutionMode(agent: Agent): boolean {
    return this.options.isEvolutionMode?.(agent) === true
  }

  protocolDenial(exec: Readonly<ToolExecution>): string | undefined {
    if (!exec.agent || !this.inEvolutionMode(exec.agent)) return undefined
    const state = this.states.get(exec.agent)
    const clarificationWaiting = state?.waitingKind === 'await_clarification'
    const discoveryOpen = state?.waitingKind === 'await_discovery'
    const recoveryWaiting = state?.waitingKind === 'await_recovery'
    const waiting = clarificationWaiting
      || state?.waitingKind === 'await_selection'
      || state?.waitingKind === 'await_confirmation'
      || recoveryWaiting
      || (!state?.waitingKind && (
        state?.authorization?.state === 'selection_required'
        || state?.authorization?.state === 'confirmation_required'
      ))
    const hasFreshReply = Boolean(
      state?.currentTurnId
      && state.interruptWatermarkTurnId
      && state.currentTurnId !== state.interruptWatermarkTurnId,
    )
    if (ASK_USER_TOOLS.has(exec.name) && waiting) {
      return 'AutoEvo is already waiting at a sealed user gate. Present the natural-language choices in chat and stop. A tool answer is not an authenticated fresh top-level user turn.'
    }
    if (exec.name === FIND_PLUGIN_TOOL) {
      if (clarificationWaiting) {
        return 'Answer the sealed clarification through capability_workflow_resume before any discovery. Clarification grants no mutation authority.'
      }
      if (recoveryWaiting) {
        return hasFreshReply
          ? 'Recovery is pending. Do not search. Call capability_workflow_recover with the sealed workflow_id and interrupt_id to clean up the exact owned installation and start a new discovery.'
          : 'Recovery is pending. Do not search. Present the cleanup-and-restart choice in chat and stop; call capability_workflow_recover only after the user replies in a fresh top-level turn.'
      }
      if (discoveryOpen) {
        return 'Use capability_workflow_refine so the Host can budget, validate, deduplicate, and bind discovery evidence.'
      }
      if (waiting && hasFreshReply) {
        return 'Discovery is finished. Do not search. The user has replied; call capability_workflow_resume with navigation.review_candidates and the selected candidate_ids. Do not send use_this at selection.'
      }
      if (waiting) {
        return 'Discovery is finished. Present the current shortlist in chat. Do not search, and do not call capability_workflow_resume until the user replies.'
      }
      return 'Do not call find_dsh_plugin. Call capability_workflow with the user\'s original requirement.'
    }
    if (exec.name === WEB_SEARCH_TOOL && clarificationWaiting) {
      return 'Answer the sealed clarification through capability_workflow_resume before any discovery.'
    }
    if (exec.name === WEB_SEARCH_TOOL && discoveryOpen) return undefined
    if (exec.name === WEB_SEARCH_TOOL && recoveryWaiting) {
      return hasFreshReply
        ? 'Recovery is pending. Do not search. Call capability_workflow_recover with the sealed workflow_id and interrupt_id.'
        : 'Recovery is pending. Do not search. Present the cleanup-and-restart choice and stop until the user replies in a fresh top-level turn.'
    }
    if (exec.name === WEB_SEARCH_TOOL && waiting) {
      if (hasFreshReply) {
        return 'Discovery is finished. Do not search. Resume with navigation.review_candidates and the selected candidate_ids from the current shortlist.'
      }
      return 'Discovery is finished. If the user has not replied since the shortlist, present it and stop. After they reply, map their words to candidate IDs and call capability_workflow_resume with read-only navigation.'
    }
    return undefined
  }

  /**
   * Protocol-state denials only. Live Cordis definition and `dsh plugin add`
   * are denied by the outer ExecutionGuard, which runs first in evolution mode.
   */
  preExecute(exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> {
    const protocol = this.protocolDenial(exec)
    if (protocol) return Promise.resolve({ kind: 'deny', reason: protocol })
    return next()
  }

  /** Final monotonic check: no earlier waterfall listener can override this denial. */
  guard(exec: Readonly<ToolExecution>): string | undefined {
    return this.protocolDenial(exec)
  }

  result(_exec: Readonly<ToolExecution>, _result: Readonly<ToolExecutionResult>): void {
    // No per-result bookkeeping remains; kept because index.ts wires tools/result here.
  }

  authorization(agent: Agent): ResolutionAuthorization | undefined {
    return this.states.get(agent)?.authorization
  }
}

export const _testing = {
  extractUserFacingText,
  outsideEvolutionModeReason,
  preservesHostGrant,
}
