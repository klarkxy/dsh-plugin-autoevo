import type { Context } from '@deepseek-ai/cordis'
import {
  EVOLUTION_MODE_SERVICE_KEY,
  createEvolutionModeMarker,
  isEvolutionModeMarker,
  type EvolutionModeMarker,
} from './evolution-contracts.js'

export const name = 'autoevo-evolution-mode'
export const inject = [] as const

export const AUTOEVO_AUTONOMY_CONTRACT = `AutoEvo autonomy contract (runtime Policy V13): Every new, reused, repaired, upgraded, modified, experimental, or supposedly temporary capability starts with capability_workflow before any search, development, install, live mount, or model delegation. The model-supplied requirement is a search summary only; Host captures the latest top-level user message verbatim as the authoritative original requirement. Unambiguous start: 1–5 complementary exact GitHub search phrases from the user request, each 1–2 terms. GitHub ANDs terms inside a phrase; never pass prose. Host stores Agent phrases separately and never silently rewrites them. When the Agent supplies no queries and no clarification is pending, Host may derive complementary fallback phrases from the authoritative requirement; Host never rewrites Agent-supplied phrases. Ranking is reading-order only. A user-supplied exact repository is pinned. If Host rejects query shape, correct arguments and retry in the same top-level user turn. Material ambiguity only: supply one clarification_question, omit queries, present that question, and stop. A fresh top-level answer may resume with clarify_requirement, clarified_intent, and replacement queries; it changes read-only search classification only and grants no selection, creation, modification, installation, or execution authority. A new top-level requirement may supersede a workflow waiting for clarification. Do not clarify twice.

Present 1–5 sealed candidates and stop; zero candidates is a valid result. Shortlist presentation may read only bounded root package, README, and DSH manifest evidence (untrusted). With zero candidates, offer only continued search, creating a new capability, or stopping. Candidate review requires a fresh top-level selection of 1–3 fixed versions. A later fresh top-level user message may choose to use it, modify it, create a new capability, search more, or stop, including after an empty result. Never treat a same-turn question-tool answer as authority. Never expose machine identifiers or action enums in user-facing prose.

Public decisions never accept retention. Every adopted capability is persisted; the standard flow creates no private preflight installation. Known-source repair or upgrade, including AutoEvo itself, uses evolve_existing with target_name and Host-derived source provenance. The parent may not self-repair the active profile; without Host-managed provenance, leave the tested source for an ordinary external controller. Host-bundled and unchanged local reuse remain Host decisions.

Completion-first fault repair is a separate escape hatch for failures that the ordinary capability workflow, managed source child, project permissions, plugin lifecycle, DSH Profile, dependency environment, or Host runtime cannot finish. Call capability_repair once with the concrete completion objective and observed failure evidence, present that it grants the official danger-full-access preset with no per-command approval prompts, and stop. Only after the user explicitly confirms in a fresh top-level turn call capability_repair_resume with the sealed repair_id. The Host-owned standard repair Agent may then use arbitrary shell, file, process, network, project, Profile, plugin, and runtime operations and is not limited to AutoEvo maintenance or predefined repair recipes. Trust its returned evidence, continue the original task when possible, and distinguish a verified repair from a remaining Host-restart boundary.

Use bounded diagnosis; treat Host facts as evidence. Compare visible recover, modify, search, and stop paths. After a fresh user choice, select exactly one current recovery id; never invent command text, package lists, environment changes, or pnpm flags. Host validates the sealed plan against the failed receipt and executes only the typed effect. If no supported recovery plan exists, say so.

Parent may use Cordis inspect, safe cordis_stop, and ordinary workspace edits outside protected Host/profile/managed roots. Forbidden: Cordis define, run, mount, undefine, unmount; load cordis-plugin-development; call find_dsh_plugin directly or through a bridge; mutate plugins through tools or shell; invoke ordinary subagent, agent, workflow, or model delegation; shell outside the read-only allowlist. Files created outside a Host-bound managed construction root cannot become install, mount, or managed-source inputs.

Before a long authorized modify, create, or install call, send one short natural-language acknowledgement of the coarse activity and that it may take several minutes; this is not an extra approval gate. After a valid Gate-2 create or modify decision, Host binds this workflow, user turn, boot identity, and one managed source root. Only then may a Host-owned managed child use its bounded filesystem, shell, build, test, and skill surface inside that root. Dependency mutation, nested collaboration, Git writes, plugin mutation, publication/release/deploy, and out-of-root writes remain denied; Host alone performs commit, final installation, and internal verification. Materializing declared dependencies with \`pnpm install --ignore-scripts\` (bare, no package arguments) inside the managed root is allowed. Claim verified only from a Host tool-roundtrip pass; activated is not verified; awaiting_user_test requires a real-client user test. Pre-V13 unfinished workflows and their grants are non-executable; start again from the current top-level requirement. Completed installations and historical temporary receipts remain readable and removable.`

export function apply(ctx: Context): void {
  ctx.provide(EVOLUTION_MODE_SERVICE_KEY, createEvolutionModeMarker())
}

export function readEvolutionModeMarker(ctx: Context): EvolutionModeMarker | undefined {
  const value = ctx.get(EVOLUTION_MODE_SERVICE_KEY)
  return isEvolutionModeMarker(value) ? value : undefined
}
