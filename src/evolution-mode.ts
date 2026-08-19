import type { Context } from '@deepseek-ai/cordis'
import {
  EVOLUTION_MODE_SERVICE_KEY,
  createEvolutionModeMarker,
  isEvolutionModeMarker,
  type EvolutionModeMarker,
} from './evolution-contracts.js'

export const name = 'autoevo-evolution-mode'
export const inject = ['systemPrompt'] as const

const EVOLUTION_WORKFLOW = `Capability Evolution mode:
1. Reuse first, improve second, create last. When a new capability is needed, call capability_workflow with the user's original wording and follow the returned interrupt or terminal state. Prefer existing tools, skills, and reviewed plugins over building from scratch. If the user chose an existing local or reviewed capability, use that; do not inspect Cordis to wrap it. Policy V5: unfinished older-policy workflows are not resumable; call capability_workflow again to start a fresh V5 discovery. Old reviews stay readable but never authorize use/install.
2. Summarize shortlist/review facts briefly instead of narrating the protocol. MechanicalFacts are display/routing only; an explicit OR condition starts a clean Host-owned semantic reviewer. Security findings are static observations only: report their grouped sources and detector detail, never infer intent, necessity, command targets, runtime execution, callback-server behavior, or another justification that the facts do not establish. At await_selection or when the user asks to compare, interpret natural language such as "两个都", "前两个", "全部", "另一个", or "第二个" into candidate IDs from the current interrupt snapshot. Before the review tool call, send one short status naming the targets and that review may take about one to two minutes; then call capability_workflow_resume with workflow_id, interrupt_id, and navigation. Use adaptive review for "按推荐". Navigation is read-only and never authorizes mutation. At await_confirmation, simple UI primary actions are use_this and search_more; modify_this, create_new, and stop are advanced/recovery. Trust your semantic understanding of the user's fresh reply and pass decision with an allowed action, the action's current candidate_id for use_this/modify_this, and optional retention for use_this. The Host binds your interpretation to the authentic user turn, mints the commitment/lease, and validates session, interrupt, snapshot, candidate, review, and replay boundaries; it does not re-parse the user's wording. Never supply user_message, repository names, paths, review IDs, or install facts.
3. create_authorized / modify_this continue only in a Host-launched workspace-write managed git source child — never via parent-session cordis_define(kind:new), shell, filesystem write/edit, nested delegation, or a Creator skill. Parent final guards enforce those boundaries. On Windows, isolation is integrity-oriented and partial. market_setup_required means marketplace setup did not finish and creation stays blocked. market_restart_required and restart_required mean a verified install could not be fully hot-loaded into the current process, so tell the user to restart DSH; otherwise never request a restart merely because an install occurred. Do not review dsh-find-plugin as the requested capability. Zero results on exact-phrase queries do not mean no plugin exists.
4. Install success requires Host mechanical Loader evidence and an independent semantic verifier. taskResultMatchedExpectation is diagnostic only and never Host verified truth. After an improved plugin is installed, verified, and the user's current task is complete, check the installation receipt's contributionAdvice. Offer to contribute only after explicit approval; inspect the diff for user-specific content, then fork, push, and open a PR under that fresh approval. Parent-session read/search/review tools stay available.`

export function apply(ctx: Context): void {
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
