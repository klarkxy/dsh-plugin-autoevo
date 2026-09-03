import path from 'node:path'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function toolAliases(name: string): string[] {
  const normalized = name.trim().toLowerCase()
  return [normalized, normalized.replace(/^dsh[_-]/u, ''), normalized.replace(/[_-]/gu, '')]
}

export function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code: string }).code === 'ENOENT')
}

export function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code: string }).code === 'EEXIST')
}

export function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/**
 * Cross-platform PID liveness probe.
 * - non-positive PID => dead/invalid (eligible for stale recovery)
 * - kill(pid, 0) success => live
 * - ESRCH => dead
 * - EPERM / unknown errors => treat as live (fail closed)
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? String((error as { code: unknown }).code)
      : undefined
    if (code === 'ESRCH') return false
    return true
  }
}

/** Normalize CRLF/CR to LF so Windows autocrlf checkouts stay hash-stable and upgradeable. */
export function normalizeLf(text: string): string {
  return text.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n')
}
