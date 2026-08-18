import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  DecisionAction,
  DecisionPhase,
  DecisionReceipt,
  InstallationRetention,
  RemotePluginCandidate,
  ResolutionAuthorization,
  ReviewRecord,
  WorkflowOptionId,
} from '../contracts.js'
import type { CreationGuard, ClaimedHostTurn } from '../creation-guard.js'
import { EvolutionError } from '../errors.js'
import { hashObject } from '../state/hashes.js'
import type { InterruptPayload, ValidatedResume, WorkflowPendingInstall } from '../workflow/contracts.js'

const CREATE_NEW_RE = /新建|从零|自己写|自己做|create new|from scratch|没有合适|都不行|都不想用|都不合适/iu
const STOP_RE = /先停|停下|停止|取消|算了|stop for now|\bstop\b|\bcancel\b/iu
const USE_THIS_RE = /用这个|就用这个|使用这个|use this|install this|采用这个/iu
const MODIFY_THIS_RE = /在这个上改|改进这个|改这个|improve this|modify this|patch this/iu
const USE_LOCAL_RE = /用已有|本地能力|use (?:the )?local|use existing/iu
const SEARCH_MORE_RE = /继续找|再搜|search more|search anyway|找插件/iu
const INSPECT_RE = /审查|先看|具体看看|inspect|review|看看/iu
const PERSISTENT_RE = /永久|持久|persistent|keep installed/iu
const TEMPORARY_RE = /临时|试用|temporary|trial/iu

export function prefersChinese(text: string): boolean {
  return /[\p{Script=Han}]/u.test(text)
}

export function normalizeDecisionText(value: string): string {
  return value.normalize('NFKC').trim()
}

export function reviewIdentity(review: ReviewRecord): string {
  return review.sourceSnapshot.kind === 'github'
    ? review.sourceSnapshot.commit.toLowerCase()
    : review.sourceSnapshot.statusHash.toLowerCase()
}

export function latestGate2Decision(resolution: { decisions?: DecisionReceipt[] }): DecisionReceipt | undefined {
  const decisions = resolution.decisions ?? []
  for (let index = decisions.length - 1; index >= 0; index -= 1) {
    const decision = decisions[index]
    if (decision?.phase === 'gate2') return decision
  }
  return undefined
}

export function assertUseThisReceipt(
  review: ReviewRecord,
  resolution: { id: string; decisions?: DecisionReceipt[] },
): void {
  if (resolution.id !== review.resolutionId) {
    throw new EvolutionError('review_rejected', 'The user has not chosen to use this reviewed plugin', {
      reviewId: review.id,
    })
  }
  const decision = latestGate2Decision(resolution)
  const identity = reviewIdentity(review)
  if (
    !decision
    || decision.action !== 'use_this'
    || decision.reviewId !== review.id
    || decision.reviewIdentity !== identity
  ) {
    throw new EvolutionError('review_rejected', 'The user has not chosen to use this reviewed plugin', {
      reviewId: review.id,
    })
  }
}

export function newDecisionReceipt(
  phase: DecisionReceipt['phase'],
  action: DecisionAction,
  selectedRepositories: string[],
  extras: Partial<Pick<DecisionReceipt, 'reviewId' | 'reviewIdentity' | 'userMessage' | 'optionId' | 'interruptId' | 'hostTurnId'>> = {},
): DecisionReceipt {
  const createdAt = new Date().toISOString()
  return {
    id: `decision_${hashObject({ phase, action, selectedRepositories, extras, createdAt }).slice(0, 24)}`,
    phase,
    action,
    selectedRepositories,
    createdAt,
    ...extras,
  }
}

export function nextStepForAuthorization(
  requirement: string,
  authorization: ResolutionAuthorization,
): string {
  const zh = prefersChinese(requirement)
  if (authorization.state === 'market_required') {
    return zh
      ? '市场插件还在安装或需要重启。批准后等热加载；热加载失败就重启 DSH，再调用 capability_workflow。'
      : 'The marketplace plugin is still installing or needs a restart. Approve if asked, then wait for hot-load. Restart DSH only if hot-load fails, then call capability_workflow again.'
  }
  if (authorization.state === 'selection_required') {
    return zh
      ? '先在对话里说明每个候选：仓库名、它是干什么的、为何被搜到、星数。不要调用 ask_user。等用户回话后，再调用 capability_workflow_resume，只传 workflow_id 与 interrupt_id。'
      : 'Present each candidate in chat (repository, what it does, why it matched, stars). Do not call ask_user. After the user replies, call capability_workflow_resume with only workflow_id and interrupt_id.'
  }
  if (authorization.state === 'confirmation_required') {
    return zh
      ? '先在对话里讲清这次审查：匹配程度、风险、缺什么、主要发现。不要调用 ask_user。等用户回话后，再调用 capability_workflow_resume（只用 workflow_id 与 interrupt_id）。'
      : 'Explain the review in chat (fit, risk, missing pieces, findings). Do not call ask_user. After the user replies, call capability_workflow_resume with only workflow_id and interrupt_id.'
  }
  if (authorization.state === 'create_authorized') {
    return zh
      ? '用户允许新建。创建只会在托管 git 源与 workspace-write 子会话中进行；不要直接 cordis_define。'
      : 'The user allowed create-new. Creation continues only in a managed git source and workspace-write child session; do not call cordis_define directly.'
  }
  if (authorization.state === 'use_review') {
    return zh
      ? '用户选择使用这次审查的插件。工作流会安装它；不要另建一个替代品。卸了重装或再改一刀时，仍在同一条 workflow 上 resume。'
      : 'The user chose this reviewed plugin. The workflow will install it; do not create a replacement. To reinstall or patch again, resume this workflow.'
  }
  if (authorization.state === 'modify_review') {
    return zh
      ? '用户选择在这次审查上做最小修改。修改在托管源与子会话中进行；不要提交本地路径。'
      : 'The user chose to improve this review. Modification continues in a managed source child session; do not supply a local path.'
  }
  if (authorization.state === 'reuse_local') {
    return zh
      ? '用户选择使用已有的本地能力。直接用它。'
      : 'The user chose the existing local capability. Use it.'
  }
  if (authorization.state === 'stopped') {
    return zh
      ? '用户选择先停。不要安装或新建。'
      : 'The user stopped. Do not install or create.'
  }
  return authorization.reason
}

export function authorizationFromDecision(
  resolutionId: string,
  action: DecisionAction,
  selectedRepositories: string[],
  review?: ReviewRecord,
): ResolutionAuthorization {
  if (action === 'stop') {
    return { state: 'stopped', resolutionId, reason: 'The user stopped. Nothing will be installed or created.' }
  }
  if (action === 'create_new') {
    return {
      state: 'create_authorized',
      resolutionId,
      reason: 'The user allowed one new plugin to be created in a managed source.',
    }
  }
  if (action === 'use_local') {
    return { state: 'reuse_local', resolutionId, reason: 'The user chose the existing local capability.' }
  }
  if (action === 'search_more') {
    return {
      state: 'selection_required',
      resolutionId,
      reason: 'The user asked to search for plugins again.',
    }
  }
  if (action === 'use_this' && review) {
    return {
      state: 'use_review',
      resolutionId,
      reason: 'The user chose to use the reviewed plugin.',
      reviewId: review.id,
      reviewIdentity: reviewIdentity(review),
      selectedRepositories,
    }
  }
  if (action === 'modify_this' && review) {
    return {
      state: 'modify_review',
      resolutionId,
      reason: 'The user chose to improve the reviewed plugin.',
      reviewId: review.id,
      reviewIdentity: reviewIdentity(review),
      selectedRepositories,
    }
  }
  return {
    state: 'selection_required',
    resolutionId,
    reason: selectedRepositories.length > 0
      ? 'Review only the repositories the user selected.'
      : 'Waiting for the user to choose a candidate, create new, or stop.',
    selectedRepositories,
  }
}

export function assertOptionAllowed(interrupt: InterruptPayload, optionId: WorkflowOptionId): void {
  if (!interrupt.options.some((option) => option.id === optionId)) {
    throw new EvolutionError('invalid_input', 'option_id is not available at this workflow interrupt', {
      optionId,
      allowed: interrupt.options.map((option) => option.id),
    })
  }
}

export function resolveRepositoryFromMessage(
  userMessage: string,
  remotes: readonly RemotePluginCandidate[],
): string[] {
  const matches: string[] = []
  for (const remote of remotes) {
    const repo = remote.repository
    const shortName = repo.split('/')[1] ?? repo
    const patterns = [repo, shortName]
    if (patterns.some((pattern) => pattern && userMessage.toLowerCase().includes(pattern.toLowerCase()))) {
      matches.push(repo)
    }
  }
  return [...new Set(matches)]
}

export function inferOptionId(
  userMessage: string,
  interrupt: InterruptPayload,
  remotes: readonly RemotePluginCandidate[],
): WorkflowOptionId {
  const allowed = new Set(interrupt.options.map((option) => option.id))
  const pick = (id: WorkflowOptionId): WorkflowOptionId | undefined => (allowed.has(id) ? id : undefined)

  if (STOP_RE.test(userMessage)) {
    const stop = pick('stop')
    if (stop) return stop
  }
  if (CREATE_NEW_RE.test(userMessage)) {
    const create = pick('create_new')
    if (create) return create
  }
  if (USE_THIS_RE.test(userMessage)) {
    const useThis = pick('use_this')
    if (useThis) return useThis
  }
  if (MODIFY_THIS_RE.test(userMessage)) {
    const modify = pick('modify_this')
    if (modify) return modify
  }
  if (USE_LOCAL_RE.test(userMessage)) {
    const useLocal = pick('use_local')
    if (useLocal) return useLocal
  }
  if (SEARCH_MORE_RE.test(userMessage)) {
    const search = pick('search_more')
    if (search) return search
  }

  const repos = resolveRepositoryFromMessage(userMessage, remotes)
  if (repos.length === 1 && pick('inspect') && (INSPECT_RE.test(userMessage) || interrupt.kind === 'await_selection')) {
    return 'inspect'
  }
  if (repos.length === 1 && pick('inspect') && interrupt.kind === 'await_confirmation' && INSPECT_RE.test(userMessage)) {
    return 'inspect'
  }

  throw new EvolutionError('invalid_input', 'Could not resolve a workflow decision from the latest host user turn', {
    allowed: [...allowed],
  })
}

export function resolveInstallFromHost(
  interrupt: InterruptPayload,
  userMessage: string,
  requirement: string,
): WorkflowPendingInstall {
  const profiles = Array.isArray(interrupt.facts.installProfiles)
    ? interrupt.facts.installProfiles.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
  const targetProfile = profiles[0]?.trim()
  if (!targetProfile) {
    throw new EvolutionError(
      'invalid_input',
      'use_this requires at least one AutoEvo-capable install profile in the interrupt facts',
    )
  }
  let retention: InstallationRetention = 'temporary'
  if (PERSISTENT_RE.test(userMessage) && !TEMPORARY_RE.test(userMessage)) retention = 'persistent'
  if (TEMPORARY_RE.test(userMessage)) retention = 'temporary'
  if (!PERSISTENT_RE.test(userMessage) && !TEMPORARY_RE.test(userMessage)) {
    // Default temporary with a verification task derived from the requirement.
    retention = 'temporary'
  }
  return {
    targetProfile,
    retention,
    ...(retention === 'temporary' ? { verificationTask: requirement } : {}),
  }
}

export function phaseForOption(optionId: WorkflowOptionId): DecisionPhase {
  return optionId === 'use_this' || optionId === 'modify_this' ? 'gate2' : 'gate1'
}

export function resolveDecisionFromHost(input: {
  guard: CreationGuard
  agent: Agent | undefined
  interrupt: InterruptPayload
  remotes: readonly RemotePluginCandidate[]
  requirement: string
  reviewId?: string
}): ValidatedResume {
  const turn = input.guard.consumeDecisionTurn(input.agent, input.interrupt)
  const userMessage = normalizeDecisionText(turn.message)
  if (!userMessage || userMessage.length > 2_000) {
    throw new EvolutionError('invalid_input', 'host user turn must contain 1 to 2000 characters')
  }
  const optionId = inferOptionId(userMessage, input.interrupt, input.remotes)
  assertOptionAllowed(input.interrupt, optionId)

  let repositories: string[] = []
  if (optionId === 'inspect') {
    repositories = resolveRepositoryFromMessage(userMessage, input.remotes)
    if (repositories.length !== 1) {
      throw new EvolutionError('invalid_input', 'inspect requires exactly one repository named in the user turn')
    }
  } else if (optionId === 'use_this' || optionId === 'modify_this') {
    const named = resolveRepositoryFromMessage(userMessage, input.remotes)
    repositories = named.length > 0 ? named : []
  }

  if (optionId === 'use_this') {
    return {
      optionId,
      userMessage,
      hostTurnId: turn.turnId,
      interruptId: input.interrupt.interruptId,
      repositories,
      ...(input.reviewId ? { reviewId: input.reviewId } : {}),
      install: resolveInstallFromHost(input.interrupt, userMessage, input.requirement),
    }
  }

  return {
    optionId,
    userMessage,
    hostTurnId: turn.turnId,
    interruptId: input.interrupt.interruptId,
    repositories,
    ...(input.reviewId ? { reviewId: input.reviewId } : {}),
  }
}

/** @deprecated Prefer resolveDecisionFromHost; kept for narrow unit tests of inference helpers. */
export function validateResume(input: {
  guard: CreationGuard
  agent: Agent | undefined
  interrupt: InterruptPayload
  userMessage: string
  optionId: WorkflowOptionId
  remotes: readonly RemotePluginCandidate[]
  repositories?: string[]
  reviewId?: string
  targetProfile?: string
  retention?: InstallationRetention
  verificationTask?: string
  verificationExpectedText?: string
}): ValidatedResume {
  const claimed: ClaimedHostTurn = {
    turnId: input.guard.currentTurnId(input.agent) ?? 'turn_test',
    message: input.userMessage,
    sequence: 0,
  }
  void claimed
  const normalized = normalizeDecisionText(input.userMessage)
  if (!normalized || normalized.length > 2_000) {
    throw new EvolutionError('invalid_input', 'user_message must contain 1 to 2000 characters')
  }
  const last = input.guard.lastUserMessage(input.agent)
  if (last && normalizeDecisionText(last) !== normalized) {
    throw new EvolutionError('invalid_input', 'user_message does not match the latest user turn')
  }
  assertOptionAllowed(input.interrupt, input.optionId)
  if (STOP_RE.test(normalized) && input.optionId !== 'stop') {
    throw new EvolutionError('invalid_input', 'The claimed option contradicts the user message', {
      optionId: input.optionId,
      inferredAction: 'stop',
    })
  }
  if (CREATE_NEW_RE.test(normalized) && input.optionId !== 'create_new') {
    throw new EvolutionError('invalid_input', 'The claimed option contradicts the user message', {
      optionId: input.optionId,
      inferredAction: 'create_new',
    })
  }
  if (input.optionId === 'create_new' && !CREATE_NEW_RE.test(normalized)) {
    throw new EvolutionError('invalid_input', 'The claimed option contradicts the user message', {
      optionId: input.optionId,
    })
  }
  const repositories = (input.repositories ?? []).map((item) => item.trim()).filter(Boolean)
  if (input.optionId === 'inspect' && repositories.length !== 1) {
    throw new EvolutionError('invalid_input', 'inspect requires exactly one repository')
  }
  const resolved = repositories.map((repository) => {
    const known = input.remotes.find((item) => item.repository.toLowerCase() === repository.toLowerCase())
    return known?.repository ?? repository
  })
  if (input.optionId === 'use_this') {
    if (!input.targetProfile || !input.retention) {
      throw new EvolutionError('invalid_input', 'use_this requires target_profile and retention')
    }
    return {
      optionId: input.optionId,
      userMessage: normalized,
      hostTurnId: input.guard.currentTurnId(input.agent) ?? 'turn_test',
      interruptId: input.interrupt.interruptId,
      repositories: resolved,
      install: {
        targetProfile: input.targetProfile,
        retention: input.retention,
        ...(input.verificationTask ? { verificationTask: input.verificationTask } : {}),
        ...(input.verificationExpectedText ? { verificationExpectedText: input.verificationExpectedText } : {}),
      },
      ...(input.reviewId ? { reviewId: input.reviewId } : {}),
    }
  }
  return {
    optionId: input.optionId,
    userMessage: normalized,
    hostTurnId: input.guard.currentTurnId(input.agent) ?? 'turn_test',
    interruptId: input.interrupt.interruptId,
    repositories: resolved,
    ...(input.reviewId ? { reviewId: input.reviewId } : {}),
  }
}

export function assertResumeContradiction(userMessage: string, optionId: WorkflowOptionId): void {
  if (STOP_RE.test(userMessage) && optionId !== 'stop') {
    throw new EvolutionError('invalid_input', 'The claimed option contradicts the user message', {
      optionId,
      inferredAction: 'stop',
    })
  }
  if (CREATE_NEW_RE.test(userMessage) && optionId !== 'create_new') {
    throw new EvolutionError('invalid_input', 'The claimed option contradicts the user message', {
      optionId,
      inferredAction: 'create_new',
    })
  }
  if (optionId === 'create_new' && !CREATE_NEW_RE.test(userMessage)) {
    throw new EvolutionError('invalid_input', 'The claimed option contradicts the user message', {
      optionId,
    })
  }
}

export function resolveResumeRepositories(
  claimed: readonly string[] | undefined,
  remotes: readonly RemotePluginCandidate[],
  optionId: WorkflowOptionId,
): string[] {
  const requested = (claimed ?? []).map((item) => item.trim()).filter(Boolean)
  if (optionId !== 'inspect' && optionId !== 'use_this' && optionId !== 'modify_this' && requested.length > 0) {
    throw new EvolutionError('invalid_input', 'repositories are only valid when inspecting or confirming a review')
  }
  if (optionId === 'inspect' && requested.length !== 1) {
    throw new EvolutionError('invalid_input', 'inspect requires exactly one repository')
  }
  return requested.map((repository) => {
    const known = remotes.find((item) => item.repository.toLowerCase() === repository.toLowerCase())
    return known?.repository ?? repository
  })
}

export const _testing = {
  CREATE_NEW_RE,
  STOP_RE,
  USE_THIS_RE,
  MODIFY_THIS_RE,
  inferOptionId,
  resolveRepositoryFromMessage,
  resolveInstallFromHost,
}
