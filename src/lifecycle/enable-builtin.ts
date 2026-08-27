import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
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
  return rows.some((entry) => exactBuiltinRow(entry, mountId, packageName))
}

function hasConflictingMountIdentity(rows: readonly Record<string, unknown>[], mountId: string, packageName: string): boolean {
  return rows.some((entry) => {
    if (exactBuiltinRow(entry, mountId, packageName)) return false
    if (entry.id === mountId || entry.name === packageName) return true
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

export interface BuiltinReceiptSpec {
  version: string
  mountId: string
  wrote: boolean
}

export function builtinReceiptSpec(input: BuiltinReceiptSpec): string {
  return `builtin:${encodeURIComponent(input.version)}:${encodeURIComponent(input.mountId)}:${input.wrote ? '1' : '0'}`
}

export function parseBuiltinReceiptSpec(value: string): BuiltinReceiptSpec | undefined {
  const match = /^builtin:([^:]+):([^:]+):([01])$/u.exec(value)
  if (!match) return undefined
  try {
    const version = decodeURIComponent(match[1]!)
    const mountId = decodeURIComponent(match[2]!)
    if (!version || !MOUNT_ID_PATTERN.test(mountId)) return undefined
    return { version, mountId, wrote: match[3] === '1' }
  } catch {
    return undefined
  }
}

function exactBuiltinRow(entry: Record<string, unknown>, mountId: string, packageName: string): boolean {
  if (Object.keys(entry).length !== 1 || !Array.isArray(entry.insert) || entry.insert.length !== 1) return false
  const row = entry.insert[0]
  return Boolean(row) && typeof row === 'object' && !Array.isArray(row)
    && Object.keys(row).length === 2
    && (row as { id?: unknown }).id === mountId
    && (row as { name?: unknown }).name === packageName
}

async function assertExactBundledEndpoint(
  bundledRoot: string,
  endpoint: HostBundledEnableEndpoint,
): Promise<void> {
  const bundled = (await listBundledOptInPackages(bundledRoot))
    .find((entry) => entry.packageName === endpoint.packageName)
  if (!bundled) {
    throw new EvolutionError('not_found', 'The built-in capability is no longer bundled with this Host', {
      packageName: endpoint.packageName,
    })
  }
  if (bundled.version !== endpoint.version) {
    throw new EvolutionError('review_expired', 'The built-in capability version changed between selection and enablement', {
      expectedVersion: endpoint.version,
      actualVersion: bundled.version,
    })
  }
  if (bundled.mountId !== endpoint.mountId) {
    throw new EvolutionError('review_expired', 'The built-in capability mount id changed between selection and enablement', {
      expectedMountId: endpoint.mountId,
      actualMountId: bundled.mountId,
    })
  }
}

/** Inspect the exact row shape AutoEvo owns without changing the profile. */
export async function builtinMountPresent(input: {
  dshHome: string
  targetProfile: string
  mountId: string
  packageName: string
}): Promise<boolean> {
  const patchPath = path.join(input.dshHome, 'profiles', input.targetProfile, 'cordis.patch.yml')
  const rows = patchRows(await readFile(patchPath, 'utf8'))
  return alreadyMounted(rows, input.mountId, input.packageName)
}

/** Remove only the exact row written by AutoEvo for a built-in receipt. */
export async function disableBuiltinMount(input: {
  launcher: DshLauncher
  dshHome: string
  targetProfile: string
  packageName: string
  spec: BuiltinReceiptSpec
  cwd: string
  signal?: AbortSignal
  /** Recovery journals may precede the write; absence is then a proven no-op. */
  allowAbsent?: boolean
}): Promise<{ wrote: boolean }> {
  if (!input.spec.wrote) return { wrote: false }
  const patchPath = path.join(input.dshHome, 'profiles', input.targetProfile, 'cordis.patch.yml')
  const original = await readFile(patchPath, 'utf8')
  const rows = patchRows(original)
  const matches = rows.filter((row) => exactBuiltinRow(row, input.spec.mountId, input.packageName))
  if (matches.length === 0 && input.allowAbsent) {
    if (hasConflictingMountIdentity(rows, input.spec.mountId, input.packageName)) {
      throw new EvolutionError('review_expired', 'The built-in mount identity changed after the recovery journal; refusing cleanup')
    }
    return { wrote: false }
  }
  if (matches.length !== 1) {
    throw new EvolutionError('review_expired', 'The exact built-in mount row changed after enablement; refusing removal')
  }
  const next = rows.filter((row) => !exactBuiltinRow(row, input.spec.mountId, input.packageName))
  const postimage = stringify(next)
  await writeFile(patchPath, postimage, 'utf8')
  const dump = await input.launcher.dumpConfig(input.dshHome, input.targetProfile, input.cwd, input.signal)
  const live = await readFile(patchPath, 'utf8')
  if (dump.exitCode !== 0 || dump.stdout.includes(input.spec.mountId)) {
    if (live !== postimage) {
      throw new EvolutionError('review_expired', 'The profile patch changed during the built-in removal check; external edits were preserved and recovery is required')
    }
    await writeFile(patchPath, original, 'utf8')
    throw new EvolutionError('command_failed', 'Built-in removal composition check failed', {
      command: 'dsh',
      exitCode: dump.exitCode,
      diagnosticHash: sha256(dump.stderr),
    })
  }
  if (live !== postimage) {
    throw new EvolutionError('review_expired', 'The profile patch changed during the built-in removal check; external edits were preserved and recovery is required')
  }
  return { wrote: true }
}

/**
 * Mount a Host-bundled opt-in capability into the target profile's user patch
 * layer. No package installation is involved: the CLI dependency closure is
 * already resolvable from every profile. The composition is verified with
 * `dsh --dump-config`; a failed check rolls the patch file back.
 */
export async function enableBuiltinMount(input: {
  ctx: Context
  exec: ToolRunContext
  requirement: string
  launcher: DshLauncher
  dshHome: string
  bundledRoot: string
  endpoint: HostBundledEnableEndpoint
  cwd: string
  signal?: AbortSignal
  /** Host crash journal persisted after approval and immediately before the profile write. */
  beforeProfileWrite?: () => Promise<void>
}): Promise<BuiltinEnableResult> {
  const { packageName, version, mountId, targetProfile } = input.endpoint
  if (!MOUNT_ID_PATTERN.test(mountId)) {
    throw new EvolutionError('invalid_input', 'Refusing an unsafe built-in mount id', { mountId })
  }
  await assertExactBundledEndpoint(input.bundledRoot, input.endpoint)

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
  if (hasConflictingMountIdentity(rows, mountId, packageName)) {
    throw new EvolutionError('review_expired', 'The built-in mount identity is already used by a different profile row')
  }
  const wrote = !alreadyMounted(rows, mountId, packageName)
  let postimage = original
  if (wrote) {
    const approval = input.ctx.get('approval')
    if (!approval || !input.exec.agent) {
      throw new EvolutionError('approval_required', 'A live DSH approval service and Agent turn are required')
    }
    const outcome = await approval.request({
      agent: input.exec.agent,
      toolName: 'capability_workflow_resume',
      callId: input.exec.callId,
      reason: `Enable exact Host-bundled capability ${packageName}@${version} by adding mount ${mountId} to profile ${targetProfile} for requirement: ${input.requirement}`,
      signal: input.exec.signal,
    })
    if (outcome !== 'allowed-once') {
      throw new EvolutionError('approval_required', `The built-in profile change was not approved (${outcome})`, { outcome })
    }
    await assertExactBundledEndpoint(input.bundledRoot, input.endpoint)
    const approvedPreimage = await readFile(patchPath, 'utf8')
    if (approvedPreimage !== original) {
      throw new EvolutionError('review_expired', 'The target profile patch changed while approval was pending; refusing a stale overwrite')
    }
    await input.beforeProfileWrite?.()
    const journaledPreimage = await readFile(patchPath, 'utf8')
    if (journaledPreimage !== original) {
      throw new EvolutionError('review_expired', 'The target profile patch changed before the approved write; refusing a stale overwrite')
    }
    rows.push({ insert: [{ id: mountId, name: packageName }] })
    postimage = stringify(rows)
    await writeFile(patchPath, postimage, 'utf8')
  }

  const dump = await input.launcher.dumpConfig(input.dshHome, targetProfile, input.cwd, input.signal)
  const live = await readFile(patchPath, 'utf8')
  if (dump.exitCode !== 0 || !dump.stdout.includes(mountId)) {
    if (wrote) {
      if (live !== postimage) {
        throw new EvolutionError('review_expired', 'The profile patch changed during the built-in enablement check; external edits were preserved and recovery is required')
      }
      await writeFile(patchPath, original, 'utf8')
    }
    throw new EvolutionError('command_failed', `dsh exited with code ${dump.exitCode ?? 'null'}`, {
      command: 'dsh',
      exitCode: dump.exitCode,
      diagnosticHash: sha256(dump.stderr),
    })
  }
  if (live !== postimage || !alreadyMounted(patchRows(live), mountId, packageName)) {
    throw new EvolutionError('review_expired', 'The exact built-in mount row changed during the composition check; recovery is required')
  }
  return { packageName, version, mountId, targetProfile, wrote }
}
