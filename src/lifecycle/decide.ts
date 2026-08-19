import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  AuthorizationDecisionInput,
  AuthorizationAction,
  DecisionPhase,
  DecisionReceipt,
  ResolutionAuthorization,
  ReviewRecord,
  WorkflowOptionId,
} from '../contracts.js'
import type { CreationGuard } from '../creation-guard.js'
import { EvolutionError } from '../errors.js'
import { hashObject } from '../state/hashes.js'
import type { InterruptPayload, ValidatedResume, WorkflowPendingInstall } from '../workflow/contracts.js'

export function prefersChinese(text: string): boolean {
  return /[\p{Script=Han}]/u.test(text)
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
  action: AuthorizationAction,
  selectedRepositories: string[],
  extras: Partial<Pick<DecisionReceipt, 'reviewId' | 'reviewIdentity' | 'userMessage' | 'optionId' | 'interruptId' | 'hostTurnId' | 'candidateId' | 'retention' | 'targetProfile' | 'snapshotDigest'>> = {},
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
      ? '精简展示带序号的候选及推荐审查计划。等用户回话后，把“两个都、前两个、全部、另一个、第二个”等自然语言映射为当前快照 candidate_id，并用 navigation 调用 capability_workflow_resume。不要调用 ask_user。'
      : 'Present a concise numbered shortlist and recommended review plan. After the user replies, map natural language such as both, the first two, all, the other one, or the second one to current snapshot candidate IDs and call capability_workflow_resume with navigation. Do not call ask_user.'
  }
  if (authorization.state === 'confirmation_required') {
    return zh
      ? '精简比较审查结论，只展示当前合法动作。安全发现只是静态观察：合并展示来源，不得推断用途、必要性、实际运行、命令目标或回调服务；事实未建立时明确说未知。用户要比较其它候选时，用 candidate_id 导航继续审查；用户明确选择安装、修改、新建或先停时，由你理解用户语义并把结构化 decision（action、必要时 candidate_id、可选 retention）传给 capability_workflow_resume。Host只校验真实新用户回合和当前 interrupt/快照边界，不再用关键词二次猜测。修改后仍会重新审查并再次确认。'
      : 'Compare review outcomes concisely and show only legal actions. Security findings are static observations: group their sources and never infer purpose, necessity, runtime execution, command targets, or callback-server behavior; say unknown when the facts do not establish it. For another comparison, resume with candidate-ID navigation. For an explicit install, modify, create, or stop choice, interpret the user semantically and pass a structured decision (action, candidate_id when required, and optional retention) to capability_workflow_resume. The Host validates the fresh authentic turn and current interrupt/snapshot boundaries instead of re-parsing keywords. Modified sources are reviewed again before a fresh confirmation.'
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
  action: AuthorizationAction,
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

export function resolveDecisionTarget(
  decision: AuthorizationDecisionInput,
  interrupt: InterruptPayload,
): { repositories: string[]; candidateId?: string } {
  assertOptionAllowed(interrupt, decision.action)
  if (decision.action !== 'use_this' && decision.retention !== undefined) {
    throw new EvolutionError('invalid_input', `${decision.action} does not accept retention`)
  }
  const option = interrupt.options.find((item) => item.id === decision.action)!
  const needsCandidate = decision.action === 'use_this' || decision.action === 'modify_this'
  if (!needsCandidate) {
    if (decision.candidateId) {
      throw new EvolutionError('invalid_input', `${decision.action} does not accept candidate_id`)
    }
    return { repositories: [] }
  }
  const candidateId = decision.candidateId?.trim()
  if (!candidateId) {
    throw new EvolutionError('invalid_input', `${decision.action} requires candidate_id from the current option`)
  }
  if (!option.candidateIds?.includes(candidateId)) {
    throw new EvolutionError('invalid_input', 'candidate_id is not allowed for this decision action', {
      action: decision.action,
      candidateId,
      allowedCandidateIds: option.candidateIds ?? [],
    })
  }
  const snapshot = Array.isArray(interrupt.facts.candidateSnapshot)
    ? interrupt.facts.candidateSnapshot as Array<{ id?: unknown; repository?: unknown }>
    : []
  const candidate = snapshot.find((item) => item.id === candidateId)
  if (!candidate) {
    throw new EvolutionError('invalid_input', 'candidate_id is outside the current candidate snapshot', { candidateId })
  }
  return {
    candidateId,
    repositories: typeof candidate.repository === 'string' ? [candidate.repository] : [],
  }
}

function resolveInstallFromDecision(
  interrupt: InterruptPayload,
  decision: AuthorizationDecisionInput,
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
  const retention = decision.retention ?? 'temporary'
  if (retention !== 'temporary' && retention !== 'persistent') {
    throw new EvolutionError('invalid_input', 'decision retention must be temporary or persistent')
  }
  return {
    targetProfile,
    retention,
    verificationTask: requirement,
  }
}

export function phaseForOption(_optionId: AuthorizationAction): DecisionPhase {
  return 'gate2'
}

export function resolveDecisionFromModel(input: {
  guard: CreationGuard
  agent: Agent | undefined
  interrupt: InterruptPayload
  decision: AuthorizationDecisionInput
  requirement: string
  reviewId?: string
}): ValidatedResume {
  const target = resolveDecisionTarget(input.decision, input.interrupt)
  const install = input.decision.action === 'use_this'
    ? resolveInstallFromDecision(input.interrupt, input.decision, input.requirement)
    : undefined
  const turn = input.guard.consumeDecisionTurn(input.agent, input.interrupt)
  const userMessage = turn.message.normalize('NFKC').trim()
  if (!userMessage || userMessage.length > 2_000) {
    throw new EvolutionError('invalid_input', 'host user turn must contain 1 to 2000 characters')
  }
  return {
    optionId: input.decision.action,
    userMessage,
    hostTurnId: turn.turnId,
    interruptId: input.interrupt.interruptId,
    snapshotDigest: input.interrupt.snapshotDigest,
    ...(target.candidateId ? { candidateId: target.candidateId } : {}),
    repositories: target.repositories,
    ...(input.reviewId ? { reviewId: input.reviewId } : {}),
    ...(install ? { install } : {}),
  }
}

export const _testing = {
  resolveDecisionTarget,
  resolveInstallFromDecision,
}
