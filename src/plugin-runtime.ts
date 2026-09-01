import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import {
  installCordisInspectCompatibility,
  type CordisInspectRegistryLike,
} from './cordis-inspect-compat.js'
import {
  EVOLUTION_MODE_SERVICE_KEY,
  EVOLUTION_PRESET_ID,
  isEvolutionModeMarker,
} from './evolution-contracts.js'

interface AgentPresetsService {
  composedPreset?(agentCtx: Agent['ctx']): string | undefined
  serviceFor?(agent: Agent, key: string): unknown
}

function resolveAgentPresets(ctx: Context): AgentPresetsService | undefined {
  return ctx.get('agentPresets') as AgentPresetsService | undefined
}

export function createIsEvolutionMode(ctx: Context): (agent: Agent) => boolean {
  return (agent: Agent) => {
    const agentPresets = resolveAgentPresets(ctx)
    if (!agentPresets?.serviceFor || !agentPresets.composedPreset) return false
    try {
      if (agentPresets.composedPreset(agent.ctx) !== EVOLUTION_PRESET_ID) return false
      return isEvolutionModeMarker(agentPresets.serviceFor(agent, EVOLUTION_MODE_SERVICE_KEY))
    } catch {
      return false
    }
  }
}

export function installCordisInspectCompatibilityWhenAvailable(ctx: Context): void {
  ctx.inject(['cordisInspect'], (child) => {
    const cordisInspect = child.get('cordisInspect') as CordisInspectRegistryLike | undefined
    if (cordisInspect && typeof cordisInspect.register === 'function') {
      return installCordisInspectCompatibility(cordisInspect)
    }
  })
}

interface ReceiptRootCacheEntry {
  mtimeMs: number
  size: number
  roots: string[]
}

const receiptOwnedRootCache = new Map<string, ReceiptRootCacheEntry>()

function parseOwnedArtifactRoots(filePath: string): string[] {
  const record = JSON.parse(readFileSync(filePath, 'utf8')) as { ownedArtifactRoot?: unknown }
  return typeof record.ownedArtifactRoot === 'string' && record.ownedArtifactRoot.trim()
    ? [path.resolve(record.ownedArtifactRoot)]
    : []
}

export function receiptOwnedRoots(stateRoot: string): string[] {
  const directory = path.join(stateRoot, 'installations')
  try {
    const listed = readdirSync(directory)
      .filter((entry) => /^installation_[a-f0-9]{16,64}\.json$/u.test(entry))
      .map((entry) => path.join(directory, entry))
    const seen = new Set(listed)
    for (const cachedPath of [...receiptOwnedRootCache.keys()]) {
      if (path.dirname(cachedPath) === directory && !seen.has(cachedPath)) {
        receiptOwnedRootCache.delete(cachedPath)
      }
    }
    return listed.flatMap((filePath) => {
      try {
        const stats = statSync(filePath)
        const cached = receiptOwnedRootCache.get(filePath)
        if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
          return cached.roots
        }
        const roots = parseOwnedArtifactRoots(filePath)
        receiptOwnedRootCache.set(filePath, { mtimeMs: stats.mtimeMs, size: stats.size, roots })
        return roots
      } catch {
        receiptOwnedRootCache.delete(filePath)
        return []
      }
    })
  } catch {
    for (const cachedPath of [...receiptOwnedRootCache.keys()]) {
      if (path.dirname(cachedPath) === directory) receiptOwnedRootCache.delete(cachedPath)
    }
    return []
  }
}

export const _testing = {
  createIsEvolutionMode,
  installCordisInspectCompatibilityWhenAvailable,
  receiptOwnedRoots,
}
