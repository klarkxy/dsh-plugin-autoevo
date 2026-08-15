import { EvolutionError } from './errors.js'

const SAFE_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u
const RESERVED_PACKAGE_NAMES = new Set(['node_modules', 'favicon.ico'])

/**
 * Deliberately narrower than npm's historical package-name grammar. The value
 * crosses DSH rc.6's Windows shell-forwarded pnpm boundary during removal, so
 * only lowercase registry-style identifiers with no option or shell syntax are
 * accepted.
 */
export function isSafePackageName(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 214) return false
  if (!SAFE_PACKAGE_NAME.test(value)) return false
  const leaf = value.includes('/') ? value.slice(value.indexOf('/') + 1) : value
  return !RESERVED_PACKAGE_NAMES.has(leaf)
}

export function assertSafePackageName(value: unknown): string {
  if (!isSafePackageName(value)) {
    throw new EvolutionError('review_rejected', 'The reviewed package name is unsafe for DSH package management')
  }
  return value
}

