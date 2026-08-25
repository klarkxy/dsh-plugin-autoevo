import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parse, stringify } from 'yaml'
import type { ExecutionEndpoint } from '../contracts.js'
import { EvolutionError } from '../errors.js'
import { listBundledOptInPackages } from '../resolver/host-bundled.js'
import { sha256 } from '../state/hashes.js'
import type { DshLauncher } from './launcher.js'

const MOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u

type HostBundledEnableEndpoint = Extract<ExecutionEndpoint, { kind: 'host_bundled_enable' }>

function patchRows(body: string): Array<Record<string, unknown>> {
  const value: unknown = parse(body)
  if (value === null || value === undefined) return []
  if (!Array.isArray(value)) {
    throw new EvolutionError('invalid_input', 'The profile patch layer is not a top-level array; Host will not rewrite it')
  }
  return value.filter((entry): entry is Record<string, unknown> =>
    Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
}

function alreadyMounted(rows: readonly Record<string, unknown>[], mountId: string, packageName: string): boolean {
  return rows.some((entry) => {
    if (entry.id === mountId) return true
    if (!Array.isArray(entry.insert)) return false
    return entry.insert.some((row) => Boolean(row) && typeof row === 'object' && !Array.isArray(row)
      && ((row as { id?: unknown }).id === mountId || (row as { name?: unknown }).name === packageName))
  })
}

export interface BuiltinEnableResult {
  packageName: string
  version: string
  mountId: string
  targetProfile: string
  /** False when the row already existed; the composition check still ran. */
  wrote: boolean
}

/**
 * Mount a Host-bundled opt-in capability into the target profile's user patch
 * layer. No package installation is involved: the CLI dependency closure is
 * already resolvable from every profile. The composition is verified with
 * `dsh --dump-config`; a failed check rolls the patch file back.
 */
export async function enableBuiltinMount(input: {
  launcher: DshLauncher
  dshHome: string
  bundledRoot: string
  endpoint: HostBundledEnableEndpoint
  cwd: string
  signal?: AbortSignal
}): Promise<BuiltinEnableResult> {
  const { packageName, version, mountId, targetProfile } = input.endpoint
  if (!MOUNT_ID_PATTERN.test(mountId)) {
    throw new EvolutionError('invalid_input', 'Refusing an unsafe built-in mount id', { mountId })
  }
  const bundled = (await listBundledOptInPackages(input.bundledRoot))
    .find((entry) => entry.packageName === packageName)
  if (!bundled) {
    throw new EvolutionError('not_found', 'The built-in capability is no longer bundled with this Host', { packageName })
  }
  if (bundled.version !== version) {
    throw new EvolutionError('review_expired', 'The built-in capability version changed between selection and enablement', {
      expectedVersion: version,
      actualVersion: bundled.version,
    })
  }
  if (bundled.mountId !== mountId) {
    throw new EvolutionError('review_expired', 'The built-in capability mount id changed between selection and enablement', {
      expectedMountId: mountId,
      actualMountId: bundled.mountId,
    })
  }

  const patchPath = path.join(input.dshHome, 'profiles', targetProfile, 'cordis.patch.yml')
  let original: string
  try {
    original = await readFile(patchPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new EvolutionError('not_found', 'The target profile has no patch layer; is the profile initialized?', {
        profile: targetProfile,
      })
    }
    throw error
  }
  const rows = patchRows(original)
  const wrote = !alreadyMounted(rows, mountId, packageName)
  if (wrote) {
    rows.push({ insert: [{ id: mountId, name: packageName }] })
    await writeFile(patchPath, stringify(rows), 'utf8')
  }

  const dump = await input.launcher.dumpConfig(input.dshHome, targetProfile, input.cwd, input.signal)
  if (dump.exitCode !== 0 || !dump.stdout.includes(mountId)) {
    if (wrote) await writeFile(patchPath, original, 'utf8')
    throw new EvolutionError('command_failed', `dsh exited with code ${dump.exitCode ?? 'null'}`, {
      command: 'dsh',
      exitCode: dump.exitCode,
      diagnosticHash: sha256(dump.stderr),
    })
  }
  return { packageName, version, mountId, targetProfile, wrote }
}
