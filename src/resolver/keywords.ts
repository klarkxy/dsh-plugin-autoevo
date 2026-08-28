const STOP_WORDS = new Set([
  'agent', 'ability', 'capability', 'current', 'please', 'plugin', 'support', 'task', 'tool',
  'want', 'with', 'find', 'install', 'use', 'make', 'need', 'discover', 'modify', 'new',
  'call', 'enable', 'execute', 'invoke', 'provide', 'run', 'take',
  'a', 'an', 'the', 'as', 'at', 'by', 'for', 'from', 'into', 'of', 'on', 'to',
  'clarification', 'clarify', 'clarified',
  '需要', '希望', '可以', '帮我', '功能', '能力', '插件', '工具', '查找', '安装', '使用', '修改', '新建',
])
const CLARIFICATION_PROTOCOL_RE = /(?:^|\n)\s*clarification\s*:\s*/giu
const OPTION_ONLY_CLARIFICATION_RE = /^(?:[0-9]{1,2}|[a-d])(?:[.．、:：)）]\s*)?$|^(?:选项|option)\s*[0-9]{1,2}$|^第[一二三四五1-5]个$|^(?:前者|后者)$|^(?:yes|no|y|n|ok|okay)$/iu

const HOST_GENERIC_TERMS = new Set([
  'dsh', 'deepseek', 'harness', 'session', 'cli', 'app', 'user',
  'agentic', 'coding', 'api', 'chat', 'completion', 'completions', 'key', 'model', 'service',
  'com', 'www', 'html', 'http', 'https',
])

const GENERIC_TERMS = new Set([
  'plugin', 'tool', 'api', 'content', 'search', 'build', 'create', 'platform',
  '插件', '工具', '接口', '内容', '搜索', '构建', '创建', '平台',
])

export interface CapabilityAnchor {
  key: string
  aliases: string[]
  weight: number
  generic: boolean
  product: boolean
}

export function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
}

export function normalizeDiscoveryQueries(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const queries: string[] = []
  for (const value of values) {
    const normalized = value.normalize('NFKC')
      .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, 120)
    const identity = normalized.toLocaleLowerCase('en-US')
    if (normalized.length < 2 || seen.has(identity)) continue
    seen.add(identity)
    queries.push(normalized)
  }
  return queries
}

/** Host validates Agent search plans but never rewrites their semantic terms. */
export function isConciseDiscoveryQuery(value: string): boolean {
  const normalized = value.normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (normalized.length < 2 || normalized.length > 80) return false
  if (/\b(?:https?|topic):/iu.test(normalized)) return false
  const atoms = normalized.match(/[a-z0-9][a-z0-9.+-]*|[\p{Script=Han}]+/giu) ?? []
  return atoms.length >= 1 && atoms.length <= 2
}

/** Drop the Host protocol label so it cannot become a GitHub search term. */
export function stripDiscoveryProtocol(requirement: string): string {
  return requirement.replace(CLARIFICATION_PROTOCOL_RE, '\n')
}

export function isOptionOnlyClarification(answer: string): boolean {
  const normalized = answer.normalize('NFKC').replace(/\s+/gu, ' ').trim()
  return normalized.length > 0 && OPTION_ONLY_CLARIFICATION_RE.test(normalized)
}

/**
 * Search text is the original requirement plus one raw clarification answer.
 * Numbered/option-only replies and the "Clarification:" label are not searchable.
 */
export function composeDiscoveryRequirement(requirement: string, clarificationAnswer?: string): string {
  const answer = clarificationAnswer?.trim() ?? ''
  if (!answer || isOptionOnlyClarification(answer)) return requirement
  return `${requirement}\n\n${answer}`
}

export function isNameDropMention(text: string, alias: string): boolean {
  return listSeparatorsNear(text, alias) >= 2
}

export function isHeavyNameDropMention(text: string, alias: string): boolean {
  return listSeparatorsNear(text, alias) >= 4
}

function listSeparatorsNear(text: string, alias: string): number {
  const haystack = normalizeSearchText(text)
  const needle = normalizeSearchText(alias)
  const index = needle ? haystack.indexOf(needle) : -1
  if (index < 0) return 0
  const vicinity = haystack.slice(Math.max(0, index - 120), index + needle.length + 120)
  return (vicinity.match(/[,/|、]|\b(?:and|or|via|plus)\b/gu) ?? []).length
}

const MARKETPLACE_QUERY_LIMIT = 5

function englishTerms(normalized: string): string[] {
  return (normalized.match(/[a-z][a-z0-9.+]{2,}/g) ?? [])
    // Platform/Host words remain searchable anchors, but their low
    // specificity keeps them behind the user's distinctive capability terms.
    // Dropping them entirely turns mixed-language requests such as
    // "<platform> 插件" into an unscoped generic search.
    .filter((term) => !STOP_WORDS.has(term))
}

function cjkRequirementPhrases(normalized: string): string[] {
  return (normalized.match(/[\p{Script=Han}]{2,32}/gu) ?? [])
    .map((phrase) => phrase
      // Strip only common request scaffolding. The remaining text is kept as
      // written so an unfamiliar capability can still be searched verbatim.
      .replace(/^(?:我(?:们)?|请|帮我|需要|想要|希望|能否|可以|一个|能够|用于|实现|支持|把|将|给|在|的)+/u, '')
      .replace(/(?:的能力|的插件|功能|能力)$/u, '')
      .trim())
    .filter((phrase) => phrase.length >= 2)
}

function termSpecificity(term: string): number {
  if (GENERIC_TERMS.has(term) || HOST_GENERIC_TERMS.has(term)) return 0.1
  return 1 + Math.min(0.4, Math.max(0, term.length - 8) / 30)
}

function adjacentEnglishPhrases(terms: readonly string[]): string[] {
  const candidates: Array<{ value: string; score: number; index: number }> = []
  for (let index = 0; index < terms.length; index += 1) {
    for (const width of [3, 2, 1]) {
      const phrase = terms.slice(index, index + width)
      if (phrase.length !== width) continue
      const score = phrase.reduce((total, term) => total + termSpecificity(term), 0) / width
        + (width > 1 ? 0.15 : 0)
      candidates.push({ value: phrase.join(' '), score, index })
    }
  }
  return candidates
    .sort((left, right) => right.score - left.score || left.index - right.index || right.value.length - left.value.length)
    .map((candidate) => candidate.value)
}

function boundedRequirementQueries(normalized: string): string[] {
  const terms = englishTerms(normalized)
  const hostContext = [...new Set(terms.filter((term) => HOST_GENERIC_TERMS.has(term)))]
    .slice(0, 1)
  const ranked = [...new Set([
    ...adjacentEnglishPhrases(terms),
    ...cjkRequirementPhrases(normalized),
  ].map(normalizeSearchText).filter(Boolean))]
    .filter((query) => !hostContext.includes(query))
  return [...ranked.slice(0, MARKETPLACE_QUERY_LIMIT - hostContext.length), ...hostContext]
}

export function capabilityQueries(requirement: string): string[] {
  const normalized = normalizeSearchText(stripDiscoveryProtocol(requirement))
  return boundedRequirementQueries(normalized)
}

/**
 * Queries come from adjacent requirement terms, then from a small bilingual
 * capability vocabulary.  Ranking lowers Host/generic words but preserves the
 * user's word order inside every generated phrase.
 */
export function marketplaceSearchQueries(requirement: string): string[] {
  const normalized = normalizeSearchText(stripDiscoveryProtocol(requirement))
  return boundedRequirementQueries(normalized)
}

export function capabilityTerms(requirement: string): string[] {
  const normalized = normalizeSearchText(stripDiscoveryProtocol(requirement))
  const terms = new Set<string>()
  for (const query of capabilityQueries(requirement)) {
    terms.add(query)
    for (const token of query.split(' ')) if (token.length >= 3) terms.add(token)
  }
  for (const token of normalized.match(/[a-z][a-z0-9.+]{2,}/g) ?? []) {
    if (!STOP_WORDS.has(token)) terms.add(token)
  }
  for (const phrase of cjkRequirementPhrases(normalized)) terms.add(phrase)
  return [...terms]
}

export function capabilityAnchors(requirement: string): CapabilityAnchor[] {
  const normalized = normalizeSearchText(stripDiscoveryProtocol(requirement))
  const rawEnglish = englishTerms(normalized)
  const dynamicTerms = rawEnglish.length > 0 ? rawEnglish : cjkRequirementPhrases(normalized)
  const anchors: CapabilityAnchor[] = []
  for (const term of [...new Set(dynamicTerms)]) {
    const normalizedTerm = normalizeSearchText(term)
    if (!normalizedTerm) continue
    const generic = GENERIC_TERMS.has(normalizedTerm) || HOST_GENERIC_TERMS.has(normalizedTerm)
    anchors.push({
      key: normalizedTerm,
      aliases: [normalizedTerm],
      weight: generic ? 0.12 : termSpecificity(normalizedTerm),
      generic,
      product: false,
    })
  }
  return anchors
}
