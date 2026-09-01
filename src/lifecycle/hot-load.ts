import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  applyEntryPatches,
  type PatchOptions,
} from '@deepseek-ai/cordis-plugin-include'
import type { EntryGroup, EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { parse } from 'yaml'
import type { HotReloadEvidence } from '../contracts.js'
import { errorMessage } from '../errors.js'
import { assertSafePackageName } from '../package-name.js'
import {
  activationTargetsFromPatch,
  flattenLoaderOptions,
  matchActivatedEntries,
} from './bundle-activation.js'

export interface HotReloadAttempt {
  evidence: HotReloadEvidence
  rollbackFailed?: boolean
}

function compactReason(error: unknown): string {
  return errorMessage(error).normalize('NFKC').replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim().slice(0, 300)
}

function contextBasePath(ctx: Context): string | undefined {
  const value: unknown = Reflect.get(ctx as object, 'baseUrl')
  if (value instanceof URL) return path.resolve(fileURLToPath(value))
  if (typeof value !== 'string' || value.length === 0) return undefined
  try {
    return path.resolve(fileURLToPath(new URL(value)))
  } catch {
    return path.resolve(value)
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function ownerGroup(ctx: Context): { group: EntryGroup; ownerId?: string } | undefined {
  const entry = (ctx as Context & {
    fiber?: { entry?: { id?: string; parent?: EntryGroup } }
  }).fiber?.entry
  return entry?.parent ? { group: entry.parent, ...(entry.id ? { ownerId: entry.id } : {}) } : undefined
}

function expectedToolsLoaded(ctx: Context, expectedTools: readonly string[], agent?: Agent): boolean {
  return expectedTools.every((name) => Boolean(ctx.tools.get(name, agent)))
}

function unsafeSelfPatch(patches: PatchOptions[], ownerId: string | undefined): boolean {
  if (!ownerId) return false
  for (const patch of patches) {
    if (patch.id === ownerId) return true
    if (patch.insert?.some((entry) => entry.id === ownerId)) return true
  }
  return false
}

async function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  signal?.throwIfAborted()
  if (!signal) return promise
  return await new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = () => finish(() => reject(signal.reason))
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(promise).then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    )
  })
}

export async function hotLoadInstalledBundle(input: {
  ctx: Context
  dshHome: string
  profile: string
  packageName: string
  expectedTools: readonly string[]
  agent?: Agent | undefined
  signal?: AbortSignal | undefined
}): Promise<HotReloadAttempt> {
  input.signal?.throwIfAborted()
  const packageName = assertSafePackageName(input.packageName)
  const targetProfile = path.resolve(input.dshHome, 'profiles', input.profile)
  const basePath = contextBasePath(input.ctx)
  if (!basePath) {
    return { evidence: { attempted: true, loaded: false, method: 'unsupported', reason: 'The current DSH process does not expose its profile base URL.' } }
  }
  try {
    if (await realpath(basePath) !== await realpath(targetProfile)) {
      return { evidence: { attempted: true, loaded: false, method: 'unsupported', reason: 'The target profile is not the profile owned by the current DSH process.' } }
    }
  } catch (error) {
    return { evidence: { attempted: true, loaded: false, method: 'failed', reason: `Could not validate the current profile boundary: ${compactReason(error)}` } }
  }

  const packageRoot = path.join(targetProfile, 'node_modules', ...packageName.split('/'))
  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8')) as Record<string, unknown>
  } catch (error) {
    return { evidence: { attempted: true, loaded: false, method: 'failed', reason: `Could not read the installed package manifest: ${compactReason(error)}` } }
  }
  const dsh = record(manifest.dsh)
  const bundle = record(dsh?.bundle)
  const patchSpec = bundle?.patch
  if (typeof patchSpec !== 'string' || !patchSpec || path.isAbsolute(patchSpec) || patchSpec.split(/[\\/]/u).includes('..')) {
    return { evidence: { attempted: true, loaded: false, method: 'unsupported', reason: 'The bundle does not expose a safe relative patch list for hot loading.' } }
  }
  let patches: PatchOptions[]
  try {
    const value: unknown = parse(await readFile(path.resolve(packageRoot, patchSpec), 'utf8'))
    if (!Array.isArray(value)) throw new TypeError('bundle patch must be a top-level array')
    patches = value as PatchOptions[]
  } catch (error) {
    return { evidence: { attempted: true, loaded: false, method: 'failed', reason: `Could not parse the installed bundle patch: ${compactReason(error)}` } }
  }

  const owner = ownerGroup(input.ctx)
  if (!owner) {
    return { evidence: { attempted: true, loaded: false, method: 'unsupported', reason: 'The current AutoEvo instance is not owned by a mutable Loader group.' } }
  }
  if (unsafeSelfPatch(patches, owner.ownerId)) {
    return { evidence: { attempted: true, loaded: false, method: 'unsupported', reason: 'The bundle patch targets the active AutoEvo Loader entry and cannot be hot-applied safely.' } }
  }

  const previous = structuredClone(owner.group.data) as EntryOptions[]
  const warnings: string[] = []
  let candidate: EntryOptions[]
  try {
    candidate = applyEntryPatches(previous, patches, (message, ...args) => {
      warnings.push([message, ...args.map(String)].join(' ').slice(0, 300))
    })
  } catch (error) {
    return { evidence: { attempted: true, loaded: false, method: 'failed', reason: `Could not apply the installed bundle patch: ${compactReason(error)}` } }
  }
  if (warnings.length > 0) {
    return { evidence: { attempted: true, loaded: false, method: 'unsupported', reason: `The bundle patch could not be applied completely: ${warnings.join('; ')}` } }
  }
  const targets = activationTargetsFromPatch(patches)
  const matched = matchActivatedEntries(flattenLoaderOptions(candidate), { packageName, targets })
  if (matched.length === 0) {
    return { evidence: { attempted: true, loaded: false, method: 'unsupported', reason: 'The bundle patch does not activate the reviewed package in the current Loader group.' } }
  }

  let mutationAttempted = false
  try {
    input.signal?.throwIfAborted()
    // Loader.update() may mutate its group before its Promise settles.
    mutationAttempted = true
    await owner.group.update(candidate)
    for (const options of matched) {
      const id = options.id ?? options.options?.id
      if (!id) throw new Error('Loader entry has no id')
      const entry = owner.group.tree.resolve(id)
      if (!entry.fiber) throw new Error(`Loader entry ${id} has no active Fiber`)
      await awaitWithSignal(Promise.resolve().then(() => entry.fiber!.await()), input.signal)
    }
    input.signal?.throwIfAborted()
    if (!expectedToolsLoaded(input.ctx, input.expectedTools, input.agent)) {
      throw new Error('the expected tools are not visible in the current Agent scope')
    }
  } catch (error) {
    if (mutationAttempted) {
      // EntryGroup has no serialized compare-and-swap update. After invoking
      // update(candidate), restoring a captured previous snapshot could erase
      // a newer generation, even if the current data appears familiar.
      return {
        evidence: {
          attempted: true,
          loaded: false,
          method: 'failed',
          reason: input.signal?.aborted
            ? 'Current-process Loader activation was interrupted after mutation began; its runtime state is ambiguous and requires recovery.'
            : `Loader activation failed after mutation began; its runtime state is ambiguous and requires recovery: ${compactReason(error)}`,
        },
        rollbackFailed: true,
      }
    }
    return {
      evidence: {
        attempted: true,
        loaded: false,
        method: 'failed',
        reason: `Loader activation failed before mutation began: ${compactReason(error)}`,
      },
    }
  }

  const hasClient = dsh?.client !== undefined
  return {
    evidence: {
      attempted: true,
      loaded: !hasClient,
      method: 'loader',
      reason: hasClient
        ? 'The server bundle hot-loaded, but its web client module requires a browser/profile restart to become fully active.'
        : 'The reviewed patch was applied and every inserted package Fiber completed startup.',
    },
  }
}

export const _testing = { awaitWithSignal, contextBasePath, ownerGroup, unsafeSelfPatch }
