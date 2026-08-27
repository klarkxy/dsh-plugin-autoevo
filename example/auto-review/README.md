# Advisory LLM Auto Review example

The current DSH model reads the change summary, risks, and review rules. The example plugin only validates and records `approve`, `request_changes`, or `needs_human` with reasons, risks, applied rules, and confidence. Its output is `advisory_only`: it cannot approve DSH permissions or perform merge, installation, or publication.

This run searched and reviewed the closest candidate first, created only after a fresh user decision, passed 2 focused tests, obtained a one-time DSH installation approval, recovered one retryable Windows process-permission failure, and then installed successfully. After restart, a new client session called `record_llm_review` and observed a `needs_human` decision with `effect: advisory_only`. The pre-restart receipt remains distinct from the later client-call evidence.

The seven screenshots in this directory cover discovery, candidate review, creation authorization, final choice, installation authorization with the DSH approval card, the pre-restart installed state, and the post-restart tool result.
