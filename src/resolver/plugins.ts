import { readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { LocalCapabilityCandidate } from '../contracts.js'

const SKIPPED_PACKAGES = new Set(['dsh-plugin-autoevo', 'dsh-find-plugin'])

interface LoaderEntryLike {
  disabled?: boolean
  fiber?: unknown
  options?: {
    group?: boolean | null
    id?: string
    name?: string
  }
  ctx?: { baseUrl?: string }
}

interface LoaderLike {
  entries(): Iterable<LoaderEntryLike>
}

interface PackageManifest {
  name?: unknown
  description?: unknown
  keywords?: unknown
  dsh?: unknown
}

type CapabilityMatcher = (requirement: string, name: string, description: string) => number

function boundedText(value: unknown, max = 1_000): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function isFileUrl(value: string): boolean {
  return value.startsWith('file:')
}

function asFilePath(value: string, baseUrl?: string): string | undefined {
  try {
    if (isFileUrl(value)) return fileURLToPath(value)
    if (path.isAbsolute(value)) return value
    if (baseUrl && isFileUrl(baseUrl)) return fileURLToPath(new URL(value, baseUrl))
  } catch {
    return undefined
  }
  return undefined
}

async function nearestPackageJson(start: string): Promise<string | undefined> {
  let current = path.extname(start) ? path.dirname(start) : start
  const visited = new Set<string>()
  while (!visited.has(current)) {
    visited.add(current)
    const candidate = path.join(current, 'package.json')
    try {
      const info = await stat(candidate)
      if (info.isFile()) return candidate
    } catch {
      // Continue toward the filesystem root.
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return undefined
}

async function resolvePackageJson(specifier: string, baseUrl?: string): Promise<string | undefined> {
  const directPath = asFilePath(specifier, baseUrl)
  if (directPath) return nearestPackageJson(directPath)
  if (specifier.startsWith('cordis:')) return undefined

  try {
    const requireFrom = createRequire(baseUrl && isFileUrl(baseUrl) ? baseUrl : pathToFileURL(path.join(process.cwd(), '__autoevo_loader__.cjs')))
    try {
      return requireFrom.resolve(`${specifier}/package.json`)
    } catch {
      return nearestPackageJson(requireFrom.resolve(specifier))
    }
  } catch {
    return undefined
  }
}

async function readManifest(manifestPath: string): Promise<PackageManifest | undefined> {
  try {
    const info = await stat(manifestPath)
    if (!info.isFile()) return undefined
    const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return parsed as PackageManifest
  } catch {
    return undefined
  }
}

function pluginDescription(manifest: PackageManifest): string {
  const keywords = Array.isArray(manifest.keywords)
    ? manifest.keywords.filter((value): value is string => typeof value === 'string').slice(0, 16).join(' ')
    : ''
  return [boundedText(manifest.description), boundedText(keywords, 500)].filter(Boolean).join(' ')
}

/** Enumerate active Loader packages, including client-only plugins with no tools or skills. */
export async function resolveLoadedPluginCapabilities(
  ctx: Context,
  requirement: string,
  match: CapabilityMatcher,
): Promise<LocalCapabilityCandidate[]> {
  const getService = (ctx as Context & { get?: (name: string) => unknown }).get
  let loader: LoaderLike | undefined
  try {
    loader = typeof getService === 'function' ? getService.call(ctx, 'loader') as LoaderLike | undefined : undefined
  } catch {
    return []
  }
  if (!loader || typeof loader.entries !== 'function') return []

  const candidates = new Map<string, LocalCapabilityCandidate>()
  for (const entry of loader.entries()) {
    const specifier = entry.options?.name
    if (!specifier || entry.options?.group || entry.disabled || !entry.fiber) continue
    const manifestPath = await resolvePackageJson(specifier, entry.ctx?.baseUrl)
    if (!manifestPath) continue
    const manifest = await readManifest(manifestPath)
    if (!manifest || !manifest.dsh || typeof manifest.dsh !== 'object') continue
    const name = boundedText(manifest.name, 256)
    if (!name || SKIPPED_PACKAGES.has(name)) continue
    const description = pluginDescription(manifest)
    const confidence = match(requirement, name, description)
    if (confidence < 0.3) continue
    const prior = candidates.get(name)
    if (!prior || confidence > prior.confidence) {
      candidates.set(name, { kind: 'plugin', name, description, availability: 'available', confidence })
    }
  }
  return [...candidates.values()]
}
