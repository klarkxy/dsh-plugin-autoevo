import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  AuthorizationDecisionInput,
  AuthorizationAction,
  DecisionPhase,
  DecisionReceipt,
  EvolutionTarget,
  ResolutionAuthorization,
  ReviewRecord,
  VerificationLayerKind,
  WorkflowOptionId,
} from '../contracts.js'
import type { CreationGuard } from '../creation-guard.js'
import { EvolutionError } from '../errors.js'
import { prefersChinese } from '../i18n.js'
import { hashObject } from '../state/hashes.js'
import type { InterruptPayload, ValidatedResume, WorkflowPendingInstall } from '../workflow/contracts.js'

export { prefersChinese }

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
      ? '只把 snapshot 里的真实候选写成带序号短名单，先写在对话里，然后停。每行只写序号、名字、仓库和一句话说明；candidate_id 只用于随后的 resume，不要念给用户。不要提问，不要把官方 API、自建方案或“再搜一下”写成候选。parked 是成功停牌：本回合不要再调用任何工具。等用户回话后，把“两个都、前两个、全部、另一个、第二个、看看3”等映射为 candidate_id，立刻用当前 interrupt 允许的 navigation 调用 capability_workflow_resume；选候选阶段不要 use_this 或 modify_this。reuse_local 表示原样使用，不审查、不修改。不要调用 ask_user。'
      : 'Write a numbered shortlist of real snapshot candidates in chat, then stop. Each row is index, name, repository, and one-line why; keep candidate_id for the later resume call and do not recite it. Do not ask questions, and do not invent official-API, build-it-yourself, or search-further rows. Parked is a successful stop: do not call any tools until the user replies. After the user replies, map natural language such as both, the first two, all, the other one, the second one, or look at 3 to candidate IDs and immediately call capability_workflow_resume with a currently allowed navigation. Do not send use_this or modify_this at selection. reuse_local means use unchanged: no review and no modification. Do not call ask_user.'
  }
  if (authorization.state === 'confirmation_required') {
    return zh
      ? '用两三句话写审查结论和风险，只展示当前合法动作，然后停。不要提问。本回合不要再调用任何工具。安全发现只是静态观察，不得推断用途。审查层为 manual_runtime 的候选只能持久安装且需用户在真实客户端手动测试，先向用户说明这一点。用户要看其它候选时用 navigation；用户明确选择安装、修改、新建或先停时提交结构化 decision，安装时按用户的持久或临时偏好提交 retention。'
      : 'Summarize the review conclusion and risk in two or three sentences, show only legal actions, then stop. Do not ask questions. Do not call any tools until the user replies. Security findings are static observations; do not infer purpose. A candidate whose verification layer is manual_runtime can only be installed with persistent retention and requires a manual user test in a real client; tell the user before the final choice. For another candidate, use navigation. For an explicit install, modify, create, or stop choice, submit a structured decision, submitting retention from the user\'s temporary or persistent preference for installs.'
  }
  if (authorization.state === 'create_authorized') {
    return zh
      ? '用户允许新建。创建只在当前会话的托管 git 源中进行；不要用 cordis_define 代替这份施工。'
      : 'The user allowed create-new. Creation continues in this session on the Host-managed git source; do not use cordis_define instead of that construction.'
  }
  if (authorization.state === 'use_review') {
    return zh
      ? '用户选择使用这次审查的插件。工作流会安装它；不要另建一个替代品。卸了重装或再改一刀时，仍在同一条 workflow 上 resume。'
      : 'The user chose this reviewed plugin. The workflow will install it; do not create a replacement. To reinstall or patch again, resume this workflow.'
  }
  if (authorization.state === 'modify_review') {
    return zh
      ? '用户选择在这次审查上做最小修改。修改在当前会话的托管源中进行；不要提交本地路径。'
      : 'The user chose to improve this review. Modification continues in this session on the Host-managed source; do not supply a local path.'
  }
  if (authorization.state === 'reuse_local') {
    return zh
      ? '用户选择原样使用已有的本地能力。不要审查、修改或安装。'
      : 'The user chose the existing local capability unchanged. Do not review, modify, or install.'
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

function evolutionTargetFromInterrupt(
  interrupt: InterruptPayload,
  candidateId: string | undefined,
): EvolutionTarget | undefined {
  if (!candidateId || !Array.isArray(interrupt.facts.candidateSnapshot)) return undefined
  const candidate = interrupt.facts.candidateSnapshot.find((item) => (
    item && typeof item === 'object' && 'id' in item && (item as { id?: unknown }).id === candidateId
  )) as { evolutionTarget?: EvolutionTarget } | undefined
  return candidate?.evolutionTarget
}

function resolveInstallFromDecision(
  interrupt: InterruptPayload,
  decision: AuthorizationDecisionInput,
  requirement: string,
  verificationLayer?: VerificationLayerKind,
): WorkflowPendingInstall {
  const profiles = Array.isArray(interrupt.facts.installProfiles)
    ? interrupt.facts.installProfiles.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
  const evolutionTarget = evolutionTargetFromInterrupt(interrupt, decision.candidateId)
  const liveReplacement = evolutionTarget?.kind === 'github_exact' || evolutionTarget?.kind === 'owned_chain'
  const targetProfile = (evolutionTarget?.profile ?? profiles[0])?.trim()
  if (!targetProfile) {
    throw new EvolutionError(
      'invalid_input',
      'use_this requires at least one AutoEvo-capable install profile in the interrupt facts',
    )
  }
  if (evolutionTarget && !profiles.includes(evolutionTarget.profile)) {
    throw new EvolutionError(
      'invalid_input',
      'Replacement profile is not in the current AutoEvo-capable install profile set',
    )
  }
  const retention = evolutionTarget || liveReplacement ? 'persistent' : (decision.retention ?? 'temporary')
  if (retention !== 'temporary' && retention !== 'persistent') {
    throw new EvolutionError('invalid_input', 'decision retention must be temporary or persistent')
  }
  if (liveReplacement && decision.retention === 'temporary') {
    throw new EvolutionError(
      'invalid_input',
      'Replacing an installed plugin requires persistent retention',
    )
  }
  // Fail at the decision gate, while the interrupt is still open and the fresh
  // user turn is unconsumed, instead of deep inside install where the same
  // combination used to hard-fail the whole workflow.
  if (verificationLayer === 'manual_runtime' && retention === 'temporary') {
    throw new EvolutionError(
      'invalid_input',
      'This candidate verifies only at manual_runtime, which requires persistent retention; reconfirm persistent installation and a manual user test with the user, then resubmit the decision with retention persistent',
    )
  }
  return {
    targetProfile,
    retention,
    verificationTask: requirement,
    ...(liveReplacement && evolutionTarget ? {
      replacement: {
        profile: evolutionTarget.profile,
        packageName: evolutionTarget.packageName,
        oldSpecDigest: evolutionTarget.specDigest,
        oldDependencySpec: evolutionTarget.dependencySpec,
        ...(evolutionTarget.installationId ? { predecessorInstallationId: evolutionTarget.installationId } : {}),
      },
    } : {}),
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
  verificationLayer?: VerificationLayerKind
}): ValidatedResume {
  const target = resolveDecisionTarget(input.decision, input.interrupt)
  const install = input.decision.action === 'use_this'
    ? resolveInstallFromDecision(input.interrupt, input.decision, input.requirement, input.verificationLayer)
    : undefined
  const preview = input.guard.previewDecisionTurn(input.agent, input.interrupt)
  const userMessage = preview.message.normalize('NFKC').trim()
  if (!userMessage || userMessage.length > 2_000) {
    throw new EvolutionError('invalid_input', 'host user turn must contain 1 to 2000 characters')
  }
  const turn = input.guard.consumeDecisionTurn(input.agent, input.interrupt)
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
