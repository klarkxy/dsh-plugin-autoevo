const LANGUAGE_CACHE_LIMIT = 256
const chineseByWorkflowId = new Map<string, boolean>()

export function prefersChinese(text: string): boolean {
  return /[\p{Script=Han}]/u.test(text)
}

export function rememberRequirementLanguage(workflowId: string, requirement: string): void {
  if (!workflowId) return
  chineseByWorkflowId.set(workflowId, prefersChinese(requirement))
  if (chineseByWorkflowId.size <= LANGUAGE_CACHE_LIMIT) return
  const oldest = chineseByWorkflowId.keys().next().value
  if (oldest !== undefined) chineseByWorkflowId.delete(oldest)
}

export function copy(hint: string | undefined, english: string, chinese: string): string {
  return prefersChinese(hint ?? '') ? chinese : english
}

export function prefersChineseHint(input: unknown): boolean {
  if (typeof input === 'string') return prefersChinese(input)
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false
  const record = input as Record<string, unknown>
  if (typeof record.requirement === 'string' && prefersChinese(record.requirement)) return true
  const workflowId = typeof record.workflow_id === 'string'
    ? record.workflow_id
    : typeof record.workflowId === 'string' ? record.workflowId : undefined
  return Boolean(workflowId && chineseByWorkflowId.get(workflowId) === true)
}

export function copyForArgs(args: unknown, english: string, chinese: string): string {
  return prefersChineseHint(args) ? chinese : english
}

export const _testing = {
  clearLanguageCache(): void {
    chineseByWorkflowId.clear()
  },
}
