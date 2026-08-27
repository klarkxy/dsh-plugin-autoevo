import type { Context } from '@deepseek-ai/cordis'
import type { SkillRegistry } from '@deepseek-ai/dsh-skill'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { LocalCapabilityCandidate, RequestIntent } from '../contracts.js'
import { DEFAULT_REQUEST_INTENT, TOOL_NAMES } from '../contracts.js'
import { isWorkflowSkill } from '../creator-skill.js'
import { applyIntentToCandidate, suppressesRemoteDiscovery } from './intent.js'
import { resolveHostBundledCapabilities } from './host-bundled.js'
import { capabilityAnchors, isHeavyNameDropMention, isNameDropMention, normalizeSearchText } from './keywords.js'
import { resolveLoadedPluginCapabilities } from './plugins.js'
import { resolveProfilePluginCapabilities } from './profile.js'

const BRIDGE_TOOLS = new Set(['tool_search', 'tool_describe', 'tool_call'])

function anchorStrength(anchor: ReturnType<typeof capabilityAnchors>[number], normalizedName: string, normalizedDescription: string): number {
  let strength = 0
  const descriptionSignals = new Set(anchor.aliases
    .filter((alias) => normalizedDescription.includes(alias))
    // A multi-word identifier and its contained token are the same semantic
    // signal. Collapse overlapping aliases so a laundry-list mention does not become
    // corroboration merely because one phrase contains another.
    .map((alias) => alias.includes(anchor.key) ? anchor.key : alias))
  const hasCorroboratingDescriptionSignals = descriptionSignals.size >= 2
  for (const alias of anchor.aliases) {
    if (normalizedName === alias) strength = Math.max(strength, 1)
    else if (normalizedName.includes(alias) || alias.includes(normalizedName)) strength = Math.max(strength, 0.92)
    if (normalizedDescription.includes(alias)
      && !isHeavyNameDropMention(normalizedDescription, alias)
      && (hasCorroboratingDescriptionSignals || !isNameDropMention(normalizedDescription, alias))) {
      strength = Math.max(strength, 0.58)
    }
  }
  return strength
}

export function matchConfidence(requirement: string, name: string, description: string): number {
  const anchors = capabilityAnchors(requirement)
  if (anchors.length === 0) return 0
  const normalizedName = normalizeSearchText(name)
  const normalizedDescription = normalizeSearchText(description)
  let specificWeight = 0
  let specificCoverage = 0
  let genericWeight = 0
  let genericCoverage = 0

  for (const anchor of anchors) {
    const strength = anchorStrength(anchor, normalizedName, normalizedDescription)
    if (anchor.generic) {
      genericWeight += anchor.weight
      genericCoverage += anchor.weight * strength
    } else {
      specificWeight += anchor.weight
      specificCoverage += anchor.weight * strength
    }
  }

  // Each anchor contributes at most its best name-or-description match.  This
  // prevents repeated wording in a long description from saturating the score.
  if (specificWeight === 0) return Math.min(0.18, genericCoverage / Math.max(genericWeight, 1))
  const genericBoost = genericWeight === 0 ? 0 : (genericCoverage / genericWeight) * 0.04
  return Math.min(0.99, specificCoverage / specificWeight + genericBoost)
}

/**
 * A product name narrows the target, but does not establish that a local
 * capability performs the requested operation. Keep discovery open until the
 * candidate also matches every requested non-product capability anchor.
 */
export function isStrictLocalMatch(requirement: string, name: string, description: string): boolean {
  const anchors = capabilityAnchors(requirement)
  const materialAnchors = anchors.filter((anchor) => !anchor.generic)
  const functionalAnchors = materialAnchors.filter((anchor) => !anchor.product)
  if (materialAnchors.length === 0) return false
  if (anchors.some((anchor) => anchor.product) && functionalAnchors.length === 0) return false

  const normalizedName = normalizeSearchText(name)
  const normalizedDescription = normalizeSearchText(description)
  return materialAnchors.every((anchor) => anchorStrength(anchor, normalizedName, normalizedDescription) >= 0.58)
}

function localFit(requirement: string, candidate: Pick<LocalCapabilityCandidate, 'name' | 'description' | 'confidence'>): Pick<LocalCapabilityCandidate, 'fit' | 'matchedFacets' | 'missingFacets'> {
  const anchors = capabilityAnchors(requirement).filter((anchor) => !anchor.generic)
  const normalizedName = normalizeSearchText(candidate.name)
  const normalizedDescription = normalizeSearchText(candidate.description)
  const matchedFacets = anchors
    .filter((anchor) => anchorStrength(anchor, normalizedName, normalizedDescription) >= 0.58)
    .map((anchor) => anchor.key)
  const missingFacets = anchors.filter((anchor) => !matchedFacets.includes(anchor.key)).map((anchor) => anchor.key)
  const full = candidate.confidence >= 0.62 && isStrictLocalMatch(requirement, candidate.name, candidate.description)
  return {
    fit: full ? 'full' : candidate.confidence >= 0.3 ? 'partial' : 'none',
    matchedFacets,
    missingFacets,
  }
}

export interface LocalResolution {
  cwd: string
  candidates: LocalCapabilityCandidate[]
  shouldDiscoverRemote: boolean
  reasons: string[]
}

export interface LocalCapabilityOptions {
  dshHome?: string
  activeProfile?: string
  intent?: RequestIntent
  /** Resolved Host dsh CLI package root; enables host-bundled opt-in candidates. */
  dshPackageRoot?: string
}

function mergeProfileAndLoadedCandidates(
  profileCandidates: readonly LocalCapabilityCandidate[],
  loadedCandidates: readonly LocalCapabilityCandidate[],
): LocalCapabilityCandidate[] {
  const byName = new Map(profileCandidates.map((candidate) => [candidate.name, candidate]))
  for (const loaded of loadedCandidates) {
    const profile = byName.get(loaded.name)
    byName.set(loaded.name, profile
      ? {
          ...profile,
          ...loaded,
          description: loaded.description || profile.description,
          confidence: Math.max(profile.confidence, loaded.confidence),
          ...(profile.profileEvidence ? { profileEvidence: profile.profileEvidence } : {}),
        }
      : loaded)
  }
  return [...byName.values()]
}

export async function resolveLocalCapabilities(
  ctx: Context,
  requirement: string,
  exec: Pick<ToolRunContext, 'agent' | 'signal'>,
  options: LocalCapabilityOptions = {},
): Promise<LocalResolution> {
  const cwd = exec.agent?.session.header.cwd ?? process.cwd()
  const scope = exec.agent
  const registryTools = ctx.tools.schemas(scope)
  const assembly = await ctx.systemPrompt.assemble(scope
    ? { scope, signal: exec.signal }
    : { signal: exec.signal })
  const assembledNames = new Set(assembly.tools.map((tool) => tool.name))
  // DSH releases may scope the registry view more narrowly than the already
  // assembled model prompt. A directly assembled tool is authoritative proof
  // of reachability, so merge it back into discovery instead of treating an
  // empty scoped registry as "no local capability".
  const reachableTools = new Map(registryTools.map((tool) => [tool.name, tool]))
  for (const tool of assembly.tools) {
    const registered = reachableTools.get(tool.name)
    reachableTools.set(tool.name, {
      ...registered,
      ...tool,
      description: tool.description || registered?.description || '',
    })
  }
  // Registration is not reachability: the model can use the bridge only when
  // all three bridge tools are present in this Agent scope's assembled prompt.
  const hasBridge = [...BRIDGE_TOOLS].every((toolName) => assembledNames.has(toolName))
  const ownTools = new Set<string>(TOOL_NAMES)
  const candidates: LocalCapabilityCandidate[] = []

  for (const tool of reachableTools.values()) {
    if (ownTools.has(tool.name) || BRIDGE_TOOLS.has(tool.name)) continue
    const confidence = matchConfidence(requirement, tool.name, tool.description)
    if (confidence < 0.3) continue
    if (assembledNames.has(tool.name)) {
      candidates.push({
        kind: 'tool',
        name: tool.name,
        description: tool.description,
        availability: 'available',
        confidence,
      })
    } else if (hasBridge) {
      candidates.push({
        kind: 'tool',
        name: tool.name,
        description: tool.description,
        availability: 'available_via_tool_search',
        confidence,
      })
    }
  }

  const skillRegistry = (ctx as Context & { skills: SkillRegistry }).skills
  const skills = await skillRegistry.list(scope
    ? { cwd, scope, signal: exec.signal }
    : { cwd, signal: exec.signal })
  for (const skill of skills) {
    if (!skill.invocation.modelInvocable || isWorkflowSkill(skill.name)) continue
    const description = [skill.description, skill.whenToUse].filter(Boolean).join(' ')
    const confidence = matchConfidence(requirement, skill.name, description)
    if (confidence < 0.3) continue
    candidates.push({
      kind: 'skill',
      name: skill.name,
      description,
      availability: 'available',
      confidence,
    })
  }

  const profileCandidates = options.dshHome && options.activeProfile
    ? await resolveProfilePluginCapabilities({
        dshHome: options.dshHome,
        profile: options.activeProfile,
        requirement,
        match: matchConfidence,
      })
    : []
  const loadedCandidates = await resolveLoadedPluginCapabilities(ctx, requirement, matchConfidence)
  candidates.push(...mergeProfileAndLoadedCandidates(profileCandidates, loadedCandidates))

  if (options.dshPackageRoot && options.dshHome) {
    const bundledCandidates = await resolveHostBundledCapabilities({
      dshPackageRoot: options.dshPackageRoot,
      dshHome: options.dshHome,
      requirement,
      match: matchConfidence,
      ...(options.activeProfile ? { activeProfile: options.activeProfile } : {}),
    }).catch(() => [])
    const knownNames = new Set(candidates.map((candidate) => candidate.name))
    for (const bundled of bundledCandidates) {
      if (!knownNames.has(bundled.name)) candidates.push(bundled)
    }
  }

  const intent = options.intent ?? DEFAULT_REQUEST_INTENT
  for (const candidate of candidates) {
    if (!(candidate.fit === 'full' && candidate.profileEvidence)) {
      Object.assign(candidate, localFit(requirement, candidate))
    }
    Object.assign(candidate, applyIntentToCandidate(candidate, intent))
  }

  candidates.sort((left, right) => right.confidence - left.confidence || left.name.localeCompare(right.name))
  const useful = suppressesRemoteDiscovery(candidates)
  return {
    cwd,
    candidates: candidates.slice(0, 8),
    shouldDiscoverRemote: !useful,
    reasons: useful
      ? ['A sufficiently relevant local capability is already available; remote search was skipped.']
      : ['No sufficiently relevant local capability was found; remote discovery is allowed.'],
  }
}

export const _testing = { matchConfidence, isStrictLocalMatch, localFit, applyIntentToCandidate }
