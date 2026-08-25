# AutoEvo authorization state

`capability_workflow` is required for every requested capability reuse, repair, upgrade, modification, creation, or experiment in the `evolution` preset. Temporary wording never bypasses Search-first. Give the tool only a model-generated search summary; Host persists the latest top-level user wording as the authoritative original requirement.

| Result | Meaning | Safe next step |
| --- | --- | --- |
| `waiting_clarification` | One material ambiguity blocks useful search. No search or action grant exists yet. | Present the single Host-sealed question and stop. A fresh top-level answer may resume only with `clarify_requirement`; it changes read-only search classification and grants no selection, creation, modification, installation, or execution authority. |
| `discovering` | Host returned a verified candidate pool without a user gate. | Refine within the returned rounds/query/candidate budget or seal 1–5 pool IDs with `capability_workflow_present`. Do not invent candidates. |
| `no_candidates` | Host completed read-only search and found no sealed candidate. | Offer only continued search, creating a new capability, or stopping. Creation still requires a fresh top-level final decision. |
| `reuse_local` | The user chose a scoped local tool or skill. | Reuse it; do not define a Cordis Plugin unless they later choose create new. |
| `selection_required` | Discovery finished or is waiting. No action grant yet. | Present each candidate in chat. Do not pop `ask_user` to pick a candidate. Same-turn resume is a no-op park. After the user replies, call `capability_workflow_resume`. Inspect exactly one selected repository at a time. |
| `confirmation_required` | A selected candidate was reviewed. | Explain fit, risk, and findings in chat. Do not pop `ask_user` to pick an action. After the user replies, call `capability_workflow_resume`. |
| `use_review` | The user chose this exact review. | The workflow installs that review; do not create a replacement. Host completion may be `verified`, `activated`, or `awaiting_user_test`. |
| `modify_review` | The user chose to improve this review. | Wait for the Host-managed source and WorkOrder, edit only inside that source, run the required checks, then resume with `finish_managed_work`. The workflow derives `base_review_id`. At most two Host-bounded modify attempts. |
| `market_required` | Older receipt parked on marketplace setup. | Call `capability_workflow` again so Host-owned GitHub topic search can run. Do not review the old marketplace plugin as the requested capability and do not create a replacement plugin. |
| `stopped` | The user stopped or cancelled. | Do not install or create. |
| `superseded` | A new top-level requirement replaced a workflow that was waiting for clarification. | Treat the old interrupt and every old grant as non-executable; continue only with the new workflow. |
| `create_authorized` | The user explicitly allowed one new plugin. | Continue only in the current session's Host-managed source and follow the returned work order. Do not `cordis_define(kind:new)` or delegate construction. |
| completed `verified` | Host `tool_roundtrip` passed. | This is the only functionally verified install. Ordinary chat may continue. Do not re-verify the same review, source, layer, and fixture. |
| completed `activated` | Host `bundle_activation` passed. | The bundle loaded; do not claim the capability was tested. Ordinary chat may continue. |
| completed `awaiting_user_test` | Host `manual_runtime` persistent. | Invite a real-client or profile test once in natural language, then continue ordinary chat. Do not nag later. Temporary `manual_runtime` is rejected before install. |
| `recovery_required` | Sealed failure interrupt. | After a fresh user confirmation, call `capability_workflow_recover` with the current `interrupt_id`. This is not completed-install cleanup. |

The grant belongs to the current Agent and current resolution. Starting another workflow revokes it. Managed construction remains bound to the current work order and source receipt. Do not retry after an approval rejection without a new user decision.

Policy-mismatched unfinished state is not executable; start a fresh Policy V10 workflow from the current top-level user wording. Completed installations and historical temporary receipts remain readable and explicitly removable. Mechanical verification is Host-driven: do not assign it to an ordinary model, do not judge success yourself, and do not treat a semantic verifier as the completion gate.

`capability_workflow_diagnose` is read-only and available only after an incomplete or failed stage. It returns redacted facts under a per-failure budget; it never retries, installs, edits, or cleans up. Repeated identical invalid resumes are blocked for the remainder of the current user turn without consuming authorization. After repeated verification or modify failure, present a human decision or diagnosis exit instead of looping.

`capability_workflow_recover` has two legal modes that must not be mixed: sealed failure recovery requires the current `interrupt_id`; completed-install cleanup/restart is driven by a new top-level explicit user request and omits `interrupt_id`. Eligible completed cursors are `installed`, `restart_required`, `activated`, and `awaiting_user_test`.

In the `evolution` parent session, every Cordis live mutation (`define`, `run`, `mount`, `undefine`, `unmount`), direct or nested plugin search, plugin mutation, Creator-skill load, ordinary model delegation, and unmanaged construction path is outside model authority. Known-source repair enters `evolve_existing`; after a valid Gate-2 decision, official Creator skills may edit only inside the single Host-managed source root. Model-callable shell stays denied because the parent sandbox is not rebound to the narrower root; Host performs bounded builds and tests after source handoff. Cordis inspect and safe `cordis_stop` remain available to the parent.
