/**
 * Bound and redact text before it crosses the model-facing workflow boundary.
 * This deliberately over-redacts path-like suffixes rather than risking a
 * credential, home directory, or raw diagnostic path leak.
 */
export function boundedAgentText(value: unknown, maxLength = 300): string {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\b(?:api[_-]?key|access[_-]?token|token|secret|password)\s*[:=]\s*[^\s,;]+/giu, '[credential]')
    .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer [credential]')
    .replace(/https?:\/\/[^\s]+/gu, '[url]')
    .replace(/\\\\[^\\\s]+\\[^;\r\n,"']+/gu, '[path]')
    .replace(/\b[A-Za-z]:\\[^;\r\n,"']+/gu, '[path]')
    .replace(/\/(?:home|Users|tmp|var|etc|opt|workspace|root)\/[^;\r\n,"']+/gu, '[path]')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maxLength)
}
