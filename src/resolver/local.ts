import type { Context } from '@deepseek-ai/cordis'
import type { SkillRegistry } from '@deepseek-ai/dsh-skill'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { LocalCapabilityCandidate } from '../contracts.js'
import { TOOL_NAMES } from '../contracts.js'
import { isWorkflowSkill } from '../creator-skill.js'
import { capabilityAnchors, isHeavyNameDropMention, isNameDropMention, normalizeSearchText } from './keywords.js'

const BRIDGE_TOOLS = new Set(['tool_search', 'tool_describe', 'tool_call'])

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
    let strength = 0
    const descriptionSignals = new Set(anchor.aliases
      .filter((alias) => normalizedDescription.includes(alias))
      // "grok build" and "grok" are the same semantic signal. Collapse
      // overlapping product aliases so a laundry-list mention does not become
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

export interface LocalResolution {
  cwd: string
  candidates: LocalCapabilityCandidate[]
  shouldDiscoverRemote: boolean
  reasons: string[]
}

export async function resolveLocalCapabilities(
  ctx: Context,
  requirement: string,
  exec: Pick<ToolRunContext, 'agent' | 'signal'>,
): Promise<LocalResolution> {
  const cwd = exec.agent?.session.header.cwd ?? process.cwd()
  const scope = exec.agent
  const registryTools = ctx.tools.schemas(scope)
  const assembly = await ctx.systemPrompt.assemble(scope
    ? { scope, signal: exec.signal }
    : { signal: exec.signal })
  const assembledNames = new Set(assembly.tools.map((tool) => tool.name))
  // Registration is not reachability: the model can use the bridge only when
  // all three bridge tools are present in this Agent scope's assembled prompt.
  const hasBridge = [...BRIDGE_TOOLS].every((toolName) => assembledNames.has(toolName))
  const ownTools = new Set<string>(TOOL_NAMES)
  const candidates: LocalCapabilityCandidate[] = []

  for (const tool of registryTools) {
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

  candidates.sort((left, right) => right.confidence - left.confidence || left.name.localeCompare(right.name))
  const useful = candidates.some((candidate) => candidate.confidence >= 0.62)
  return {
    cwd,
    candidates: candidates.slice(0, 8),
    shouldDiscoverRemote: !useful,
    reasons: useful
      ? ['A sufficiently relevant local capability is already available; remote search was skipped.']
      : ['No sufficiently relevant local capability was found; remote discovery is allowed.'],
  }
}

export const _testing = { matchConfidence }
