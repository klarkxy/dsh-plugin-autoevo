import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
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

type PatchFileOps = {
  readFile: typeof readFile
  writeFile: typeof writeFile
  rename: typeof rename
  rm: typeof rm
}

const defaultPatchFileOps: PatchFileOps = { readFile, writeFile, rename, rm }
let patchFileOps: PatchFileOps = defaultPatchFileOps

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

function canonicalSignal(exec: ToolRunContext | undefined, signal: AbortSignal | undefined): AbortSignal | undefined {
  if (exec?.signal && signal && exec.signal !== signal) {
    throw new EvolutionError('invalid_input', 'Built-in mutation received conflicting cancellation signals')
  }
  return signal ?? exec?.signal
}

function dumpCompositionMatches(
  stdout: string,
  mountId: string,
  packageName: string,
  present: boolean,
): boolean {
  let value: unknown
  try {
    value = parse(stdout, (_key, item) => item, { logLevel: 'silent' })
  } catch {
    return false
  }
  if (!Array.isArray(value)) return false
  let exact = 0
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false
    const row = item as Record<string, unknown>
    if (typeof row.id !== 'string' || typeof row.name !== 'string') return false
    const idMatches = row.id === mountId
    const nameMatches = row.name === packageName
    if (idMatches !== nameMatches) return false
    if (idMatches) exact += 1
  }
  return present ? exact === 1 : exact === 0
}

async function patchBodyEquals(patchPath: string, expected: string): Promise<boolean> {
  try {
    return await patchFileOps.readFile(patchPath, 'utf8') === expected
  } catch {
    return false
  }
}

async function writePatchAtomically(
  patchPath: string,
  expectedPreimage: string,
  postimage: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  const temporary = path.join(path.dirname(patchPath), `.${path.basename(patchPath)}.${randomUUID()}.tmp`)
  try {
    await patchFileOps.writeFile(temporary, postimage, { encoding: 'utf8', flag: 'wx' })
    signal?.throwIfAborted()
    // This is a fail-closed stale-preimage check, not a cross-process CAS:
    // an unrelated editor can still replace the patch after this read and
    // before rename. That residual remains a recovery boundary; do not claim
    // sidecar locking or fsync durability that this file-local protocol lacks.
    const current = await patchFileOps.readFile(patchPath, 'utf8')
    signal?.throwIfAborted()
    if (current !== expectedPreimage) {
      throw new EvolutionError('review_expired', 'The profile patch changed before the atomic built-in mutation; refusing a stale overwrite')
    }
    try {
      await patchFileOps.rename(temporary, patchPath)
    } catch (error) {
      if (!await patchBodyEquals(patchPath, postimage)) throw error
    }
  } finally {
    await patchFileOps.rm(temporary, { force: true }).catch(() => undefined)
  }
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
  const rows = patchRows(await patchFileOps.readFile(patchPath, 'utf8'))
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
  const signal = canonicalSignal(undefined, input.signal)
  signal?.throwIfAborted()
  if (!input.spec.wrote) return { wrote: false }
  const patchPath = path.join(input.dshHome, 'profiles', input.targetProfile, 'cordis.patch.yml')
  const original = await patchFileOps.readFile(patchPath, 'utf8')
  signal?.throwIfAborted()
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
  await writePatchAtomically(patchPath, original, postimage, signal)
  signal?.throwIfAborted()
  const dump = await input.launcher.dumpConfig(input.dshHome, input.targetProfile, input.cwd, signal)
  signal?.throwIfAborted()
  const live = await patchFileOps.readFile(patchPath, 'utf8')
  signal?.throwIfAborted()
  if (live !== postimage) {
    throw new EvolutionError('review_expired', 'The profile patch changed during the built-in removal check; external edits were preserved and recovery is required')
  }
  if (dump.exitCode !== 0 || !dumpCompositionMatches(dump.stdout, input.spec.mountId, input.packageName, false)) {
    throw new EvolutionError('command_failed', 'Built-in removal composition check failed', {
      command: 'dsh',
      exitCode: dump.exitCode,
      diagnosticHash: sha256(dump.stderr),
    })
  }
  return { wrote: true }
}

/**
 * Mount a Host-bundled opt-in capability into the target profile's user patch
 * layer. No package installation is involved: the CLI dependency closure is
 * already resolvable from every profile. The composition is verified with
 * `dsh --dump-config`; once the patch mutation may have landed, failures are
 * retained for write-ahead receipt recovery rather than blindly restoring a
 * stale preimage.
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
  const signal = canonicalSignal(input.exec, input.signal)
  signal?.throwIfAborted()
  const { packageName, version, mountId, targetProfile } = input.endpoint
  if (!MOUNT_ID_PATTERN.test(mountId)) {
    throw new EvolutionError('invalid_input', 'Refusing an unsafe built-in mount id', { mountId })
  }
  await assertExactBundledEndpoint(input.bundledRoot, input.endpoint)
  signal?.throwIfAborted()

  const patchPath = path.join(input.dshHome, 'profiles', targetProfile, 'cordis.patch.yml')
  let original: string
  try {
    original = await patchFileOps.readFile(patchPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new EvolutionError('not_found', 'The target profile has no patch layer; is the profile initialized?', {
        profile: targetProfile,
      })
    }
    throw error
  }
  signal?.throwIfAborted()
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
      ...(signal ? { signal } : {}),
    })
    if (outcome !== 'allowed-once') {
      throw new EvolutionError('approval_required', `The built-in profile change was not approved (${outcome})`, { outcome })
    }
    signal?.throwIfAborted()
    await assertExactBundledEndpoint(input.bundledRoot, input.endpoint)
    signal?.throwIfAborted()
    const approvedPreimage = await patchFileOps.readFile(patchPath, 'utf8')
    signal?.throwIfAborted()
    if (approvedPreimage !== original) {
      throw new EvolutionError('review_expired', 'The target profile patch changed while approval was pending; refusing a stale overwrite')
    }
    signal?.throwIfAborted()
    await input.beforeProfileWrite?.()
    signal?.throwIfAborted()
    const journaledPreimage = await patchFileOps.readFile(patchPath, 'utf8')
    signal?.throwIfAborted()
    if (journaledPreimage !== original) {
      throw new EvolutionError('review_expired', 'The target profile patch changed before the approved write; refusing a stale overwrite')
    }
    rows.push({ insert: [{ id: mountId, name: packageName }] })
    postimage = stringify(rows)
    await writePatchAtomically(patchPath, original, postimage, signal)
    signal?.throwIfAborted()
  }

  signal?.throwIfAborted()
  const dump = await input.launcher.dumpConfig(input.dshHome, targetProfile, input.cwd, signal)
  signal?.throwIfAborted()
  const live = await patchFileOps.readFile(patchPath, 'utf8')
  signal?.throwIfAborted()
  if (live !== postimage) {
    throw new EvolutionError('review_expired', 'The exact built-in mount row changed during the composition check; recovery is required')
  }
  if (dump.exitCode !== 0 || !dumpCompositionMatches(dump.stdout, mountId, packageName, true)) {
    throw new EvolutionError('command_failed', `dsh exited with code ${dump.exitCode ?? 'null'}`, {
      command: 'dsh',
      exitCode: dump.exitCode,
      diagnosticHash: sha256(dump.stderr),
    })
  }
  if (!alreadyMounted(patchRows(live), mountId, packageName)) {
    throw new EvolutionError('review_expired', 'The exact built-in mount row changed during the composition check; recovery is required')
  }
  return { packageName, version, mountId, targetProfile, wrote }
}

export const _testing = {
  dumpCompositionMatches,
  resetPatchFileOps: () => { patchFileOps = defaultPatchFileOps },
  setPatchFileOps: (overrides: Partial<PatchFileOps>) => { patchFileOps = { ...defaultPatchFileOps, ...overrides } },
  writePatchAtomically,
}
