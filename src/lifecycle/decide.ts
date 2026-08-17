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
import { EvolutionError } from '../errors.js'
import { hashObject } from '../state/hashes.js'
import type { CreationGuard } from '../creation-guard.js'
import type { InterruptPayload, ValidatedResume } from '../workflow/contracts.js'

const CREATE_NEW_RE = /新建|从零|自己写|自己做|create new|from scratch|没有合适|都不行|都不想用|都不合适/iu
const STOP_RE = /先停|停下|停止|取消|算了|stop for now|\bstop\b|\bcancel\b/iu

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
  extras: Partial<Pick<DecisionReceipt, 'reviewId' | 'reviewIdentity' | 'userMessage' | 'optionId'>> = {},
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
      ? '先在对话里说明每个候选：仓库名、它是干什么的、为何被搜到、星数。不要调用 ask_user。等用户回话后，再调用 capability_workflow_resume，带上原话和 option_id。'
      : 'Present each candidate in chat (repository, what it does, why it matched, stars). Do not call ask_user. After the user replies, call capability_workflow_resume with their verbatim message and option_id.'
  }
  if (authorization.state === 'confirmation_required') {
    return zh
      ? '先在对话里讲清这次审查：匹配程度、风险、缺什么、主要发现。不要调用 ask_user。等用户回话后，再调用 capability_workflow_resume（用这个 / 在这个上改 / 新建 / 先停）。'
      : 'Explain the review in chat (fit, risk, missing pieces, findings). Do not call ask_user. After the user replies, call capability_workflow_resume (use this / improve this / create new / stop).'
  }
  if (authorization.state === 'scratch_ready') {
    return zh
      ? '用户允许新建一次。这不是立刻动手的命令；确认仍要新建后再定义。'
      : 'The user allowed one new plugin. That is not a mandate to start building.'
  }
  if (authorization.state === 'use_review') {
    return zh
      ? '用户选择使用这次审查的插件。工作流会安装它；不要另建一个替代品。卸了重装或再改一刀时，仍在同一条 workflow 上 resume。'
      : 'The user chose this reviewed plugin. The workflow will install it; do not create a replacement. To reinstall or patch again, resume this workflow.'
  }
  if (authorization.state === 'modify_review') {
    return zh
      ? '用户选择在这次审查上做最小修改。按工单改完后，用本地检出路径 resume；base_review_id 由工作流从 lineage 推导。'
      : 'The user chose to improve this review. Follow the work order, then resume with the local checkout path. The workflow derives base_review_id from the lineage.'
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
      state: 'scratch_ready',
      resolutionId,
      reason: 'The user allowed one new plugin to be created.',
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
  if (action === 'resume_modify' && review) {
    return {
      state: 'modify_review',
      resolutionId,
      reason: 'The user submitted a local checkout for re-review.',
      reviewId: review.id,
      reviewIdentity: reviewIdentity(review),
      selectedRepositories,
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

export function assertAuthenticUserMessage(
  guard: CreationGuard,
  agent: Agent | undefined,
  userMessage: string,
): string {
  const normalized = normalizeDecisionText(userMessage)
  if (!normalized || normalized.length > 2_000) {
    throw new EvolutionError('invalid_input', 'user_message must contain 1 to 2000 characters')
  }
  const last = guard.lastUserMessage(agent)
  if (last && normalizeDecisionText(last) !== normalized) {
    throw new EvolutionError('invalid_input', 'user_message does not match the latest user turn')
  }
  return normalized
}

export function assertOptionAllowed(interrupt: InterruptPayload, optionId: WorkflowOptionId): void {
  if (!interrupt.options.some((option) => option.id === optionId)) {
    throw new EvolutionError('invalid_input', 'option_id is not available at this workflow interrupt', {
      optionId,
      allowed: interrupt.options.map((option) => option.id),
    })
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

export function phaseForOption(optionId: WorkflowOptionId): DecisionPhase {
  return optionId === 'use_this' || optionId === 'modify_this' || optionId === 'resume_modify'
    ? 'gate2'
    : 'gate1'
}

export function validateResume(input: {
  guard: CreationGuard
  agent: Agent | undefined
  interrupt: InterruptPayload
  userMessage: string
  optionId: WorkflowOptionId
  remotes: readonly RemotePluginCandidate[]
  repositories?: string[]
  path?: string
  ref?: string
  reviewId?: string
  targetProfile?: string
  retention?: InstallationRetention
  verificationTask?: string
  verificationExpectedText?: string
}): ValidatedResume {
  const userMessage = assertAuthenticUserMessage(input.guard, input.agent, input.userMessage)
  assertOptionAllowed(input.interrupt, input.optionId)
  assertResumeContradiction(userMessage, input.optionId)
  const repositories = resolveResumeRepositories(input.repositories, input.remotes, input.optionId)

  if (input.optionId === 'resume_modify') {
    const path = input.path?.normalize('NFKC').trim()
    if (!path) throw new EvolutionError('invalid_input', 'resume_modify requires a local checkout path')
    return { optionId: input.optionId, userMessage, repositories, path }
  }

  if (input.optionId === 'use_this') {
    const targetProfile = input.targetProfile?.trim()
    const retention = input.retention
    if (!targetProfile || !retention) {
      throw new EvolutionError('invalid_input', 'use_this requires target_profile and retention')
    }
    return {
      optionId: input.optionId,
      userMessage,
      repositories,
      ...(input.ref ? { ref: input.ref } : {}),
      ...(input.reviewId ? { reviewId: input.reviewId } : {}),
      install: {
        targetProfile,
        retention,
        ...(input.verificationTask ? { verificationTask: input.verificationTask } : {}),
        ...(input.verificationExpectedText ? { verificationExpectedText: input.verificationExpectedText } : {}),
      },
    }
  }

  return {
    optionId: input.optionId,
    userMessage,
    repositories,
    ...(input.path ? { path: input.path } : {}),
    ...(input.ref ? { ref: input.ref } : {}),
    ...(input.reviewId ? { reviewId: input.reviewId } : {}),
  }
}

export const _testing = {
  CREATE_NEW_RE,
  STOP_RE,
}
