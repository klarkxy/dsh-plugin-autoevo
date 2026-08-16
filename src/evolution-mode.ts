import type { Context } from '@deepseek-ai/cordis'
import { CREATOR_SKILL_NAME, registerCreatorSkill } from './creator-skill.js'
import {
  EVOLUTION_MODE_SERVICE_KEY,
  EVOLUTION_PRESET_DISPLAY_NAME,
  createEvolutionModeMarker,
  isEvolutionModeMarker,
  type EvolutionModeMarker,
} from './evolution-contracts.js'

export const name = 'autoevo-evolution-mode'
export const inject = ['skills', 'systemPrompt'] as const

const EVOLUTION_WORKFLOW = `Capability Evolution mode (${EVOLUTION_PRESET_DISPLAY_NAME}):
1. Reuse first, improve second, create last. Prefer existing tools, skills, and reviewed plugins over building from scratch.
2. Before any new capability work, call capability_resolve for the concrete requirement. Treat its authorization as the sole authority: reuse_required / review_required / modify_required block scratch creation; only scratch_ready permits one successful cordis_define with plugin.kind="new".
3. For dynamic Cordis Plugin work in this mode, load ${CREATOR_SKILL_NAME} and follow its workflow. Technical failures of cordis_define(kind:new) may retry under the same live grant; a successful define consumes it.
4. Ordinary coding, shell, filesystem, web, planning, and other tools stay available — evolution mode does not disable them.
5. Outside this preset, the official cordis-plugin-development skill remains appropriate for static package/export work and existing repair workflows. This mode does not globally replace that skill; it scopes dynamic new defines to Capability Evolution after capability_resolve returns scratch_ready.`

export function apply(ctx: Context): void {
  registerCreatorSkill(ctx)
  ctx.systemPrompt.section({
    name: 'autoevo:evolution-mode',
    order: 119,
    text: EVOLUTION_WORKFLOW,
  })
  ctx.provide(EVOLUTION_MODE_SERVICE_KEY, createEvolutionModeMarker())
}

export function readEvolutionModeMarker(ctx: Context): EvolutionModeMarker | undefined {
  const value = ctx.get(EVOLUTION_MODE_SERVICE_KEY)
  return isEvolutionModeMarker(value) ? value : undefined
}
