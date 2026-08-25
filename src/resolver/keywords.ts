const STOP_WORDS = new Set([
  'agent', 'ability', 'capability', 'current', 'please', 'plugin', 'support', 'task', 'tool',
  'want', 'with', '需要', '希望', '可以', '帮我', '功能', '能力', '插件', '工具',
])

const HOST_GENERIC_TERMS = new Set([
  'dsh', 'deepseek', 'harness', 'session', 'cli', 'app', 'user',
  'agentic', 'coding', 'api', 'chat', 'completion', 'completions', 'key', 'model', 'service',
  'com', 'www', 'html', 'http', 'https',
])

const GENERIC_TERMS = new Set([
  'plugin', 'tool', 'api', 'content', 'search', 'build', 'create', 'platform',
  '插件', '工具', '接口', '内容', '搜索', '构建', '创建', '平台',
])

/** Peer agent/CLI names. A keyword that only appears in a list of these is a name-drop. */
const PEER_PRODUCTS = [
  'aider',
  'antigravity',
  'chatgpt',
  'claude',
  'claude code',
  'claudecode',
  'codex',
  'copilot',
  'cursor',
  'gemini',
  'grok',
  'hermes',
  'kiro',
  'openclaw',
  'opencode',
  'trae',
  'windsurf',
] as const

const CONCEPTS: ReadonlyArray<{ patterns: RegExp[]; queries: string[] }> = [
  {
    patterns: [/聊天记录/u, /对话记录/u, /整个对话/u, /当前对话/u, /conversation\s+(?:history|record)/iu, /chat\s+(?:history|record|transcript)/iu, /transcript/iu],
    queries: ['conversation export', 'chat transcript export'],
  },
  {
    patterns: [/导出/u, /转化成/u, /转换成/u, /export/iu, /render/iu, /convert/iu],
    queries: ['export', 'render'],
  },
  {
    patterns: [/powershell/iu, /pwsh/iu, /命令行/u, /shell command/iu],
    queries: ['powershell', 'pwsh', 'shell', 'command'],
  },
  {
    // Capturing an image of something. Kept separate from the browser
    // concept so DOM/PNG-heavy wording cannot evict "screenshot", and so
    // "截 DSH 自己的 DOM" does not get routed to external-browser drivers.
    patterns: [/截图/u, /截屏/u, /截成/u, /长图/u, /screenshot/iu, /screen\s*capture/iu, /long\s+(?:png|image)/iu],
    queries: ['screenshot', 'screen capture'],
  },
  {
    patterns: [/浏览器/u, /网页/u, /chrome/iu, /browser/iu, /playwright/iu],
    queries: ['browser automation', 'playwright', 'web testing'],
  },
  {
    patterns: [/telegram/iu, /电报/u, /forum topic/iu],
    queries: ['telegram', 'telegram bot', 'messaging'],
  },
  {
    patterns: [/计算/u, /算式/u, /calculator/iu, /calculation/iu, /math/iu],
    queries: ['calculator', 'calculation', 'math'],
  },
  {
    patterns: [/科学计数法/u, /scientific notation/iu, /exponential notation/iu],
    queries: ['scientific notation', 'calculator'],
  },
  {
    patterns: [/pdf/iu, /文档/u],
    queries: ['pdf', 'document processing'],
  },
  {
    patterns: [/邮件/u, /email/iu, /mail/iu],
    queries: ['email', 'mail'],
  },
  {
    patterns: [/数据库/u, /database/iu, /sql/iu],
    queries: ['database', 'sql'],
  },
  {
    patterns: [/图片/u, /图像/u, /image/iu, /vision/iu],
    queries: ['image', 'vision'],
  },
  {
    patterns: [/zhihu/iu, /知乎/u],
    queries: ['zhihu', 'zhihu search'],
  },
]

interface CapabilityAnchorDefinition {
  key: string
  patterns: RegExp[]
  aliases: string[]
  weight: number
  /** Product names identify a target, not the operation the user needs. */
  product?: boolean
}

const ANCHOR_DEFINITIONS: ReadonlyArray<CapabilityAnchorDefinition> = [
  { key: 'grok', patterns: [/\bgrok(?:\s+build)?\b/iu, /\bxai\b/iu], aliases: ['grok build', 'grok', 'xai'], weight: 1.4, product: true },
  { key: 'codex', patterns: [/\bopenai\s+codex\b/iu, /\bcodex(?:\s+cli)?\b/iu], aliases: ['openai codex', 'codex'], weight: 1.4, product: true },
  { key: 'execution', patterns: [/\b(?:call|invoke|run|execute)\b/iu, /调用/u, /执行/u], aliases: ['call', 'invoke', 'run', 'execute', '调用', '执行'], weight: 0.8 },
  { key: 'auto-review', patterns: [/\bauto(?:matic)?\s+review\b/iu, /自动(?:审查|评审)/u], aliases: ['auto review', 'automatic review', 'automated review', '自动审查', '自动评审'], weight: 0.95 },
  { key: 'powershell', patterns: [/powershell/iu, /pwsh/iu, /命令行/u, /shell command/iu], aliases: ['powershell', 'pwsh', '命令行', 'shell command'], weight: 0.9 },
  { key: 'conversation', patterns: [/聊天记录/u, /对话记录/u, /整个对话/u, /当前对话/u, /conversation\s+(?:history|record)/iu, /chat\s+(?:history|record|transcript)/iu, /transcript/iu], aliases: ['聊天记录', '对话记录', '整个对话', '当前对话', 'conversation', 'conversation history', 'chat history', 'chat transcript', 'transcript'], weight: 0.95 },
  { key: 'export', patterns: [/导出/u, /转化成/u, /转换成/u, /export/iu, /render/iu, /convert/iu], aliases: ['导出', '转化成', '转换成', 'export', 'render', 'convert'], weight: 0.9 },
  { key: 'browser', patterns: [/浏览器/u, /网页/u, /chrome/iu, /browser/iu, /playwright/iu], aliases: ['浏览器', '网页', 'chrome', 'browser', 'playwright', 'browser automation', 'web testing'], weight: 0.65 },
  { key: 'screenshot', patterns: [/截图/u, /截屏/u, /截成/u, /长图/u, /screenshot/iu, /screen\s*capture/iu, /long\s+(?:png|image)/iu], aliases: ['截图', '截屏', '长图', '长截图', 'screenshot', 'screen capture', 'long png', 'long image'], weight: 0.7 },
  { key: 'telegram', patterns: [/telegram/iu, /电报/u, /forum topic/iu], aliases: ['telegram', '电报', 'forum topic', 'messaging'], weight: 0.9 },
  { key: 'calculation', patterns: [/计算/u, /算式/u, /calculator/iu, /calculation/iu, /math/iu], aliases: ['计算', '算式', 'calculator', 'calculation', 'math'], weight: 0.85 },
  { key: 'scientific-notation', patterns: [/科学计数法/u, /scientific notation/iu, /exponential notation/iu], aliases: ['科学计数法', 'scientific notation', 'exponential notation'], weight: 0.95 },
  { key: 'pdf', patterns: [/pdf/iu, /文档/u], aliases: ['pdf', '文档', 'document processing'], weight: 0.8 },
  { key: 'email', patterns: [/邮件/u, /email/iu, /mail/iu], aliases: ['邮件', 'email', 'mail'], weight: 0.8 },
  { key: 'database', patterns: [/数据库/u, /database/iu, /sql/iu], aliases: ['数据库', 'database', 'sql'], weight: 0.85 },
  { key: 'image', patterns: [/图片/u, /图像/u, /image/iu, /vision/iu], aliases: ['图片', '图像', 'image', 'vision'], weight: 0.8 },
  { key: 'time', patterns: [/时间/u, /耗时/u, /当前时刻/u, /\btime(?:stamp)?\b/iu, /\belapsed\b/iu], aliases: ['时间', '当前时间', '耗时', 'time', 'current time', 'timestamp', 'elapsed', 'elapsed time'], weight: 0.9 },
  { key: 'tmux', patterns: [/tmux/iu, /窗格/u], aliases: ['tmux', 'pane', 'window location', '窗格'], weight: 0.9 },
  // Zhihu is a domain-specific anchor, so it outweighs generic actions such
  // as searching or creating content in mixed requirements.
  { key: 'zhihu', patterns: [/zhihu/iu, /知乎/u], aliases: ['zhihu', '知乎', 'zhihu search'], weight: 1.4 },
]

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

/**
 * True when `alias` is only one item in a laundry list of peer agents/CLIs.
 * A focused "call Codex from DSH" mention is not a name-drop.
 */
export function isNameDropMention(text: string, alias: string): boolean {
  return peerProductMentions(text, alias) >= 2
}

/** A long product catalogue is never corroborating capability evidence. */
export function isHeavyNameDropMention(text: string, alias: string): boolean {
  return peerProductMentions(text, alias) >= 4
}

function peerProductMentions(text: string, alias: string): number {
  const haystack = normalizeSearchText(text)
  const needle = normalizeSearchText(alias)
  if (!needle || !haystack.includes(needle)) return 0
  let peers = 0
  for (const product of PEER_PRODUCTS) {
    if (product === needle || needle.includes(product) || product.includes(needle)) continue
    if (haystack.includes(product)) peers += 1
  }
  return peers
}

export function capabilityQueries(requirement: string): string[] {
  const normalized = normalizeSearchText(requirement)
  const queries: string[] = []
  for (const concept of CONCEPTS) {
    if (concept.patterns.some((pattern) => pattern.test(normalized))) queries.push(...concept.queries)
  }
  const english = normalized.match(/[a-z][a-z0-9.+]{2,}/g) ?? []
  queries.push(...english.filter((token) => !STOP_WORDS.has(token)))
  if (queries.length === 0) {
    const cjk = normalized.match(/[\p{Script=Han}]{2,8}/gu) ?? []
    queries.push(...cjk.slice(0, 2))
  }
  return [...new Set(queries)].slice(0, 5)
}

const MARKETPLACE_QUERY_LIMIT = 5

/**
 * Phrase queries for scoped GitHub topic search. Keep word order from the
 * requirement so GitHub can rank "grok build"; do not reduce the intent to one token.
 *
 * Slot allocation: one representative query per matched concept comes first,
 * then the requirement's own English phrases, then remaining concept queries.
 * Ad-hoc tokens (DOM/PNG/npm) must not evict curated domain terms — a
 * screenshot requirement once lost its "screenshot" query this way and the
 * shortlist degraded to external-browser drivers.
 */
export function marketplaceSearchQueries(requirement: string): string[] {
  const normalized = normalizeSearchText(requirement)
  const matchedConcepts = CONCEPTS.filter((concept) => concept.patterns.some((pattern) => pattern.test(normalized)))
  const english = (normalized.match(/[a-z][a-z0-9.+]{2,}/g) ?? [])
    .filter((token) => !STOP_WORDS.has(token) && !HOST_GENERIC_TERMS.has(token))

  const queries: string[] = []
  const hasConversation = matchedConcepts.some((concept) => concept.queries[0] === 'conversation export')
  const hasExport = matchedConcepts.some((concept) => concept.queries[0] === 'export')
  const hasScreenshot = matchedConcepts.some((concept) => concept.queries[0] === 'screenshot')
  if (hasConversation && hasExport && hasScreenshot) {
    queries.push('conversation export', 'chat transcript export', 'conversation long png', 'chat to image', 'screenshot')
  } else if (hasConversation && hasExport) {
    queries.push('conversation export', 'chat transcript export')
  } else if (hasConversation && hasScreenshot) {
    queries.push('conversation long png', 'chat to image', 'screenshot')
  }
  for (const concept of matchedConcepts) queries.push(concept.queries[0]!)

  if (english.length >= 2) {
    queries.push(english.slice(0, 4).join(' '))
    queries.push(english.slice(0, 2).join(' '))
    if (english.length >= 3) queries.push(english.slice(1, 3).join(' '))
  } else if (english.length === 1) {
    queries.push(english[0]!)
  }

  for (const concept of matchedConcepts) queries.push(...concept.queries.slice(1))

  if (english.length === 0 && matchedConcepts.length === 0) {
    const cjk = (normalized.match(/[\p{Script=Han}]{2,8}/gu) ?? [])
      .filter((phrase) => !STOP_WORDS.has(phrase) && !HOST_GENERIC_TERMS.has(phrase) && !GENERIC_TERMS.has(phrase))
    queries.push(...cjk.slice(0, 2))
  }

  return [...new Set(queries.map((query) => query.trim()).filter(Boolean))].slice(0, MARKETPLACE_QUERY_LIMIT)
}

export function capabilityTerms(requirement: string): string[] {
  const normalized = normalizeSearchText(requirement)
  const terms = new Set<string>()
  for (const query of capabilityQueries(requirement)) {
    terms.add(query)
    for (const token of query.split(' ')) if (token.length >= 3) terms.add(token)
  }
  for (const token of normalized.match(/[a-z][a-z0-9.+]{2,}/g) ?? []) {
    if (!STOP_WORDS.has(token)) terms.add(token)
  }
  for (const phrase of normalized.match(/[\p{Script=Han}]{2,8}/gu) ?? []) terms.add(phrase)
  return [...terms]
}

export function capabilityAnchors(requirement: string): CapabilityAnchor[] {
  const normalized = normalizeSearchText(requirement)
  const anchors: CapabilityAnchor[] = []
  const matchedDefinitions = ANCHOR_DEFINITIONS.filter((definition) => definition.patterns.some((pattern) => pattern.test(normalized)))

  for (const definition of matchedDefinitions) {
    anchors.push({
      key: definition.key,
      aliases: definition.aliases.map(normalizeSearchText).filter(Boolean),
      weight: definition.weight,
      generic: false,
      product: definition.product ?? false,
    })
  }

  // A known concept already supplies the useful semantic anchors.  Avoid
  // diluting it with incidental prose such as "take" or "send".
  if (anchors.length > 0) return anchors

  for (const term of capabilityTerms(requirement)) {
    const normalizedTerm = normalizeSearchText(term)
    if (!normalizedTerm) continue
    const generic = GENERIC_TERMS.has(normalizedTerm)
    anchors.push({
      key: normalizedTerm,
      aliases: [normalizedTerm],
      weight: generic ? 0.12 : 0.75,
      generic,
      product: false,
    })
  }
  return anchors
}
