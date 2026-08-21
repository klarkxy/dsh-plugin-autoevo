---
name: autoevo-plugin-creator
description: Create, update, repair, run, roll back, or clean up a dynamic Cordis Plugin in a DSH session. Use only when the requested outcome is a live, process-local dynamic Cordis Plugin (including Client Slot UI); apply AutoEvo reuse-before-build authorization before a new definition. Do not use for static npm/DSH packages, repository exports, releases, or ordinary Cordis questions.
---

<!-- autoevo-plugin-creator:v1 -->

# AutoEvo Dynamic Cordis Plugin Creator

Build the smallest live Cordis Plugin that satisfies the current task. This skill governs dynamic, process-local Cordis packages only: do not turn the work into a repository, npm package, formal export, commit, push, or release.

Do not load or follow the shipped `cordis-plugin-development` skill. Use the current session's real tool schemas and this workflow instead.

## 1. Classify before calling tools

Use this skill only for a request to create or operate a live dynamic Cordis Plugin.

- **New capability**: no existing target Plugin is named and a new `cordis_define` with `plugin.kind: "new"` would be needed.
- **Existing update or repair**: the request names an existing Plugin (for example `@pluginId`), or diagnoses/restarts a previously defined Plugin. This branch skips `capability_workflow`.
- **Near miss**: static DSH/npm plugin development, a repository export or release, documentation, or a general Cordis question. Do not call AutoEvo or Cordis Plugin tools; handle it through the capability that owns that work.

Never issue a broad inventory merely to explore. Inspect only the exact runtime surface needed by the chosen design.

## 2. New-capability state machine

Before any new definition, call `capability_workflow` with the user's original capability wording. During `discovering`, autonomously refine within the returned budget or seal 1–5 Host-pool candidates with `capability_workflow_present`. Only later fresh-user gates can authorize review or creation. Read [the state details](references/autoevo-state.md) when a result is returned.

| Authorization | Required next action | New definition |
| --- | --- | --- |
| `discovering` | Use Host facts and bounded read-only refinement, then present 1–5 pool candidate IDs. An empty pool stays empty. | Stop |
| `reuse_local` | The user chose an existing local tool or skill. Use it. | Stop |
| `selection_required` | Present each candidate in chat (what it is, why it matched). Do not pop `ask_user` to pick a candidate. Wait for the reply, then `capability_workflow_resume`. Inspect exactly one selected repository at a time. | Stop |
| `confirmation_required` | Explain the review in chat (fit, risk, missing pieces). Do not pop `ask_user` to pick an action. Wait, then `capability_workflow_resume` (use this / improve it / create new / stop). | Stop |
| `use_review` | The user chose to use the reviewed plugin. The workflow installs it; do not create a replacement. Host completion may be verified, activated, or awaiting a user test — only a Host tool-roundtrip pass is functionally verified. | Stop |
| `modify_review` | The user chose to improve the reviewed plugin. Modify it minimally, then resume with the local checkout path. The workflow derives `base_review_id`. At most two modify attempts; after repeated failure, diagnose or let the user choose another reviewed action. | Stop |
| `market_required` | AutoEvo installs `dsh-find-plugin` by script after approval and hot-loads it when possible. Tell the user to approve if asked. Restart DSH only if hot-load fails. Do not review the marketplace as the requested capability. | Stop |
| `stopped` | The user stopped. Do not install or create. | Stop |
| `create_authorized` | The user explicitly allowed one new plugin. Creation continues only in a Host-launched workspace-write child. This is not a mandate to start building. | Host child only |

Use professional judgment during discovery. After evidence is available, ask at most one precise clarification only when OAuth/API/Coding Plan or another material distinction changes the candidate choice; the reply may also select a candidate. Once `capability_workflow_present` opens Gate 1, explain the shortlist naturally and wait for a fresh user message before `capability_workflow_resume`. After a failed stage, use `capability_workflow_diagnose` for bounded new evidence before proposing a retry. Do not repeat the same review, source, layer, and fixture. Sealed failure recovery and completed-install cleanup/restart are distinct Host paths; call `capability_workflow_recover` only in the mode the current facts allow.

Do not redefine an old requirement from memory. A fresh resolve replaces any earlier grant. A failed child-session `cordis_define(kind: "new")` may retry with the same live `create_authorized` grant; a successful one consumes it. Do not bypass a non-create_authorized result by changing wording, creating a same-named Plugin, or defining a static package.

## 3. Design and exact inspection

Choose the smallest Host, Client, or Host-plus-Client design based on data ownership. Query only the exact Service, Event, Builtin, Tool, theme token, or Slot contract that the implementation will use; do not call a broad inspect/list operation and do not infer missing fields.

Read [the runtime rules](references/cordis-runtime.md) only when selecting Host/Client boundaries, private RPC, lifecycle effects, events, tools, or version activation. For Client UI, read [the Slot rules](references/client-slots.md) only after selecting a specific UI surface.

Keep dynamic code as plain JavaScript function bodies. Use only confirmed APIs, request optional services with `ctx.get`, keep live internal objects out of long-lived state/RPC, and register every side effect through the Cordis lifecycle so it has a disposer.

For Client UI, inspect the exact target Slot before registration. Use its returned registration protocol, props, and additive entry point; do not guess keys, props, DOM selectors, root Slots, or global browser objects.

## 4. Define, run, and verify

1. Summarize the minimal design and exact inspected contracts.
2. Define the package. For new work, `create_authorized` continues only in the Host-launched workspace-write child; the parent session must not call `cordis_define(kind:new)`. For a named Plugin, inspect its exact base package with `cordis_inspect_self`, preserve untouched halves, then use `plugin.kind: "existing"` with its original id.
3. Run the returned exact package id. Use `run` for first activation/restart and `update` only to move an existing Plugin to a different package.
4. If activation awaits approval or Client loading, report that state and wait for a later system update; do not claim success or poll in the same turn.
5. Claim only Host evidence. A Host tool-roundtrip pass is verified. Bundle activation means the bundle loaded, not that the capability was tested. Persistent manual-runtime completion awaits a user test in the target client or profile: invite that test once in natural language, then continue ordinary chat. Never treat a model judgment or semantic verifier as the success gate.

## 5. Repair, rollback, and cleanup

On a technical failure, inspect only the failed package and its exact diagnostics with `cordis_inspect_self`. Re-query only the capability implicated by that diagnostic, append a corrected package under the same Plugin, and run it with the appropriate mode. Existing update and repair work never needs `capability_workflow`.

If an update must be reversed, explicitly run the recorded `currentPackageId`; a failed update does not restore a physical run by itself. Use `cordis_stop` to pause a Plugin. Use `cordis_undefine` only when the user explicitly requests permanent removal and no rollback/inspection remains necessary.

Report the Plugin/package ids, activation state, verification evidence, and any approval or Client-runtime limitation. For a regression trace or skill evaluation, use [the trace expectations](references/eval-traces.md).
