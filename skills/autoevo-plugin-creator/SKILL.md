---
name: autoevo-plugin-creator
description: Runtime reference for AutoEvo Capability Evolution discovery and Host-managed source construction. Use only inside the Capability Evolution preset when an AutoEvo workflow returns a managed WorkOrder; do not use for generic Cordis development, direct plugin definition, releases, or unrelated repository work.
---

<!-- autoevo-plugin-creator:v2 -->

# AutoEvo Capability Evolution

This packaged skill is compatibility guidance for the Capability Evolution preset. The Host workflow and execution guards are authoritative. A prompt or this file never grants permission to install, modify, create, remove, or publish. After an explicit create/modify decision, only the bounded filesystem, shell, build, test, and skill surface exposed by the Host-owned managed child is available inside the bound source.

## 1. Start with discovery

Call `capability_workflow` with the user's original capability wording. Do not replace the requirement with an implementation proposal.

During `discovering`, use only Host-returned candidates and budgets. For an unambiguous initial request, generate 1–5 concise semantic GitHub search phrases and pass them through `capability_workflow.queries`; the Host keeps them separate from the authoritative requirement. The Host returns the complete bounded union after objective repository validation and deduplication. Inspect every compact candidate card: score and order are hints, not semantic eligibility. Exact GitHub repositories supplied by the user are pinned first and must not be discarded. If clarification is necessary, omit initial queries and generate replacement `navigation.queries` only after the fresh answer. Refine when evidence would change the shortlist, then seal 1–5 pool candidate IDs with `capability_workflow_present`; only that shortlist receives bounded root package, README, and DSH manifest previews, all marked as untrusted data. When a fresh user reply asks to search again with new terms or supplies an exact GitHub repository, carry those terms through `navigation.queries` or that repository through `navigation.repositories`; the Host validates and budgets them before consuming the turn. Do not invent a candidate or call `find_dsh_plugin` / raw `gh` yourself.

Two fresh user messages are separate gates:

1. Gate 1 selects a sealed candidate for read-only review.
2. Gate 2 chooses use, modify, create, search again, or stop after review.

A DSH `allowed-once` approval authorizes one concrete side effect. It cannot replace either gate.

## 2. Follow the returned state

Read [the state reference](references/autoevo-state.md) when a workflow result is returned.

| State | Required action |
| --- | --- |
| `discovering` | Refine within the returned budget or present 1–5 real pool IDs. |
| `reuse_local` | Use the selected local tool or skill; do not install or create. |
| `selection_required` | Explain the shortlist in chat and wait for a fresh user selection. Do not pop `ask_user`. |
| `confirmation_required` | Explain fit, risk, compatibility, and missing capability; wait for a fresh final decision. |
| `use_review` | Let the Host install the selected exact review. Do not build a replacement. |
| `modify_review` | Wait for the Host-managed source and WorkOrder, then follow the managed-work loop below. |
| `create_authorized` | Create only in the Host-managed source under the current WorkOrder. |
| `market_required` | Older receipt parked on marketplace setup. Call `capability_workflow` again so Host-owned GitHub topic search can run. Do not create a plugin. |
| `stopped` | Stop without installation or construction. |
| `recovery_required` | Diagnose or recover only through the current sealed failure path. |

Same-turn resume is a parked no-op, not new authority. Starting another resolution revokes the previous construction grant.

## 3. Managed modify/create loop

After `modify_review` or `create_authorized`, the Host prepares a Git source under the current workspace's `.autoevo/sources/` root and starts a short-lived, cwd-bound managed child with a structured WorkOrder. The parent Capability Evolution session remains read-only during construction.

1. Confirm the returned managed path, workflow identity, scope, and acceptance commands.
2. Inspect only the files and contracts required by the WorkOrder.
3. Edit only inside the managed source. Preserve package identity unless the WorkOrder says otherwise, but make every change needed for a complete result.
4. Use only the child-permitted filesystem, shell, build, test, and skill tools. Do not install dependencies, start nested collaboration, mutate plugins, run Git, or publish. Record actual checks and results; do not claim an unobserved test.
5. Complete the WorkOrder in the managed child. The Host validates Git state, commits without hooks/signing, re-reviews the exact source, freezes an owned artifact, and returns to a fresh install decision. Do not pass an arbitrary checkout path or edit from the parent session.

Never call Cordis live mutation, directly install/remove a package, silently switch to a same-named substitute, publish/release/deploy, or work outside the managed source. In Capability Evolution, even a temporary experiment starts with the same Search-first workflow; parent-session live repair is not an exception. Repair of AutoEvo itself must use `evolve_existing` with Host-derived source provenance; if that provenance is unavailable, return a tested source candidate to an ordinary external controller instead of building, installing, or editing the active profile from the parent.

## 4. Report outcomes exactly

- `verified`: Host `tool_roundtrip` passed; functional verification is supported.
- `activated`: Loader/Fiber activation passed; the capability was not functionally tested.
- `awaiting_user_test`: persistent `manual_runtime` completed; invite one real client/profile test.
- `restartRequired: true`: a non-failure capability install exists, but the target process needs a restart to load it fully.
- `recovery_required`: state cannot be reconciled safely; do not reinstall or clean up blindly.

An isolated minimal-DSH preflight, model judgment, semantic verifier, `installed`, or `loaded` alone cannot mint `verified`.

## 5. Diagnose, recover, and clean up

Use `capability_workflow_diagnose` only after a failed or incomplete stage. It is bounded and read-only; it does not retry, install, edit, or clean up.

Unexpected failures remain yours to interpret. Treat Host-returned facts as evidence, compare the visible recovery, modification, continued-search, and stop paths, and explain the tradeoff in natural language. A recovery choice includes its semantic effect, evidence, consequence, and opaque recovery ID. After a fresh user decision, submit only one current recovery ID. Never submit or invent package lists, command text, environment changes, pnpm flags, or other executor parameters; Host retrieves the sealed typed plan and revalidates it against the failed receipt before execution. If no supported recovery choice exists, use another visible path rather than guessing a Host workaround.

Sealed failure recovery and completed-install cleanup/restart are distinct Host paths. The failure path uses the current interrupt. Completed cleanup requires a new top-level user request and uses the workflow-owned installation receipt. `plugin_remove` removes only the receipt-owned installed capability and artifact; it does not remove AutoEvo or the managed source.

For regression evaluation, use [the trace expectations](references/eval-traces.md). Report workflow/review/installation IDs, exact outcome, verification layer, and any restart or real-client limitation.
