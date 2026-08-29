# Evaluation traces

Use these observable sequences when testing this skill's routing and lifecycle behavior.

| Scenario | Required trace | Forbidden trace |
| --- | --- | --- |
| Local reuse | `capability_workflow` → `reuse_local` of the scoped capability | `cordis_define`, `find_dsh_plugin`, parent-session construction |
| Scratch | `capability_workflow` → present shortlist in chat → user create-new → `capability_workflow_resume` → Host-owned cwd-bound managed child construction/checks (parent read-only) → Host commit, re-review, freeze → fresh install decision → Host verification | `cordis_define`, `find_dsh_plugin`, parent-session construction, construction before the user allows create-new, silently changing target, or popping `ask_user` instead of chatting |
| Existing update | `capability_workflow` with `evolve_existing` and `target_name` → Host-owned managed child modify → Host commit and re-review → fresh install decision | skip `capability_workflow`, `cordis_define`, parent-session construction |
| Client UI | `capability_workflow` → `create_authorized` → Host-owned managed child inspects the Slot contract and registers an additive contribution → real Client render/interaction | parent `cordis_define`, guessed Slot protocol, or Host-only proof |
| Repair | `capability_workflow` with `evolve_existing` (repair) → Host-owned managed child fix → Host commit and re-review; rollback via `capability_rollback` if needed | skip workflow, `cordis_define(kind:new)`, a new Plugin id, parent-session construction |
| Near miss | route to the owning non-plugin publication workflow | any AutoEvo or Cordis Plugin tool |

For every positive trace, report ids, mode, activation state, and the observable verification result. Treat approval pending, unavailable Client, or a failed tool/render as incomplete rather than successful.
