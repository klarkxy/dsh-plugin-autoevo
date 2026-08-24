import type { ActivatedFiber } from '../contracts.js'

export const MAX_ACTIVATED_FIBERS = 32
const MAX_FIBER_NAME = 214
const MAX_FIBER_ID = 128

export interface ActivationEntry {
  id?: string
  name?: string
  options?: { id?: string; name?: string }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function boundedToken(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const token = value.normalize('NFKC').replace(/[\u0000-\u001f\u007f]+/gu, '').trim()
  if (!token || token.length > max) return undefined
  return token
}

function pushTarget(out: ActivatedFiber[], seen: Set<string>, row: unknown): void {
  if (out.length >= MAX_ACTIVATED_FIBERS) return
  const rec = record(row)
  if (!rec) return
  const name = boundedToken(rec.name, MAX_FIBER_NAME)
  if (!name) return
  const id = boundedToken(rec.id, MAX_FIBER_ID)
  const key = `${id ?? ''}\0${name}`
  if (!seen.has(key)) {
    seen.add(key)
    out.push(id ? { id, name } : { name })
  }
  if (rec.group === true && Array.isArray(rec.config)) {
    for (const child of rec.config) {
      if (out.length >= MAX_ACTIVATED_FIBERS) return
      pushTarget(out, seen, child)
    }
  }
}

/** Insert rows a Loader patch actually activates. Carrier bundles name another package. */
export function activationTargetsFromPatch(patches: unknown): ActivatedFiber[] {
  if (!Array.isArray(patches)) return []
  const out: ActivatedFiber[] = []
  const seen = new Set<string>()
  for (const item of patches) {
    const patch = record(item)
    if (!patch || !Array.isArray(patch.insert)) continue
    for (const row of patch.insert) {
      if (out.length >= MAX_ACTIVATED_FIBERS) return out
      pushTarget(out, seen, row)
    }
  }
  return out
}

export function parseActivatedFibersJson(value: string | undefined): ActivatedFiber[] {
  if (!value) return []
  try {
    return activationTargetsFromPatch([{ insert: JSON.parse(value) }])
  } catch {
    return []
  }
}

export function entryIdentity(entry: ActivationEntry): { id?: string; name?: string } {
  // Loader's public Entry.id is path-qualified inside an include tree
  // (`include:child`), while a bundle patch freezes the local options.id
  // (`child`). Prefer the local patch identity when Loader exposes both.
  const id = boundedToken(entry.options?.id, MAX_FIBER_ID)
    ?? boundedToken(entry.id, MAX_FIBER_ID)
  const name = boundedToken(entry.options?.name, MAX_FIBER_NAME)
    ?? boundedToken(entry.name, MAX_FIBER_NAME)
  return { ...(id ? { id } : {}), ...(name ? { name } : {}) }
}

function matchesTarget(entry: ActivationEntry, target: ActivatedFiber): boolean {
  const ident = entryIdentity(entry)
  if (ident.name !== target.name) return false
  if (target.id) return ident.id === target.id
  return Boolean(ident.name)
}

function matchesPackageName(entry: ActivationEntry, packageName: string): boolean {
  const name = entryIdentity(entry).name
  return name === packageName || Boolean(name?.endsWith(`/${packageName}`))
}

/**
 * When the patch listed insert targets, every target must resolve.
 * Otherwise fall back to a Fiber named after the npm package.
 */
export function matchActivatedEntries<T extends ActivationEntry>(
  entries: readonly T[],
  input: { packageName: string; targets: readonly ActivatedFiber[] },
): T[] {
  if (input.targets.length === 0) {
    return entries.filter((entry) => matchesPackageName(entry, input.packageName))
  }
  const matched: T[] = []
  for (const target of input.targets) {
    const found = entries.find((entry) => matchesTarget(entry, target))
    if (!found) return []
    matched.push(found)
  }
  return matched
}

export function flattenLoaderOptions(entries: readonly unknown[]): ActivationEntry[] {
  const out: ActivationEntry[] = []
  const walk = (rows: readonly unknown[]): void => {
    for (const row of rows) {
      const rec = record(row)
      if (!rec) continue
      const id = boundedToken(rec.id, MAX_FIBER_ID)
      const name = boundedToken(rec.name, MAX_FIBER_NAME)
      if (id || name) out.push({ ...(id ? { id } : {}), options: { ...(id ? { id } : {}), ...(name ? { name } : {}) } })
      if (rec.group === true && Array.isArray(rec.config)) walk(rec.config)
    }
  }
  walk(entries)
  return out
}
