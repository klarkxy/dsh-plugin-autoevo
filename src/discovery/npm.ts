import type { RemotePluginCandidate } from '../contracts.js'
import { EvolutionError } from '../errors.js'
import { validateGithubRepository } from '../github/index.js'

const REGISTRY = 'https://registry.npmjs.org/-/v1/search'
const MAX_RESPONSE_BYTES = 1_048_576

interface NpmSearchPackage {
  name?: unknown
  description?: unknown
  keywords?: unknown
  date?: unknown
  links?: { repository?: unknown; homepage?: unknown }
}

function githubRepository(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value.replace(/^git\+https:/u, 'https:'))
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) return undefined
    const parts = url.pathname.replace(/\.git$/u, '').split('/').filter(Boolean)
    if (parts.length !== 2) return undefined
    return validateGithubRepository(parts.join('/'))
  } catch {
    return undefined
  }
}

function githubPackagePath(value: unknown, repository: string): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password) return undefined
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts.length < 5 || `${parts[0]}/${parts[1]}`.toLowerCase() !== repository.toLowerCase() || parts[2] !== 'tree') return undefined
    const packagePath = parts.slice(4).join('/')
    if (parts.slice(4).some((part) => part === '.' || part === '..' || !/^[A-Za-z0-9._-]+$/u.test(part))) return undefined
    return packagePath
  } catch {
    return undefined
  }
}

function asCandidate(value: unknown): RemotePluginCandidate | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const item = value as NpmSearchPackage
  if (typeof item.name !== 'string' || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(item.name)) return undefined
  const keywords = Array.isArray(item.keywords)
    ? item.keywords.filter((keyword): keyword is string => typeof keyword === 'string' && keyword.length <= 80)
    : []
  if (!keywords.some((keyword) => keyword.toLowerCase() === 'dsh-plugin')) return undefined
  const repository = githubRepository(item.links?.repository)
  // The existing review pipeline freezes a GitHub commit. A registry listing
  // without an exact source repository cannot be offered as reviewable code.
  if (!repository) return undefined
  const packagePath = githubPackagePath(item.links?.homepage, repository)
  return {
    repository,
    name: item.name,
    packageName: item.name,
    ...(packagePath ? { packagePath } : {}),
    description: typeof item.description === 'string' ? item.description.slice(0, 500) : '',
    stars: 0,
    updatedAt: typeof item.date === 'string' && /^\d{4}-\d\d-\d\dT/u.test(item.date) ? item.date : null,
    topics: keywords.slice(0, 20),
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new EvolutionError('npm_unavailable', 'npm registry returned an empty search body')
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new EvolutionError('npm_unavailable', 'npm registry search response exceeded the size limit')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new EvolutionError('npm_unavailable', 'npm registry returned invalid search JSON')
  }
}

/** Search public npm metadata; only source-linked DSH packages can enter review. */
export async function searchNpmPackages(options: {
  query: string
  limit: number
  signal?: AbortSignal
  fetch?: typeof fetch
}): Promise<RemotePluginCandidate[]> {
  options.signal?.throwIfAborted()
  const url = new URL(REGISTRY)
  url.searchParams.set('text', `keywords:dsh-plugin ${options.query}`)
  url.searchParams.set('size', String(Math.min(20, Math.max(1, options.limit))))
  const response = await (options.fetch ?? fetch)(url, {
    redirect: 'error',
    signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
  })
  options.signal?.throwIfAborted()
  if (!response.ok) throw new EvolutionError('npm_unavailable', `npm registry search returned HTTP ${response.status}`)
  const payload = await boundedJson(response)
  options.signal?.throwIfAborted()
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { objects?: unknown }).objects)) {
    throw new EvolutionError('npm_unavailable', 'npm registry returned invalid search data')
  }
  return (payload as { objects: Array<{ package?: unknown }> }).objects.slice(0, Math.min(20, Math.max(1, options.limit)))
    .map((item) => asCandidate(item?.package))
    .filter((item): item is RemotePluginCandidate => Boolean(item))
}

export const _testing = { asCandidate, githubRepository, githubPackagePath }
