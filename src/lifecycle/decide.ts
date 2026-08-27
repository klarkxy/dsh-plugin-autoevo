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
      ? '这份旧回执还停在市场安装状态。重新调用 capability_workflow，改走 Host 侧 GitHub topic 搜索。'
      : 'This older receipt is still parked on marketplace setup. Call capability_workflow again so Host-owned GitHub topic search can run.'
  }
  if (authorization.state === 'selection_required') {
    return zh
      ? '只把 snapshot 里的真实候选写成带序号短名单，先写在对话里，然后停。每行只写序号、名字、仓库和一句话说明；candidate_id 只用于随后的 resume，不要念给用户。不要提问，不要把官方 API、自建方案或“再搜一下”写成候选。parked 是成功停牌：本回合不要再调用任何工具。等用户回话后，把“两个都、前两个、全部、另一个、第二个、看看3”等映射为 candidate_id，立刻用当前 interrupt 允许的 navigation 调用 capability_workflow_resume；选候选阶段不要 use_this 或 modify_this。reuse_local 表示原样使用，不审查、不修改。Gate 1 的 enable_builtin 只冻结内置候选与目标 profile，随后必须停在新的最终确认，不能在这一回合启用。不要调用 ask_user。'
      : 'Write a numbered shortlist of real snapshot candidates in chat, then stop. Each row is index, name, repository, and one-line why; keep candidate_id for the later resume call and do not recite it. Do not ask questions, and do not invent official-API, build-it-yourself, or search-further rows. Parked is a successful stop: do not call any tools until the user replies. After the user replies, map natural language such as both, the first two, all, the other one, the second one, or look at 3 to candidate IDs and immediately call capability_workflow_resume with a currently allowed navigation. Do not send use_this or modify_this at selection. reuse_local means use unchanged: no review and no modification. Gate-1 enable_builtin only freezes the built-in candidate and target profile; it must then park at a fresh final confirmation and cannot enable anything in the same turn. Do not call ask_user.'
  }
  if (authorization.state === 'confirmation_required') {
    return zh
      ? '用两三句话写审查结论和风险，只展示当前合法动作，然后停。不要提问。本回合不要再调用任何工具。安全发现只是静态观察，不得推断用途。审查层为 manual_runtime 的候选需要用户在真实客户端手动测试，先向用户说明这一点。若 facts 提供 builtinEnablement，明确说明将为其中冻结的内置包、mount 和 profile 启用，并等待用户再次确认；确认时用 decision.enable_builtin 和该候选 id。用户要看其它候选时用 navigation；用户明确选择使用、修改、新建或先停时提交结构化 decision。采用的能力始终持久安装，公开决策不接受 retention。'
      : 'Summarize the review conclusion and risk in two or three sentences, show only legal actions, then stop. Do not ask questions. Do not call any tools until the user replies. Security findings are static observations; do not infer purpose. A manual_runtime candidate requires a manual user test in a real client; tell the user before the final choice. When facts include builtinEnablement, name the exact frozen built-in package, mount, and profile that would be enabled and wait for another user confirmation; submit decision.enable_builtin with that candidate id only after it arrives. For another candidate, use navigation. For an explicit use, modify, create, or stop choice, submit a structured decision. Adopted capabilities are always installed persistently, and public decisions do not accept retention.'
  }
  if (authorization.state === 'create_authorized') {
    return zh
      ? '用户允许新建。创建只在 Host 持有的受管子会话和托管 git 源中进行；不要用 cordis_define 代替这份施工。'
      : 'The user allowed create-new. Creation continues in this session on the Host-managed git source; do not use cordis_define instead of that construction.'
  }
  if (authorization.state === 'use_review') {
    return zh
      ? '用户选择使用这次审查的插件。工作流会安装它；不要另建一个替代品。卸了重装或再改一刀时，仍在同一条 workflow 上 resume。'
      : 'The user chose this reviewed plugin. The workflow will install it; do not create a replacement. To reinstall or patch again, resume this workflow.'
  }
  if (authorization.state === 'modify_review') {
    return zh
      ? '用户选择在这次审查上做最小修改。修改在 Host 持有的受管子会话和托管源中进行；不要提交本地路径。'
      : 'The user chose to improve this review. Modification continues in this session on the Host-managed source; do not supply a local path.'
  }
  if (authorization.state === 'reuse_local') {
    return zh
      ? '用户选择原样使用已有的本地能力。不要审查、修改或安装。'
      : 'The user chose the existing local capability unchanged. Do not review, modify, or install.'
  }
  if (authorization.state === 'enable_builtin') {
    return zh
      ? '用户已在新的确认回合允许启用所选的 Host 内置能力。工作流只可修改冻结的 profile mount。'
      : 'The user confirmed enabling the selected Host-bundled capability in a fresh turn. The workflow may mutate only the frozen profile mount.'
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
  if (action === 'enable_builtin') {
    return {
      state: 'enable_builtin',
      resolutionId,
      reason: 'The user confirmed the exact Host-bundled capability enablement in a fresh Gate-2 turn.',
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
  const suppliedRetention = (decision as AuthorizationDecisionInput & { retention?: unknown }).retention
  if (suppliedRetention !== undefined) {
    throw new EvolutionError('invalid_input', 'Authorization decisions do not accept retention under Policy V11')
  }
  const option = interrupt.options.find((item) => item.id === decision.action)!
  const needsCandidate = decision.action === 'use_this'
    || decision.action === 'modify_this'
    || decision.action === 'enable_builtin'
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
  _verificationLayer?: VerificationLayerKind,
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
  const retention = 'persistent' as const
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
