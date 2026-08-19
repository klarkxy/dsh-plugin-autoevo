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

export interface HotReloadAttempt {
  evidence: HotReloadEvidence
  /** Restore the exact previous Loader group after later receipt failure. */
  rollback?: () => Promise<void>
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

export async function hotLoadInstalledBundle(input: {
  ctx: Context
  dshHome: string
  profile: string
  packageName: string
  expectedTools: readonly string[]
  agent?: Agent | undefined
}): Promise<HotReloadAttempt> {
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
  const packageEntries = candidate.filter((entry) => entry.name === packageName)
  if (packageEntries.length === 0) {
    return { evidence: { attempted: true, loaded: false, method: 'unsupported', reason: 'The bundle patch does not activate the reviewed package in the current Loader group.' } }
  }

  let applied = false
  try {
    await owner.group.update(candidate)
    applied = true
    for (const options of packageEntries) {
      const entry = owner.group.tree.resolve(options.id)
      if (!entry.fiber) throw new Error(`Loader entry ${options.id} has no active Fiber`)
      await entry.fiber.await()
    }
    if (!expectedToolsLoaded(input.ctx, input.expectedTools, input.agent)) {
      throw new Error('the expected tools are not visible in the current Agent scope')
    }
  } catch (error) {
    if (applied) {
      try {
        await owner.group.update(previous)
      } catch (rollbackError) {
        return {
          evidence: {
            attempted: true,
            loaded: false,
            method: 'failed',
            reason: `Loader activation failed and rollback also failed: ${compactReason(error)}; rollback: ${compactReason(rollbackError)}`,
          },
          rollbackFailed: true,
        }
      }
    }
    return { evidence: { attempted: true, loaded: false, method: 'failed', reason: `Transactional Loader activation failed: ${compactReason(error)}` } }
  }

  const hasClient = dsh?.client !== undefined
  return {
    evidence: {
      attempted: true,
      loaded: !hasClient,
      method: 'loader',
      reason: hasClient
        ? 'The server bundle hot-loaded, but its web client module requires a browser/profile restart to become fully active.'
        : 'The reviewed patch was applied transactionally and every inserted package Fiber completed startup.',
    },
    rollback: async () => { await owner.group.update(previous) },
  }
}

export const _testing = { contextBasePath, ownerGroup, unsafeSelfPatch }
