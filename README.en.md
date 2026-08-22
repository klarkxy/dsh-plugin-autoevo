# AutoEvo

English | [Chinese](README.md)

> Evolution continues.

<p align="center">
  <img src="docs/assets/kanban.png" alt="AutoEvo" width="420">
</p>

`dsh-plugin-autoevo` is a capability-reuse and safe-evolution plugin for DeepSeek Harness (DSH). When an Agent needs a new ability, it checks local tools and skills first, then searches, reviews, and deploys a community plugin. If a candidate falls just short, AutoEvo improves it in place. For dynamic Cordis plugins, that order is enforced at the tool-execution boundary.

`Resolve → Search → Review → Deploy → Verify → Upgrade`

`Reuse before build. Improve before replace.`

## Install

```powershell
dsh plugin --profile web add --save-exact github:klarkxy/dsh-plugin-autoevo#v0.5.3
```

Restart the corresponding DSH process afterward. Bundles load at process start.

To upgrade, replace the tag and run the same command again, for example `#v0.5.2` to `#v0.5.3`.

DSH forwards `plugin` operations to pnpm. Semver, Git tags, and exact commits all pin a version, but DSH does not track or hot-load new releases. After pinning a tag or commit, upgrade explicitly and restart.

From this checkout:

```powershell
pnpm install
pnpm build
New-Item -ItemType Directory -Force C:\tmp\autoevo-pack
npm pack --pack-destination C:\tmp\autoevo-pack --ignore-scripts
dsh plugin --profile web add --save-exact "file:C:/tmp/autoevo-pack/dsh-plugin-autoevo-0.5.3.tgz"
```

The development install also uses an immutable `file:...tgz`. This avoids DSH rc.6 splitting a Windows `link:` argument whose path contains spaces. Third-party candidates likewise become owned `file:...tgz` packages.

## Capability Evolution mode

After install, AutoEvo creates the **Capability Evolution** user preset (id `evolution`, template V12) from scratch. Official Creator constructs; AutoEvo governs. Capability Evolution does not inherit Creator mode. AutoEvo owns community-plugin reuse, review, install, and upgrade; create, modify, and correction construction run in a Host-launched official `cordis` Creator child and never fall back to `code`. An improved plugin can be contributed upstream after explicit approval. There is no legacy-user migration path: the package trusts only the exact current V12 content and preserves every other existing or edited preset instead of overwriting it. Config `evolutionPreset` defaults to `true`; `false` skips installation and never deletes an existing preset. Runtime policy is Policy V8. A completed installation can be cleaned up and restarted only after a new top-level user request, using that workflow's owned receipt. Failed `recovery_required` still uses the sealed interrupt protocol; the two paths must not be mixed.

> [!WARNING]
> **Do not run Capability Evolution with a low-intelligence model or a model that is unreliable at tool calling.** The active LLM semantically interprets the user's final install, modify, create, or stop choice and submits a structured `decision`. The Host still validates the fresh authentic user turn, interrupt-bound action/candidate, review, session, boot, and replay boundaries, but it no longer re-parses keywords to redo the model's language understanding. A weak model can choose the wrong legal action or candidate. Use a model with reliable instruction following, context retention, and structured tool use.

The preset appears in DSH's user preset list as Custom, not as a built-in system mode. Restart the corresponding DSH process after first install or upgrade. AutoEvo upgrades only managed copies that have not been edited; user-edited files and a same-name foreign directory are left untouched.

To create a new dynamic Cordis plugin, start or switch a blank/new session to Capability Evolution. Official Creator remains for existing-plugin repair and static development, and is the only preset Host mounts for managed construction. AutoEvo governs discovery, review, authorization, and install. AutoEvo does not replace the shipped `cordis-plugin-development` skill globally.

Before uninstalling AutoEvo, remove Capability Evolution in DSH's Agent preset UI, then remove the plugin dependency and restart. Setting `evolutionPreset` to `false` alone does not delete the directory.

## How it works

- The parent session governs discovery, review, authorization, and install. The execution guard only denies `cordis_define(kind:new)` and unreviewed direct plugin install/remove. Community-plugin create, modify, and correction are constructed in a Host-launched official Creator (`cordis`) `workspace-write` child bound to a managed git source under `sourceDir` (default `<stateDir>/sources`). The child always mounts `cordis`, never `code`, and never falls back. A side-effect-free Creator preflight runs before clone, scaffold, initialize, or write. On Windows, sandbox enforcement is integrity-oriented partial isolation.
- The Host owns facts, budgets, persistence, and side-effect authorization. `capability_workflow` returns up to 20 Host-verified candidates. Within two refinement rounds and five supplemental queries, the model may call `capability_workflow_refine`, then autonomously seals a final 1–5 item shortlist with `capability_workflow_present`. Only a fresh real user reply can select sealed candidates for review; a second fresh decision is still required before install, modify, or create. A DSH approval is separate and cannot replace that decision.
- The model owns ranking, comparison, recommendation, natural language, and mapping replies such as “your pick”, “the other one”, or “look at 3” to scoped candidate IDs. Review results expose bounded source, exact commit, fit, confidence, compatibility, license, maintenance, missing-capability, risk, semantic-verdict, and eligibility facts instead of a prescribed reply template.
- Security findings are static review facts, not purpose claims. Matching source/build observations are grouped for presentation; the Agent must not infer malicious intent, OAuth necessity, callback-server behavior, or any other unverified semantics from `process_execution`. Block findings remain high risk and non-installable.
- Cancelling the parent task immediately disposes the managed child Agent. Bounded edits are checkpointed under an independent cleanup lifetime, the workflow parks at `recovery_required`, and source locks are released; cancellation is never reported as a missing executable.
- After search, review, managed-work, install, or verification failure, `capability_workflow_diagnose` exposes only bounded redacted facts. Each failure episode allows at most two diagnostic calls and eight probes; diagnosis never retries or mutates state. After repeated verification or modify failure, present a human decision or diagnosis exit instead of looping the same attempt.
- `plugin.kind = "existing"`, ordinary file edits, commands, tests, and repairs to existing plugins remain unaffected. The guard does not treat generic development tools as plugin creation.
- Check tools the current Agent can see, model-invocable skills, and anything already reachable through a `tool_search` bridge.
- When local capability is insufficient, prefer an existing [`find_dsh_plugin`](https://github.com/awesome-dsh-plugin/dsh-find-plugin) in the current Agent scope. If that marketplace is missing, AutoEvo installs `dsh-find-plugin` by script after one-time approval and hot-loads it when the host allows. Restart only if hot-load fails. Do not review the marketplace as the requested capability, and do not search GitHub directly. An installed marketplace with no relevant hit means there is no reusable plugin.
- Review the exact commit: manifest, README, and the source that matters. Results are paths, derived facts, risk codes, and content hashes.
- Install when the review is `full + use`, risk is `low` or `medium`, the live DSH runtime is `compatible`, and the declared `dsh.bundle.patch` exists in the snapshot and parses as a Loader patch.
- Install and remove both require a one-time DSH `allowed-once` approval.
- Mechanical verification is Host-driven. Do not hand verification to an ordinary model, do not let the model judge success, and do not treat an independent semantic verifier as the trusted completion gate. Compatibility semantic components may still exist; packaged behavior follows the Host three-layer result.
- The three layers are distinct: `tool_roundtrip` passed is `verified`; `bundle_activation` passed is `activated`; persistent `manual_runtime` is `awaiting_user_test`. All three complete the workflow and do not block ordinary chat, but the last two must not be described as functionally verified. Third-party tool packages usually have no Host attestation and therefore enter `manual_runtime` / persistent; package-manifest `safe`/`risk` or candidate self-reports cannot mint `tool_roundtrip`. Temporary `manual_runtime` is rejected before install and before side-effect approval.
- After `awaiting_user_test`, invite the user to try the capability in the target client or profile. Do not use a fixed script, and do not re-ask during later casual chat.
- The same review / source / layer / fixture cannot be installed or verified again; modify is capped at two attempts. When the user explicitly asks to clean up and start over, completed `installed` / `restart_required` / `activated` / `awaiting_user_test` use post-install cleanup/restart. Failed `recovery_required` keeps the sealed interrupt protocol. `taskResultMatchedExpectation` is diagnostic only and does not gate success.
- `partial` candidates get a minimal patch, upstream tests, a local re-review to `full`, then an immutable tgz.
- Dissatisfaction with an installed community plugin goes through the same gates: the installation receipt's `reviewId` points at the upstream repository and exact commit; after the user selects that origin, review → improve-this → local re-review → pinned tgz reinstall, then remove the old installation by its receipt. Plugins created under `create_authorized` or static local plugins are upgraded as ordinary repair work.
- After the current task is done, generic improvements can be suggested as a contribution. The installation receipt's `contributionAdvice` records eligibility; fork, push, and PR still use `git` / `gh` after another explicit approval.

## Try it

After install and restart, tell the current Agent:

> I need a DSH plugin that can evaluate scientific notation. Look for an existing one first.

It should call `capability_workflow`, autonomously refine the real discovery pool if useful, and call `capability_workflow_present` with a 1–5 item shortlist. After you pick one, the Host reviews it and stops again so you can decide whether to install. Same-turn resume is a no-op, not an error. A clear choice in ordinary language is enough; examples such as “use this” (install) or “look at the second one” (review another) are illustrations, not required passphrases. For install, modify, or create, the LLM interprets that explicit selection into a structured `decision` and the Host binds it to the fresh authentic turn. If `find_dsh_plugin` is not in the current scope, approve AutoEvo's marketplace script install. AutoEvo hot-loads it when possible; restart only if that fails.

## Agent tools

| Tool | Role | Surface |
|---|---|---|
| `capability_workflow` | Preserve the original requirement and return a bounded Host-verified discovery pool, evidence, and budgets | read-only / approval when installing marketplace |
| `capability_workflow_refine` | Add bounded query hints or strict GitHub repository identities to the open discovery pool | read-only |
| `capability_workflow_present` | Seal 1–5 pool candidates into the final shortlist and open Gate 1 | read-only |
| `capability_workflow_resume` | Use `navigation` for read-only selection/review; use an LLM-interpreted structured `decision` for final confirmation, bounded by the Host to the authentic turn and current interrupt action/candidate | read-only for review; approval for install |
| `capability_workflow_diagnose` | Read bounded redacted discovery, review, child, install, verification, and cleanup facts after failure | read-only |
| `capability_workflow_recover` | Two distinct paths: sealed failure recovery requires the current `interrupt_id`; completed-install cleanup/restart is driven by a new top-level explicit user request and omits `interrupt_id` | authentic confirmation / one-time cleanup approval |
| `plugin_remove` | Remove exactly one installation by receipt | approval |

AutoEvo adds these high-level tools and guards `cordis_define(kind:new)` at DSH's execution boundary; every other parent-session tool remains governed by the current Profile's Agent scope. Official Creator constructs; AutoEvo governs. The legacy `autoevo-plugin-creator` skill remains present but unused. Managed children may load only `cordis-plugin-development` and `editing-cordis-compositions`, plus `cordis_inspect_list` / `query` / `self`. Agent-visible Creator facts are only `verified` or `unavailable`.

## Baseline

Maintenance line `0.5.3`. Verified on DSH `0.1.0-rc.6`, Cordis `4.0.1`, and Node.js `>=22.19.0 \|\| >=24`. Review receipts record the actual `dsh --version`; an unknown version does not authorize installation.

```powershell
node --version
pnpm --version
gh auth status
pnpm check         # daily gate: static checks, unit tests, Loader, local/adversarial E2E
pnpm check:release # daily gate + marketplace/full/partial live E2E + pack dry-run; required before release
```

Design: [architecture](docs/architecture.md). Safety gates: [security](docs/security.md).

## License

SATA. See [LICENSE](./LICENSE).
