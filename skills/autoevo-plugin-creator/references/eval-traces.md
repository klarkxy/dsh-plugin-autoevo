# Evaluation traces

Use these observable sequences when testing this skill's routing and lifecycle behavior.

| Scenario | Required trace | Forbidden trace |
| --- | --- | --- |
| Local reuse | `capability_workflow` -> reuse local capability | `cordis_define(kind:new)` |
| Scratch | `capability_workflow` -> present shortlist in chat -> user create-new -> `capability_workflow_resume` -> `scratch_ready` -> exact inspect -> one new define -> run -> verify | define before the user allows create-new, or popping `ask_user` instead of chatting |
| Existing update | exact self-inspect -> define `existing` -> update/run -> verify | `capability_workflow` |
| Client UI | exact Slot inspect -> Client definition -> activation -> real render/interaction | guessed Slot protocol or Host-only proof |
| Repair | inspect failed package/diagnostic -> exact re-inspect -> corrected package -> activate -> verify | unrelated resolution or a new Plugin id |
| Near miss | route to the owning non-plugin workflow | any AutoEvo or Cordis Plugin tool |

For every positive trace, report ids, mode, activation state, and the observable verification result. Treat approval pending, unavailable Client, or a failed tool/render as incomplete rather than successful.
