# AutoEvo authorization state

`capability_resolve` is required only before a new `cordis_define` whose `plugin.kind` is `"new"`. Give it the concrete user capability, not an implementation proposal.

| Result | Meaning | Safe next step |
| --- | --- | --- |
| `reuse_required` | A scoped local tool or skill can meet the need. | Reuse it; do not define a Cordis Plugin. |
| `review_required` | Discovery found a candidate, or discovery/review is incomplete. | Call `plugin_review` for each candidate; wait for its authorization. |
| `modify_required` | A reviewed candidate is partial but is the preferred base. | Modify that candidate minimally, then review the local checkout against its base review. |
| `market_required` | `find_dsh_plugin` is not installed. AutoEvo installs `dsh-find-plugin` by script after one-time approval. | Approve if asked, restart DSH, then call `capability_resolve` again. Do not review the marketplace as the requested capability and do not create a replacement plugin. |
| `scratch_ready` | Complete discovery/review found no reusable or modifiable capability. | If you found a GitHub DSH plugin yourself, `plugin_review` that `owner/repo` first. Only then inspect Cordis contracts and make one new definition. |

The grant belongs to the current Agent and current resolution. Starting another resolve revokes it. A successful new definition consumes it; a technical define failure restores it for retry. Do not retry after an approval rejection without a new user decision.

`cordis_define` with `plugin.kind: "existing"`, ordinary coding, tests, and repair calls are outside this creation gate.
