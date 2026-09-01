import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { parse } from 'yaml'
import type { LocalCapabilityCandidate } from '../contracts.js'
import type { RuntimeConfig } from '../config.js'
import type { CommandRunner } from '../process/runner.js'

const DSH_SCOPE = '@deepseek-ai'
const DSH_PACKAGE = '@deepseek-ai/dsh'
const OPT_IN_DESCRIPTION = /^opt-?in\b/iu

export interface BundledOptInPackage {
  packageName: string
  version: string
  description: string
  mountId: string
}

async function readManifestName(packageRoot: string): Promise<string | undefined> {
  try {
    const manifest: unknown = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return undefined
    const name = (manifest as { name?: unknown }).name
    return typeof name === 'string' ? name : undefined
  } catch {
    return undefined
  }
}

/**
 * Locate the running Host dsh CLI package root. The healed profile fallback
 * link (`<dshHome>/profiles/node_modules/@deepseek-ai/dsh`) exists whenever any
 * profile booted, which is always the case for this plugin's runtime; the
 * executable shim layout mirrors argvForResolvedExecutable in process/runner.
 */
export async function resolveBundledDshRoot(input: {
  dshHome: string
  config: Pick<RuntimeConfig, 'dshCommand'>
  runner?: Pick<CommandRunner, 'resolveExecutable'>
  signal?: AbortSignal
}): Promise<string | undefined> {
  input.signal?.throwIfAborted()
  const candidates: string[] = []
  const fromEnv = process.env.DSH_PACKAGE_ROOT?.trim()
  if (fromEnv) candidates.push(fromEnv)
  candidates.push(path.join(input.dshHome, 'profiles', 'node_modules', ...DSH_PACKAGE.split('/')))
  if (input.runner?.resolveExecutable) {
    let executable: string | undefined
    try {
      executable = await input.runner.resolveExecutable(input.config.dshCommand, input.signal)
    } catch {
      if (input.signal?.aborted) throw input.signal.reason
    }
    input.signal?.throwIfAborted()
    if (executable) {
      const directory = path.dirname(executable)
      candidates.push(path.basename(directory).toLowerCase() === '.bin'
        ? path.resolve(directory, '..', DSH_PACKAGE)
        : path.join(directory, 'node_modules', DSH_PACKAGE))
    }
  }
  for (const candidate of candidates) {
    input.signal?.throwIfAborted()
    const manifestName = await readManifestName(candidate)
    input.signal?.throwIfAborted()
    if (manifestName === DSH_PACKAGE) return candidate
  }
  return undefined
}

/** Official opt-in capability packages shipped inside the dsh CLI dependency closure. */
export async function listBundledOptInPackages(dshPackageRoot: string): Promise<BundledOptInPackage[]> {
  const scopeDir = path.join(dshPackageRoot, 'node_modules', DSH_SCOPE)
  let entries
  try {
    entries = await readdir(scopeDir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const packages: BundledOptInPackage[] = []
  for (const entry of entries) {
    if (!entry.name.startsWith('dsh-') || (!entry.isDirectory() && !entry.isSymbolicLink())) continue
    let manifest: unknown
    try {
      manifest = JSON.parse(await readFile(path.join(scopeDir, entry.name, 'package.json'), 'utf8'))
    } catch {
      continue
    }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) continue
    const record = manifest as { name?: unknown, version?: unknown, description?: unknown }
    if (typeof record.name !== 'string' || record.name !== `${DSH_SCOPE}/${entry.name}`) continue
    if (typeof record.version !== 'string' || typeof record.description !== 'string') continue
    if (!OPT_IN_DESCRIPTION.test(record.description)) continue
    packages.push({
      packageName: record.name,
      version: record.version,
      description: record.description,
      mountId: entry.name.replace(/^dsh-/u, ''),
    })
  }
  return packages.sort((left, right) => left.packageName.localeCompare(right.packageName))
}

/**
 * Package names and mount ids already present in the profile composition:
 * `dsh.profile.bundles` plus insert rows of the profile user patch layer.
 */
export async function readMountedBuiltinRows(dshHome: string, profile: string): Promise<Set<string>> {
  const mounted = new Set<string>()
  const profileRoot = path.join(dshHome, 'profiles', profile)
  try {
    const manifest: unknown = JSON.parse(await readFile(path.join(profileRoot, 'package.json'), 'utf8'))
    const bundles = manifest && typeof manifest === 'object' && !Array.isArray(manifest)
      ? (manifest as { dsh?: { profile?: { bundles?: unknown } } }).dsh?.profile?.bundles
      : undefined
    if (Array.isArray(bundles)) {
      for (const name of bundles) if (typeof name === 'string') mounted.add(name)
    }
  } catch {
    // A missing or unreadable manifest means nothing is mounted through it.
  }
  let body: string
  try {
    body = await readFile(path.join(profileRoot, 'cordis.patch.yml'), 'utf8')
  } catch {
    return mounted
  }
  let patch: unknown
  try {
    patch = parse(body)
  } catch {
    return mounted
  }
  if (!Array.isArray(patch)) return mounted
  for (const entry of patch) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as { id?: unknown, insert?: unknown }
    if (typeof record.id === 'string') mounted.add(record.id)
    if (!Array.isArray(record.insert)) continue
    for (const row of record.insert) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue
      const insert = row as { id?: unknown, name?: unknown }
      if (typeof insert.id === 'string') mounted.add(insert.id)
      if (typeof insert.name === 'string') mounted.add(insert.name)
    }
  }
  return mounted
}

/**
 * Local candidates for Host-bundled opt-in capabilities that are not yet
 * mounted into the active profile. Enabling mounts a patch row; these never
 * flow through review or package installation.
 */
export async function resolveHostBundledCapabilities(input: {
  dshPackageRoot: string
  dshHome: string
  activeProfile?: string
  requirement: string
  match: (requirement: string, name: string, description: string) => number
}): Promise<LocalCapabilityCandidate[]> {
  const mounted = input.activeProfile
    ? await readMountedBuiltinRows(input.dshHome, input.activeProfile)
    : new Set<string>()
  const candidates: LocalCapabilityCandidate[] = []
  for (const bundled of await listBundledOptInPackages(input.dshPackageRoot)) {
    if (mounted.has(bundled.packageName) || mounted.has(bundled.mountId)) continue
    const confidence = input.match(input.requirement, bundled.packageName, bundled.description)
    if (confidence < 0.3) continue
    candidates.push({
      kind: 'plugin',
      name: bundled.packageName,
      description: bundled.description,
      availability: 'host_bundled',
      confidence,
      hostBundled: {
        packageName: bundled.packageName,
        version: bundled.version,
        mountId: bundled.mountId,
      },
    })
  }
  return candidates
}

export const _testing = { OPT_IN_DESCRIPTION, readManifestName }
