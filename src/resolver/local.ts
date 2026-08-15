import type { Context } from '@deepseek-ai/cordis'
import type { SkillRegistry } from '@deepseek-ai/dsh-skill'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { LocalCapabilityCandidate } from '../contracts.js'
import { TOOL_NAMES } from '../contracts.js'
import { capabilityTerms, normalizeSearchText } from './keywords.js'

const BRIDGE_TOOLS = new Set(['tool_search', 'tool_describe', 'tool_call'])

function matchConfidence(requirement: string, name: string, description: string): number {
  const terms = capabilityTerms(requirement)
  if (terms.length === 0) return 0
  const normalizedName = normalizeSearchText(name)
  const normalizedDescription = normalizeSearchText(description)
  let score = 0
  for (const term of terms) {
    const normalizedTerm = normalizeSearchText(term)
    if (!normalizedTerm) continue
    if (normalizedName === normalizedTerm) score += 0.55
    else if (normalizedName.includes(normalizedTerm) || normalizedTerm.includes(normalizedName)) score += 0.35
    if (normalizedDescription.includes(normalizedTerm)) score += 0.18
  }
  return Math.min(0.99, score)
}

export interface LocalResolution {
  cwd: string
  candidates: LocalCapabilityCandidate[]
  githubShouldRun: boolean
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
    if (!skill.invocation.modelInvocable) continue
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
    githubShouldRun: !useful,
    reasons: useful
      ? ['A sufficiently relevant local capability is already available; remote search was skipped.']
      : ['No sufficiently relevant local capability was found; remote discovery is allowed.'],
  }
}

export const _testing = { matchConfidence }
