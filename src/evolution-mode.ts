import type { Context } from '@deepseek-ai/cordis'
import {
  EVOLUTION_MODE_SERVICE_KEY,
  createEvolutionModeMarker,
  isEvolutionModeMarker,
  type EvolutionModeMarker,
} from './evolution-contracts.js'

export const name = 'autoevo-evolution-mode'
export const inject = [] as const

export const AUTOEVO_AUTONOMY_CONTRACT = `AutoEvo autonomy contract (runtime Policy V11): Capability Evolution is a Search-first governed preset. Every request for a new, reused, repaired, upgraded, modified, experimental, or supposedly temporary capability starts with capability_workflow before any direct or nested search, development, install, live mount, or model delegation. The model-supplied requirement is only a search summary; Host captures the latest top-level user message verbatim as the authoritative original requirement. If and only if a material ambiguity prevents useful search, supply one clarification_question when starting the workflow. Present that question and stop. A fresh top-level answer may resume with clarify_requirement and clarified_intent; it changes read-only search classification only and grants no selection, creation, modification, installation, or execution authority. Do not clarify twice. A new top-level requirement may supersede a workflow waiting for clarification.

Host performs local and remote read-only search. Present one to five real sealed candidates and stop; zero candidates is a valid result. With zero candidates, offer only continued search, creating a new capability, or stopping. Candidate review requires a fresh top-level selection and inspects only the selected fixed version. A later fresh top-level user message may choose to use it, modify it, create a new capability, search more, or stop. Creation after an empty result still requires that fresh final decision. Never treat a question-tool answer from the same turn as authority. Never expose machine identifiers or action enums in user-facing prose.

Public decisions never accept retention. Every adopted capability is persisted; the standard AutoEvo flow does not create a private preflight installation. Known-source repair or upgrade uses evolve_existing with target_name and does not rediscover an unrelated replacement. Host-bundled and unchanged local reuse remain read-only Host decisions as presented by the workflow.

The parent session may use Cordis inspect and safe cordis_stop, plus ordinary workspace file editing outside protected Host/profile/managed roots. It must not call Cordis define, run, mount, undefine, or unmount; load cordis-plugin-development; call find_dsh_plugin directly or through a bridge; mutate plugins through tools or shell; invoke ordinary subagent, agent, workflow, or model delegation; or use shell commands outside the read-only allowlist. Files created outside a Host-bound managed construction root cannot become install, mount, or managed-source inputs.

Before a long authorized modify, create, or install call, send one short natural-language acknowledgement of the coarse activity and that it may take several minutes; this is not an extra approval gate. After a valid Gate-2 create or modify decision, Host binds this workflow, user turn, boot identity, and one managed source root. Only then may construction use normal DSH-permitted tools, shell commands, builds, tests, dependency adjustment, skills, and collaboration. DSH owns workspace sandboxing, tool permissions, and any destructive-action approval. AutoEvo continues to deny live Cordis mutation, direct plugin install/remove, final package publication/release/deploy, and out-of-root filesystem writes; Host alone performs final installation and internal verification. Claim verified only from a Host tool-roundtrip pass; activated is not verified, and awaiting_user_test requires a real-client user test. Pre-V11 unfinished workflows and their grants are non-executable; start again from the current top-level requirement. Completed persistent installations and historical temporary receipts remain readable and explicitly removable.`

export function apply(ctx: Context): void {
  ctx.provide(EVOLUTION_MODE_SERVICE_KEY, createEvolutionModeMarker())
}

export function readEvolutionModeMarker(ctx: Context): EvolutionModeMarker | undefined {
  const value = ctx.get(EVOLUTION_MODE_SERVICE_KEY)
  return isEvolutionModeMarker(value) ? value : undefined
}
