import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import {
  installCordisInspectCompatibility,
  type CordisInspectRegistryLike,
} from './cordis-inspect-compat.js'
import { EvolutionError } from './errors.js'
import {
  EVOLUTION_MODE_SERVICE_KEY,
  EVOLUTION_PRESET_ID,
  isEvolutionModeMarker,
} from './evolution-contracts.js'
import { isNotFound } from './internal-utils.js'

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

function parseOwnedArtifactRoots(filePath: string): string[] {
  let record: { ownedArtifactRoot?: unknown }
  try {
    record = JSON.parse(readFileSync(filePath, 'utf8')) as { ownedArtifactRoot?: unknown }
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    throw new EvolutionError('invalid_input', `Installation receipt ${path.basename(filePath)} is not valid JSON; ExecutionGuard cannot compute owned roots`)
  }
  return typeof record.ownedArtifactRoot === 'string' && record.ownedArtifactRoot.trim()
    ? [path.resolve(record.ownedArtifactRoot)]
    : []
}

/**
 * Receipt-owned capability roots the parent model may never write into.
 * This feeds ExecutionGuard.protectedRoots, so it fails closed: only a
 * missing installations directory is an empty result; an unreadable
 * directory or an unparseable receipt throws and the tool call fails.
 */
export function receiptOwnedRoots(stateRoot: string): string[] {
  const directory = path.join(stateRoot, 'installations')
  let entries: string[]
  try {
    entries = readdirSync(directory)
  } catch (error) {
    if (isNotFound(error)) return []
    throw error
  }
  return entries
    .filter((entry) => /^installation_[a-f0-9]{16,64}\.json$/u.test(entry))
    .flatMap((entry) => parseOwnedArtifactRoots(path.join(directory, entry)))
}

export const _testing = {
  createIsEvolutionMode,
  installCordisInspectCompatibilityWhenAvailable,
  receiptOwnedRoots,
}
