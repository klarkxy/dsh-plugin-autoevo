---
name: autoevo-plugin-creator
description: Runtime reference for AutoEvo Capability Evolution discovery and Host-managed source construction. Use in the Capability Evolution preset for Search-first discovery and Host-managed modify/create.
---

<!-- autoevo-plugin-creator:v2 -->

# AutoEvo Capability Evolution

Host workflow and execution guards are authoritative. A prompt never grants install, modify, create, remove, or publish. After an explicit create/modify decision, only the Host-owned managed child's bounded filesystem, shell, build, test, and skill surface may operate inside the bound source.

## 1. Start with discovery

Call `capability_workflow` with a search summary of the user's request. Host captures the latest top-level user message as the authoritative requirement.

During `discovering`, use Host-returned candidates and budgets. For an unambiguous request, pass 1–5 GitHub search phrases as `capability_workflow.queries`. If you supply none and no clarification is pending, Host may derive complementary fallback phrases from the authoritative requirement; Host never rewrites phrases you did supply. Inspect compact cards; score and order are hints. User-supplied exact repositories are pinned. If clarification is necessary, omit initial queries and generate replacement `navigation.queries` only after the fresh answer. Seal 1–5 pool IDs with `capability_workflow_present`; only that shortlist gets bounded root package, README, and DSH manifest previews (untrusted). Carry a fresh search-again reply through `navigation.queries` or `navigation.repositories`. Do not invent a candidate or call `find_dsh_plugin` / raw `gh`.

Two gates:

1. Gate 1 selects a sealed candidate for read-only review.
2. Gate 2 chooses use, modify, create, search again, or stop after review.

A DSH `allowed-once` approval authorizes one concrete side effect. It cannot replace either gate.

## 2. Follow the returned state

Read [the state reference](references/autoevo-state.md) when a workflow result is returned.

| State | Required action |
| --- | --- |
| `discovering` | Refine within budget or present 1–5 real pool IDs. |
| `reuse_local` | Use the selected local tool or skill; do not install or create. |
| `selection_required` | Explain the shortlist and wait for a fresh user selection. Do not pop `ask_user`. |
| `confirmation_required` | Explain fit, risk, compatibility, and gaps; wait for a fresh final decision. |
| `use_review` | Let Host install the selected exact review. Do not build a replacement. |
| `modify_review` | Wait for the Host-managed source and WorkOrder, then follow the managed-work loop. |
| `create_authorized` | Create only in the Host-managed source under the current WorkOrder. |
| `market_required` | Call `capability_workflow` again for Host-owned GitHub topic search. Do not create a plugin. |
| `stopped` | Stop without installation or construction. |
| `recovery_required` | Diagnose or recover only through the current sealed failure path. |

Same-turn resume is a parked no-op. Starting another resolution revokes the previous construction grant.

## 3. Managed modify/create loop

After `modify_review` or `create_authorized`, Host prepares a Git source under `.autoevo/sources/` and starts a short-lived, cwd-bound managed child with a structured WorkOrder. The parent Capability Evolution session remains read-only during construction.

1. Confirm the returned managed path, workflow identity, scope, and acceptance commands.
2. Inspect the files and contracts needed to complete the WorkOrder.
3. Edit only inside the managed source. Preserve package identity unless the WorkOrder says otherwise.
4. Use child-permitted filesystem, shell, build, test, and skill tools. You may edit package.json and run `pnpm install --ignore-scripts` (bare, no package arguments) inside the managed root to materialize declared dependencies. Do not run `pnpm add/update/remove/dlx`, `npx`, nested collaboration, plugin mutation, Git writes, or publish. Do not claim an unobserved test.
5. Complete the WorkOrder in the managed child. Host commits without hooks/signing, re-reviews, freezes, and returns to a fresh install decision. Do not pass an arbitrary checkout path or edit from the parent session.

Never call Cordis live mutation, add/update/remove packages with `pnpm add/update/remove/dlx` or `npx`, silently switch to a same-named substitute, publish/release/deploy, or work outside the managed source. Even a temporary experiment starts with Search-first. Repair of AutoEvo itself must use `evolve_existing` with Host-derived source provenance; if unavailable, return a tested source to an ordinary external controller instead of editing the active profile from the parent.

## 4. Report outcomes exactly

- `verified`: Host `tool_roundtrip` passed; functional verification is supported.
- `activated`: Loader/Fiber activation passed; the capability was not functionally tested.
- `awaiting_user_test`: `manual_runtime` completed; invite one real client/profile test.
- `restartRequired: true`: a non-failure install exists, but the target process needs a restart to load it fully.
- `recovery_required`: state cannot be reconciled safely; do not reinstall or clean up blindly.

Model judgment, `installed`, or `loaded` alone cannot mint `verified`; only a Host-attested `tool_roundtrip` does.

## 5. Diagnose, recover, and clean up

Use `capability_workflow_diagnose` only after a failed or incomplete stage. It is bounded and read-only; it does not retry, install, edit, or clean up. Treat Host facts as evidence. After a fresh user decision, submit only one current recovery ID. Never invent package lists, command text, environment changes, or pnpm flags.

Sealed failure recovery uses the current interrupt. Completed-install cleanup requires a new top-level user request and the workflow-owned installation receipt. `plugin_remove` removes only the receipt-owned installed capability and artifact; it does not remove AutoEvo or the managed source.

For regression evaluation, use [the trace expectations](references/eval-traces.md). Report IDs, outcome, verification layer, and any restart or real-client limitation.
