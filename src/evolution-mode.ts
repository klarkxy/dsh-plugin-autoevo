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
2. Present interrupt facts in chat exactly as returned and wait. Do not call ask_user. After the user replies, call capability_workflow_resume with only workflow_id and interrupt_id. The Host resolves the decision from the claimed user turn. create_authorized / modify_this continue only in a Host-launched workspace-write managed git source child — never via parent-session cordis_define(kind:new), shell, filesystem write/edit, or nested delegation. Parent final guards enforce those boundaries. On Windows, isolation is integrity-oriented and partial. market_restart_required means tell the user to restart DSH, then start a new workflow. Do not review dsh-find-plugin as the requested capability. Zero results on exact-phrase queries do not mean no plugin exists. Load ${CREATOR_SKILL_NAME} for managed create/modify guidance in this mode.
3. After an improved plugin is installed, verified, and the user's current task is complete, check the installation receipt's contributionAdvice. Offer to contribute only after explicit approval; inspect the diff for user-specific content, then fork, push, and open a PR under that fresh approval. Parent-session read/search/review tools stay available. This mode does not globally replace the official cordis-plugin-development skill used outside Capability Evolution for static package work or existing repair.`

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
