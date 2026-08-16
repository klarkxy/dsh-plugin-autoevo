const STOP_WORDS = new Set([
  'agent', 'ability', 'capability', 'current', 'please', 'plugin', 'support', 'task', 'tool',
  'want', 'with', '需要', '希望', '可以', '帮我', '功能', '能力', '插件', '工具',
])

const GENERIC_TERMS = new Set([
  'plugin', 'tool', 'api', 'content', 'search', 'build', 'create', 'platform',
  '插件', '工具', '接口', '内容', '搜索', '构建', '创建', '平台',
])

const CONCEPTS: ReadonlyArray<{ patterns: RegExp[]; queries: string[] }> = [
  {
    patterns: [/powershell/iu, /pwsh/iu, /命令行/u, /shell command/iu],
    queries: ['powershell', 'pwsh', 'shell', 'command'],
  },
  {
    patterns: [/浏览器/u, /网页/u, /截图/u, /chrome/iu, /browser/iu, /screenshot/iu, /playwright/iu],
    queries: ['browser automation', 'playwright', 'screenshot', 'web testing'],
  },
  {
    patterns: [/telegram/iu, /电报/u, /forum topic/iu, /消息/u],
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
}

const ANCHOR_DEFINITIONS: ReadonlyArray<CapabilityAnchorDefinition> = [
  { key: 'powershell', patterns: [/powershell/iu, /pwsh/iu, /命令行/u, /shell command/iu], aliases: ['powershell', 'pwsh', '命令行', 'shell command'], weight: 0.9 },
  { key: 'browser', patterns: [/浏览器/u, /网页/u, /chrome/iu, /browser/iu, /playwright/iu], aliases: ['浏览器', '网页', 'chrome', 'browser', 'playwright', 'browser automation', 'web testing'], weight: 0.65 },
  { key: 'screenshot', patterns: [/截图/u, /screenshot/iu], aliases: ['截图', 'screenshot'], weight: 0.7 },
  { key: 'telegram', patterns: [/telegram/iu, /电报/u, /forum topic/iu, /消息/u], aliases: ['telegram', '电报', 'forum topic', '消息', 'messaging'], weight: 0.9 },
  { key: 'calculation', patterns: [/计算/u, /算式/u, /calculator/iu, /calculation/iu, /math/iu], aliases: ['计算', '算式', 'calculator', 'calculation', 'math'], weight: 0.85 },
  { key: 'scientific-notation', patterns: [/科学计数法/u, /scientific notation/iu, /exponential notation/iu], aliases: ['科学计数法', 'scientific notation', 'exponential notation'], weight: 0.95 },
  { key: 'pdf', patterns: [/pdf/iu, /文档/u], aliases: ['pdf', '文档', 'document processing'], weight: 0.8 },
  { key: 'email', patterns: [/邮件/u, /email/iu, /mail/iu], aliases: ['邮件', 'email', 'mail'], weight: 0.8 },
  { key: 'database', patterns: [/数据库/u, /database/iu, /sql/iu], aliases: ['数据库', 'database', 'sql'], weight: 0.85 },
  { key: 'image', patterns: [/图片/u, /图像/u, /image/iu, /vision/iu], aliases: ['图片', '图像', 'image', 'vision'], weight: 0.8 },
  // Zhihu is a domain-specific anchor, so it outweighs generic actions such
  // as searching or creating content in mixed requirements.
  { key: 'zhihu', patterns: [/zhihu/iu, /知乎/u], aliases: ['zhihu', '知乎', 'zhihu search'], weight: 1.4 },
]

export interface CapabilityAnchor {
  key: string
  aliases: string[]
  weight: number
  generic: boolean
}

export function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
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
    })
  }
  return anchors
}
