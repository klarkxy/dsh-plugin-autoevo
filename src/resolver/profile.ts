import type { Dirent } from 'node:fs'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import type { LocalCapabilityCandidate } from '../contracts.js'
import { EvolutionError } from '../errors.js'

const MAX_MANIFEST_BYTES = 128 * 1024
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const PACKAGE_NAME = /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/u

interface ProfileManifest {
  dependencies?: unknown
  dsh?: { profile?: { bundles?: unknown } }
}

interface PackageManifest {
  description?: unknown
  keywords?: unknown
}

type CapabilityMatcher = (requirement: string, name: string, description: string) => number

interface ExplicitProfileSelection {
  state: 'absent' | 'selected' | 'invalid' | 'conflicting'
  profile?: string
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
}

async function readBoundedJson<T>(file: string): Promise<T | undefined> {
  try {
    const info = await stat(file)
    if (!info.isFile() || info.size > MAX_MANIFEST_BYTES) return undefined
    const value: unknown = JSON.parse(await readFile(file, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value as T : undefined
  } catch {
    return undefined
  }
}

async function physicalPathWithin(root: string, candidate: string): Promise<string | undefined> {
  try {
    const [physicalRoot, physicalCandidate] = await Promise.all([realpath(root), realpath(candidate)])
    return within(physicalRoot, physicalCandidate) ? physicalCandidate : undefined
  } catch {
    return undefined
  }
}

function boundedDependencySpec(value: string): string {
  const bounded = value.slice(0, 500)
  const localReference = /^(file|link|portal):/iu.exec(bounded)
  if (localReference) return `${localReference[1]!.toLowerCase()}:[local-reference]`
  if (/^(?:[A-Za-z]:[\\/]|\\\\|\/)/u.test(bounded)) return '[local-reference]'
  if (/^(?:https?|git\+https?):\/\//iu.test(bounded)) return '[remote-reference]'
  return bounded
}

function packageDescription(manifest: PackageManifest | undefined): string {
  if (!manifest) return ''
  const description = typeof manifest.description === 'string' ? manifest.description.slice(0, 1_000) : ''
  const keywords = Array.isArray(manifest.keywords)
    ? manifest.keywords.filter((item): item is string => typeof item === 'string').slice(0, 16).join(' ').slice(0, 500)
    : ''
  return [description, keywords].filter(Boolean).join(' ')
}

function containsExactPackageName(requirement: string, packageName: string): boolean {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`(?:^|[^A-Za-z0-9@/._-])${escaped}(?=$|[^A-Za-z0-9@/._-])`, 'iu').test(requirement)
}

function explicitProfileSelection(argv: readonly string[]): ExplicitProfileSelection {
  const profiles: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!
    let profile: string | undefined
    if (argument === '--profile') {
      profile = argv[index + 1]
      index += 1
    } else if (argument.startsWith('--profile=')) {
      profile = argument.slice('--profile='.length)
    }
    if (profile === undefined) continue
    if (!PROFILE_NAME.test(profile)) return { state: 'invalid' }
    profiles.push(profile)
  }
  if (profiles.length === 0) return { state: 'absent' }
  if (!profiles.every((profile) => profile === profiles[0])) return { state: 'conflicting' }
  return { state: 'selected', profile: profiles[0]! }
}

/** Parse only an explicit DSH profile flag; callers must not infer a default profile. */
export function activeProfileFromArgv(argv: readonly string[]): string | undefined {
  const selection = explicitProfileSelection(argv)
  return selection.state === 'selected' ? selection.profile : undefined
}

function baseUrlPath(value: unknown): string | undefined {
  if (value instanceof URL) return value.protocol === 'file:' ? fileURLToPath(value) : undefined
  if (typeof value !== 'string' || value.length === 0) return undefined
  if (path.isAbsolute(value)) return value
  try {
    const url = new URL(value)
    return url.protocol === 'file:' ? fileURLToPath(url) : undefined
  } catch {
    return path.resolve(value)
  }
}

function pathContains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

/**
 * Resolve the one configured profile that physically owns the live Cordis
 * base URL. Inventory order is never used as a destination choice.
 */
export async function resolveCurrentProfileOwner(input: {
  dshHome: string
  baseUrl: unknown
  argv?: readonly string[]
}): Promise<string> {
  const explicit = explicitProfileSelection(input.argv ?? [])
  if (explicit.state === 'invalid') {
    throw new EvolutionError('invalid_input', 'The explicit DSH profile flag is missing or invalid; current-profile ownership is not safe to infer')
  }
  if (explicit.state === 'conflicting') {
    throw new EvolutionError('invalid_input', 'Multiple conflicting explicit DSH profile flags were observed; refusing profile mutation')
  }

  const configuredProfilesRoot = path.resolve(input.dshHome, 'profiles')
  const liveBase = baseUrlPath(input.baseUrl)
  if (!liveBase) {
    throw new EvolutionError('invalid_input', 'The current DSH process does not expose a local profile base URL; refusing profile mutation')
  }

  let physicalProfilesRoot: string
  let physicalLiveBase: string
  let entries: Dirent[]
  try {
    physicalProfilesRoot = await realpath(configuredProfilesRoot)
    const liveInfo = await stat(liveBase)
    const physical = await realpath(liveBase)
    physicalLiveBase = liveInfo.isDirectory() ? physical : path.dirname(physical)
    entries = await readdir(configuredProfilesRoot, { withFileTypes: true })
  } catch {
    throw new EvolutionError('invalid_input', 'The live DSH profile boundary could not be canonicalized; refusing profile mutation')
  }

  if (!pathContains(physicalProfilesRoot, physicalLiveBase)) {
    throw new EvolutionError('invalid_input', 'The current DSH process base URL is outside configured DSH_HOME/profiles; refusing profile mutation')
  }

  const owners: string[] = []
  for (const entry of entries) {
    if (!PROFILE_NAME.test(entry.name)) continue
    const configuredProfile = path.resolve(configuredProfilesRoot, entry.name)
    let physicalProfile: string
    try {
      physicalProfile = await realpath(configuredProfile)
      if (!(await stat(physicalProfile)).isDirectory()) continue
    } catch {
      continue
    }
    if (!pathContains(physicalProfilesRoot, physicalProfile)) continue
    if (pathContains(physicalProfile, physicalLiveBase)) owners.push(entry.name)
  }

  if (owners.length === 0) {
    throw new EvolutionError('invalid_input', 'No configured DSH profile owns the current process base URL; refusing profile mutation')
  }
  if (owners.length !== 1) {
    throw new EvolutionError('invalid_input', 'The current process base URL has ambiguous DSH profile ownership; refusing profile mutation')
  }
  const owner = owners[0]!
  if (explicit.state === 'selected' && explicit.profile !== owner) {
    throw new EvolutionError('invalid_input', 'The explicit DSH profile conflicts with the profile that owns the live process base URL; refusing profile mutation')
  }
  return owner
}

/** Enumerate profile dependencies as install/configuration evidence only. */
export async function resolveProfilePluginCapabilities(input: {
  dshHome: string
  profile: string
  requirement: string
  match: CapabilityMatcher
}): Promise<LocalCapabilityCandidate[]> {
  if (!PROFILE_NAME.test(input.profile)) return []
  const home = path.resolve(input.dshHome)
  const profileRoot = path.resolve(home, 'profiles', input.profile)
  if (!within(home, profileRoot)) return []
  const profileManifestPath = path.resolve(profileRoot, 'package.json')
  if (!within(profileRoot, profileManifestPath)) return []
  const physicalProfileRoot = await physicalPathWithin(home, profileRoot)
  if (!physicalProfileRoot) return []
  const physicalProfileManifest = await physicalPathWithin(physicalProfileRoot, profileManifestPath)
  if (!physicalProfileManifest) return []
  const profileManifest = await readBoundedJson<ProfileManifest>(physicalProfileManifest)
  const dependencies = profileManifest?.dependencies
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) return []
  const bundles = profileManifest.dsh?.profile?.bundles
  const configuredBundles = new Set(Array.isArray(bundles)
    ? bundles.filter((item): item is string => typeof item === 'string')
    : [])
  const candidates: LocalCapabilityCandidate[] = []
  for (const [packageName, dependency] of Object.entries(dependencies)) {
    if (!PACKAGE_NAME.test(packageName) || typeof dependency !== 'string') continue
    const dependencySpec = boundedDependencySpec(dependency)
    const packageManifestPath = path.resolve(profileRoot, 'node_modules', ...packageName.split('/'), 'package.json')
    const physicalPackageManifest = within(profileRoot, packageManifestPath)
      ? await physicalPathWithin(physicalProfileRoot, packageManifestPath)
      : undefined
    const packageManifest = physicalPackageManifest
      ? await readBoundedJson<PackageManifest>(physicalPackageManifest)
      : undefined
    const exact = containsExactPackageName(input.requirement, packageName)
    const confidence = exact ? 0.99 : input.match(input.requirement, packageName, packageDescription(packageManifest))
    if (confidence < 0.3) continue
    candidates.push({
      kind: 'plugin',
      name: packageName,
      description: packageDescription(packageManifest) || `Profile dependency ${dependencySpec}`,
      availability: 'installed_in_profile',
      confidence,
      ...(exact ? { fit: 'full' as const, matchedFacets: ['exact_package'], missingFacets: [] } : {}),
      profileEvidence: {
        source: 'host_profile_manifest',
        profile: input.profile,
        packageName,
        dependencySpec,
        configuredBundle: configuredBundles.has(packageName),
      },
    })
  }
  return candidates
}

export const _testing = { baseUrlPath, boundedDependencySpec, containsExactPackageName, explicitProfileSelection }
