const STOP_WORDS = new Set([
  'agent', 'ability', 'capability', 'current', 'please', 'plugin', 'support', 'task', 'tool',
  'want', 'with', '需要', '希望', '可以', '帮我', '功能', '能力', '插件', '工具',
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
]

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
