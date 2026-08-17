import type {
  DecisionAction,
  DecisionPhase,
  DecisionReceipt,
  LocalCapabilityCandidate,
  RemotePluginCandidate,
  ResolutionAuthorization,
  ReviewRecord,
} from '../contracts.js'
import { EvolutionError } from '../errors.js'
import { hashObject } from '../state/hashes.js'

export const LABEL_CREATE_NEW = 'Create new'
export const LABEL_CREATE_NEW_ZH = '新建'
export const LABEL_STOP = 'Stop for now'
export const LABEL_STOP_ZH = '先停'
export const LABEL_USE_LOCAL = 'Use existing local capability'
export const LABEL_USE_LOCAL_ZH = '用已有的本地能力'
export const LABEL_SEARCH_MORE = 'Search for plugins anyway'
export const LABEL_SEARCH_MORE_ZH = '继续找插件'
export const LABEL_USE_THIS = 'Use this plugin'
export const LABEL_USE_THIS_ZH = '用这个'
export const LABEL_MODIFY_THIS = 'Improve this plugin'
export const LABEL_MODIFY_THIS_ZH = '在这个上改'

const CREATE_NEW_RE = /新建|从零|自己写|自己做|create new|from scratch|没有合适|都不行|都不想用|都不合适/iu
const STOP_RE = /先停|停下|停止|取消|算了|stop for now|\bstop\b|\bcancel\b/iu
const USE_THIS_RE = /用这个|就用这个|用它吧|安装这个|use this/iu
const MODIFY_RE = /在这个上改|改这个|改进这个|improve this|modify this/iu
const USE_LOCAL_RE = /用已有|本地就有|用现成|use existing local/iu
const SEARCH_MORE_RE = /继续找|再搜|search for plugins|search more/iu
const ALL_RE = /都看看|全都|全部审|all of them|review all/iu
const OWNER_REPO_RE = /(?<![A-Za-z0-9_.-])[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?![A-Za-z0-9_.-])/gu
const INDEX_RE = /(?:选\s*|第|#)([一二两三四五六七八九十]|[1-9]\d*)(?:个|号)?/gu
const FIND_PLUGIN = 'awesome-dsh-plugin/dsh-find-plugin'

const CHINESE_INDEX: Record<string, number> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
}

export type ClaimedDecisionAction = DecisionAction | 'search_more'

export interface ResolvedDecision {
  phase: DecisionPhase
  action: DecisionAction
  selectedRepositories: string[]
  searchMore: boolean
}

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
  action: DecisionAction,
  selectedRepositories: string[],
  extras: Partial<Pick<DecisionReceipt, 'reviewId' | 'reviewIdentity' | 'userMessage'>> = {},
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
      ? '市场插件还在安装。批准后等热加载，不要把 dsh-find-plugin 当成这次要的能力。'
      : 'The marketplace plugin is still installing. Approve if asked, then wait for hot-load. Do not treat dsh-find-plugin as the requested capability.'
  }
  if (authorization.state === 'selection_required') {
    return zh
      ? '先在对话里说明每个候选：仓库名、它是干什么的、为何被搜到、星数。不要调用 ask_user。等用户回话后，再调用 capability_decide 记录要审哪些仓库、新建或先停。'
      : 'Present each candidate in chat (repository, what it does, why it matched, stars). Do not call ask_user. After the user replies, call capability_decide to record inspect / create new / stop.'
  }
  if (authorization.state === 'confirmation_required') {
    return zh
      ? '先在对话里讲清这次审查：匹配程度、风险、缺什么、主要发现。不要调用 ask_user。等用户回话后，再调用 capability_decide（用这个 / 在这个上改 / 新建 / 先停）。'
      : 'Explain the review in chat (fit, risk, missing pieces, findings). Do not call ask_user. After the user replies, call capability_decide (use this / improve this / create new / stop).'
  }
  if (authorization.state === 'scratch_ready') {
    return zh
      ? '用户允许新建一次。这不是立刻动手的命令；确认仍要新建后再定义。'
      : 'The user allowed one new plugin. That is not a mandate to start building.'
  }
  if (authorization.state === 'use_review') {
    return zh
      ? '用户选择使用这次审查的插件。去安装，不要另建一个替代品。卸了重装或再改一刀时，仍用这条 resolution 再 capability_decide，不要新开 resolve。'
      : 'The user chose this reviewed plugin. Install it; do not create a replacement. To reinstall or patch again, call capability_decide on this resolution; do not start a new resolve.'
  }
  if (authorization.state === 'modify_review') {
    return zh
      ? '用户选择在这次审查上做最小修改。改完后对本地检出再审，base_review_id 用这条审查或上一刀本地审查，不要新开 capability_resolve。'
      : 'The user chose to improve this review. Modify it minimally, then review the local checkout with base_review_id set to this review or the previous local review. Do not start a new capability_resolve.'
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

function parseIndexToken(token: string): number | undefined {
  if (CHINESE_INDEX[token] !== undefined) return CHINESE_INDEX[token]
  const numeric = Number(token)
  return Number.isInteger(numeric) && numeric > 0 ? numeric : undefined
}

export function mentionedRepositories(
  message: string,
  remotes: readonly RemotePluginCandidate[],
): string[] {
  const found = new Set<string>()
  if (ALL_RE.test(message)) {
    for (const candidate of remotes) found.add(candidate.repository)
    return [...found]
  }

  for (const candidate of remotes) {
    const haystacks = [candidate.repository, candidate.name, candidate.repository.split('/')[1] ?? '']
    if (haystacks.some((part) => part && message.toLowerCase().includes(part.toLowerCase()))) {
      found.add(candidate.repository)
    }
  }

  for (const match of message.matchAll(INDEX_RE)) {
    const token = match[1] ?? match[2]
    if (!token) continue
    const index = parseIndexToken(token)
    if (index === undefined) continue
    const candidate = remotes[index - 1]
    if (candidate) found.add(candidate.repository)
  }

  for (const match of message.matchAll(OWNER_REPO_RE)) {
    const repository = match[0]
    if (repository.toLowerCase() === FIND_PLUGIN) continue
    const known = remotes.find((item) => item.repository.toLowerCase() === repository.toLowerCase())
    found.add(known?.repository ?? repository)
  }

  return [...found]
}

function actionKeywordMatches(action: ClaimedDecisionAction, message: string): boolean {
  if (action === 'stop') return STOP_RE.test(message)
  if (action === 'create_new') return CREATE_NEW_RE.test(message)
  if (action === 'search_more') return SEARCH_MORE_RE.test(message)
  if (action === 'use_local') return USE_LOCAL_RE.test(message)
  if (action === 'modify_this') return MODIFY_RE.test(message)
  if (action === 'use_this') return USE_THIS_RE.test(message)
  return ALL_RE.test(message)
}

function inferAction(
  message: string,
  remotes: readonly RemotePluginCandidate[],
  locals: readonly LocalCapabilityCandidate[],
  phase: DecisionPhase,
): { action?: ClaimedDecisionAction, selectedRepositories: string[] } {
  const selected = mentionedRepositories(message, remotes)
  if (STOP_RE.test(message)) return { action: 'stop', selectedRepositories: [] }
  if (CREATE_NEW_RE.test(message)) return { action: 'create_new', selectedRepositories: [] }
  if (SEARCH_MORE_RE.test(message)) return { action: 'search_more', selectedRepositories: [] }
  if (USE_LOCAL_RE.test(message)) {
    return locals.length > 0
      ? { action: 'use_local', selectedRepositories: [] }
      : { selectedRepositories: [] }
  }
  if (phase === 'gate2' && MODIFY_RE.test(message)) {
    return { action: 'modify_this', selectedRepositories: selected }
  }
  if (phase === 'gate2' && USE_THIS_RE.test(message)) {
    return { action: 'use_this', selectedRepositories: selected }
  }
  if (selected.length > 0) return { action: 'inspect', selectedRepositories: selected }
  return { selectedRepositories: [] }
}

export function resolveDecision(input: {
  userMessage: string
  claimedAction?: ClaimedDecisionAction
  claimedRepositories?: string[]
  remotes: readonly RemotePluginCandidate[]
  locals: readonly LocalCapabilityCandidate[]
  phase: DecisionPhase
}): ResolvedDecision {
  const userMessage = input.userMessage.normalize('NFKC').trim()
  if (!userMessage || userMessage.length > 2_000) {
    throw new EvolutionError('invalid_input', 'user_message must contain 1 to 2000 characters')
  }

  const inferred = inferAction(userMessage, input.remotes, input.locals, input.phase)
  if (input.claimedAction && inferred.action && input.claimedAction !== inferred.action) {
    throw new EvolutionError(
      'invalid_input',
      'The claimed action does not match the user message',
      { claimedAction: input.claimedAction, inferredAction: inferred.action },
    )
  }
  if (input.claimedAction && !inferred.action && !actionKeywordMatches(input.claimedAction, userMessage)) {
    throw new EvolutionError(
      'invalid_input',
      'The claimed action does not match the user message',
      { claimedAction: input.claimedAction },
    )
  }
  const action = input.claimedAction ?? inferred.action
  if (!action) {
    throw new EvolutionError(
      'invalid_input',
      'Could not read a decision from the user message. Ask them which repository to inspect, or to create new / stop.',
      { userMessage: userMessage.slice(0, 200) },
    )
  }
  if (action === 'use_local' && input.locals.length === 0) {
    throw new EvolutionError('invalid_input', 'There is no local capability on this resolution to reuse')
  }
  if ((action === 'use_this' || action === 'modify_this') && input.phase !== 'gate2') {
    throw new EvolutionError(
      'invalid_input',
      'Name the repository to inspect first; use-this and improve-this are only valid after a review',
    )
  }

  if (action === 'search_more') {
    return { phase: 'gate1', action: 'inspect', selectedRepositories: [], searchMore: true }
  }

  let selectedRepositories = inferred.selectedRepositories
  if (input.claimedRepositories && input.claimedRepositories.length > 0) {
    const claimed = input.claimedRepositories.map((item) => item.trim()).filter(Boolean)
    if (action !== 'inspect' && action !== 'use_this' && action !== 'modify_this') {
      throw new EvolutionError('invalid_input', 'repositories are only valid when inspecting or confirming a review')
    }
    for (const repository of claimed) {
      const known = input.remotes.find((item) => item.repository.toLowerCase() === repository.toLowerCase())
      const normalized = known?.repository ?? repository
      if (!selectedRepositories.some((item) => item.toLowerCase() === normalized.toLowerCase())
        && !ALL_RE.test(userMessage)) {
        throw new EvolutionError(
          'invalid_input',
          'A claimed repository was not mentioned in the user message',
          { repository: normalized },
        )
      }
    }
    selectedRepositories = claimed.map((repository) => {
      const known = input.remotes.find((item) => item.repository.toLowerCase() === repository.toLowerCase())
      return known?.repository ?? repository
    })
  }

  const phase: DecisionPhase = action === 'use_this' || action === 'modify_this' ? 'gate2' : 'gate1'

  return {
    phase,
    action,
    selectedRepositories,
    searchMore: false,
  }
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
