import type { Context } from '@deepseek-ai/cordis'
import { CREATOR_SKILL_NAME, registerCreatorSkill } from './creator-skill.js'
import {
  EVOLUTION_MODE_SERVICE_KEY,
  createEvolutionModeMarker,
  isEvolutionModeMarker,
  type EvolutionModeMarker,
} from './evolution-contracts.js'

export const name = 'autoevo-evolution-mode'
export const inject = ['skills', 'systemPrompt'] as const

const EVOLUTION_WORKFLOW = `Capability Evolution mode:
1. Reuse first, improve second, create last. When a new capability is needed, call capability_workflow with the user's original wording and follow the returned interrupt or terminal state. Prefer existing tools, skills, and reviewed plugins over building from scratch. If the user chose an existing local or reviewed capability, use that; do not inspect Cordis to wrap it.
2. Present interrupt facts in chat exactly as returned and wait. Do not call ask_user. After the user replies, call capability_workflow_resume with their verbatim message and the matching option_id. Only scratch_ready after an explicit create-new resume permits one successful cordis_define with plugin.kind="new". For improve-this, follow the modify work order, then resume with the local checkout path; the workflow derives base_review_id. market_restart_required means tell the user to restart DSH, then start a new workflow. Do not review dsh-find-plugin as the requested capability. Zero results on exact-phrase queries do not mean no plugin exists. Technical failures of cordis_define(kind:new) may retry under the same live grant; a successful define consumes it. Load ${CREATOR_SKILL_NAME} for dynamic Cordis work in this mode.
3. After an improved plugin is installed, verified, and the user's current task is complete, check the installation receipt's contributionAdvice. Offer to contribute only after explicit approval; inspect the diff for user-specific content, then fork, push, and open a PR under that fresh approval. Ordinary coding tools stay available. This mode does not globally replace the official cordis-plugin-development skill used outside Capability Evolution for static package work or existing repair.`

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
