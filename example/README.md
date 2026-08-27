# AutoEvo workflow examples

These galleries are fresh runs captured from the `1.0.0` release. AutoEvo organizes Search-first discovery, review, user decisions, installation receipts, and managed construction; DSH and the active LLM perform normal tool work. Both runs continue through one-time DSH approval, installation, restart, and a real client tool call.

## Offline calendar conversion after a genuine no-match

1. `create/01-request-and-search.png` — submit an offline bidirectional conversion requirement and start discovery.
2. `create/02-no-candidate-create-choice.png` — reach a completed empty snapshot and choose whether to continue, create, or stop.
3. `create/03-create-authorized.png` — make a fresh decision to create and bind managed construction without installing.
4. `create/04-review-install-choice.png` — after focused tests pass, review the current frozen source and choose the final action.
5. `create/05-install-authorized.png` — make the fresh final install decision for the reviewed frozen source.
6. `create/06-approval.png` — DSH presents the exact package, profile, risk, compatibility, and lifecycle facts before the one-time side-effect approval.
7. `create/07-installed-result.png` — record the honest pre-restart outcome: installed, not yet loaded, not yet activated or verified, and awaiting user testing.
8. `create/08-tool-roundtrip.png` — after restart, perform a real Gregorian → lunar → Gregorian tool round trip and observe the original date again.

## Advisory LLM Auto Review

1. `auto-review/01-search-shortlist.png` — inspect a Search-first shortlist rather than jumping directly to implementation.
2. `auto-review/02-candidate-review.png` — read the closest candidate's factual gaps and uncertainty.
3. `auto-review/03-create-authorized.png` — authorize a lightweight managed implementation: the current DSH model reviews, while the plugin validates and records a tri-state advisory result.
4. `auto-review/04-review-install-choice.png` — see the passing focused tests and Host review, then stop at the final install decision.
5. `auto-review/05-install-authorized.png` — explicitly select the reviewed advisory-only capability, then approve only the named package installation into the named profile.
6. `auto-review/06-installed-result.png` — distinguish installed from loaded and verified before restart.
7. `auto-review/07-tool-roundtrip.png` — after restart, call `record_llm_review` and observe `needs_human`, `needsHuman: true`, and `effect: advisory_only` from the real tool result.

The Auto Review result is advisory only: it cannot merge, publish, install, or bypass DSH approval. The example run's first install attempt hit a retryable Windows process-permission failure; AutoEvo kept that failure explicit, recovered the provisional installation, and only reported success after the later Host-observed retry completed. These example requirements and names are documentation inputs, not runtime defaults, search exceptions, copied test fixtures, or compatibility guarantees.
