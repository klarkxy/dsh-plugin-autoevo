# AutoEvo authorization state

`capability_workflow` is required only before a new `cordis_define` whose `plugin.kind` is `"new"`. Give it the concrete user capability, not an implementation proposal.

| Result | Meaning | Safe next step |
| --- | --- | --- |
| `reuse_local` | The user chose a scoped local tool or skill. | Reuse it; do not define a Cordis Plugin unless they later choose create new. |
| `selection_required` | Discovery finished or is waiting. No action grant yet. | Present each candidate in chat. Do not call `ask_user`. After the user replies, call `capability_workflow_resume`. Inspect exactly one selected repository at a time. |
| `confirmation_required` | A selected candidate was reviewed. | Explain fit, risk, and findings in chat. Do not call `ask_user`. After the user replies, call `capability_workflow_resume`. |
| `use_review` | The user chose this exact review. | The workflow installs that review; do not create a replacement. Reinstall or patch again on the same workflow. |
| `modify_review` | The user chose to improve this review. | Modify minimally, then resume with the local checkout path. The workflow derives `base_review_id`. |
| `market_required` | `find_dsh_plugin` is not installed. AutoEvo installs `dsh-find-plugin` by script after one-time approval. | Approve if asked, restart DSH, then call `capability_workflow` again. Do not review the marketplace as the requested capability and do not create a replacement plugin. |
| `stopped` | The user stopped or cancelled. | Do not install or create. |
| `scratch_ready` | The user explicitly allowed one new plugin. | Inspect Cordis contracts and make one new definition only if that is still what they want. |

The grant belongs to the current Agent and current resolution. Starting another workflow revokes it. A successful new definition consumes it; a technical define failure restores it for retry. Do not retry after an approval rejection without a new user decision.

`cordis_define` with `plugin.kind: "existing"`, ordinary coding, tests, and repair calls are outside this creation gate.
