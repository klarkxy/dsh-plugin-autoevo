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
dsh plugin --profile web add --save-exact github:klarkxy/dsh-plugin-autoevo#v0.5.1
```

Restart the corresponding DSH process afterward. Bundles load at process start.

To upgrade, replace the tag and run the same command again, for example `#v0.5.0` to `#v0.5.1`.

DSH forwards `plugin` operations to pnpm. Semver, Git tags, and exact commits all pin a version, but DSH does not track or hot-load new releases. After pinning a tag or commit, upgrade explicitly and restart.

From this checkout:

```powershell
pnpm install
pnpm build
New-Item -ItemType Directory -Force C:\tmp\autoevo-pack
npm pack --pack-destination C:\tmp\autoevo-pack --ignore-scripts
dsh plugin --profile web add --save-exact "file:C:/tmp/autoevo-pack/dsh-plugin-autoevo-0.5.1.tgz"
```

The development install also uses an immutable `file:...tgz`. This avoids DSH rc.6 splitting a Windows `link:` argument whose path contains spaces. Third-party candidates likewise become owned `file:...tgz` packages.

## Capability Evolution mode

After install, AutoEvo adds the **Capability Evolution** user preset (id `evolution`, template V9) by default. It is based on Creator mode: the full Creator toolset, plus community-plugin reuse, review, install, upgrade of existing capabilities, and controlled dynamic Cordis creation; an improved plugin can be contributed upstream after explicit approval. Config `evolutionPreset` defaults to `true`; `false` skips install/update and never deletes an existing preset. Policy V5 unfinished older-policy workflows are not resumable; call `capability_workflow` again to start a fresh V5 discovery.

> [!WARNING]
> **Do not run Capability Evolution with a low-intelligence model or a model that is unreliable at tool calling.** The active LLM semantically interprets the user's final install, modify, create, or stop choice and submits a structured `decision`. The Host still validates the fresh authentic user turn, interrupt-bound action/candidate, review, session, boot, and replay boundaries, but it no longer re-parses keywords to redo the model's language understanding. A weak model can choose the wrong legal action or candidate. Use a model with reliable instruction following, context retention, and structured tool use.

The preset appears in DSH's user preset list as Custom, not as a built-in system mode. Restart the corresponding DSH process after first install or upgrade. AutoEvo upgrades only managed copies that have not been edited; user-edited files and a same-name foreign directory are left untouched.

To create a new dynamic Cordis plugin, start or switch a blank/new session to Capability Evolution. Official Creator remains for existing-plugin repair and static development. AutoEvo does not replace the shipped `cordis-plugin-development` skill globally.

Before uninstalling AutoEvo, remove Capability Evolution in DSH's Agent preset UI, then remove the plugin dependency and restart. Setting `evolutionPreset` to `false` alone does not delete the directory.

## How it works

- The parent session execution guard denies filesystem write/edit, shell, Cordis mutation/definition, agent/subagent/workflow delegation, and direct DSH plugin install/remove. Modify/create continues only in a Host-launched `workspace-write` child bound to a managed git source under `sourceDir` (default `<stateDir>/sources`). On Windows, sandbox enforcement is integrity-oriented partial isolation.
- Inside the mode, AutoEvo pauses after discovery so the real user can pick candidates, create new, or stop. The LLM maps read-only choices to candidate IDs from the current interrupt snapshot in `navigation`. After review it pauses again; simple UI primary actions are `use_this` / `search_more`, with `modify_this` / `create_new` / `stop` in advanced/recovery. The LLM maps the fresh reply to a structured final `decision`, while the Host validates that interpretation against the authentic turn, mints the commitment/lease, and checks the current workflow boundary. A DSH approval is not that decision. MechanicalFacts are display/routing only; an explicit OR starts a clean semantic reviewer. Install outcomes are `pending | verified | failed_absent | recovery_required`.
- Security findings are static review facts, not purpose claims. Matching source/build observations are grouped for presentation; the Agent must not infer malicious intent, OAuth necessity, callback-server behavior, or any other unverified semantics from `process_execution`. Block findings remain high risk and non-installable.
- Cancelling the parent task immediately disposes the managed child Agent. Bounded edits are checkpointed under an independent cleanup lifetime, the workflow parks at `recovery_required`, and source locks are released; cancellation is never reported as a missing executable.
- `plugin.kind = "existing"`, ordinary file edits, commands, tests, and repairs to existing plugins remain unaffected. The guard does not treat generic development tools as plugin creation.
- Check tools the current Agent can see, model-invocable skills, and anything already reachable through a `tool_search` bridge.
- When local capability is insufficient, prefer an existing [`find_dsh_plugin`](https://github.com/awesome-dsh-plugin/dsh-find-plugin) in the current Agent scope. If that marketplace is missing, AutoEvo installs `dsh-find-plugin` by script after one-time approval and hot-loads it when the host allows. Restart only if hot-load fails. Do not review the marketplace as the requested capability, and do not search GitHub directly. An installed marketplace with no relevant hit means there is no reusable plugin.
- Review the exact commit: manifest, README, and the source that matters. Results are paths, derived facts, risk codes, and content hashes.
- Install when the review is `full + use`, risk is `low` or `medium`, the live DSH runtime is `compatible`, and the declared `dsh.bundle.patch` exists in the snapshot and parses as a Loader patch.
- Install and remove both require a one-time DSH `allowed-once` approval.
- Temporary trials run in an isolated DSH home. Final `verified` needs Host mechanical Loader evidence (a real `tool/call`, a matching successful `tool/result`, and a `turn/end: completed` final answer) plus an independent semantic verifier. `taskResultMatchedExpectation` is diagnostic only and does not gate success.
- `partial` candidates get a minimal patch, upstream tests, a local re-review to `full`, then an immutable tgz.
- Dissatisfaction with an installed community plugin goes through the same gates: the installation receipt's `reviewId` points at the upstream repository and exact commit; after the user selects that origin, review → improve-this → local re-review → pinned tgz reinstall, then remove the old installation by its receipt. Plugins created under `create_authorized` or static local plugins are upgraded as ordinary repair work.
- After the current task is done, generic improvements can be suggested as a contribution. The installation receipt's `contributionAdvice` records eligibility; fork, push, and PR still use `git` / `gh` after another explicit approval.

## Try it

After install and restart, tell the current Agent:

> I need a DSH plugin that can evaluate scientific notation. Look for an existing one first.

It should call `capability_workflow` first, explain the numbered candidates briefly, and map your read-only selection to candidate IDs from the current snapshot in `navigation`. For final install, modify, or create confirmation, the LLM submits a structured `decision` and the Host binds it to the fresh authentic turn. If `find_dsh_plugin` is not in the current scope, approve AutoEvo's marketplace script install. AutoEvo hot-loads it when possible; restart only if that fails.

## Agent tools

| Tool | Role | Surface |
|---|---|---|
| `capability_workflow` | Start the fixed workflow: check local capabilities, prefer `find_dsh_plugin`, and approve a script install if the marketplace is missing. Returns an interrupt with structured options | read-only / approval when installing marketplace |
| `capability_workflow_resume` | Use `navigation` for read-only selection/review; use an LLM-interpreted structured `decision` for final confirmation, bounded by the Host to the authentic turn and current interrupt action/candidate | read-only for review; approval for install |
| `plugin_remove` | Remove exactly one installation by receipt | approval |

AutoEvo adds these high-level tools and guards `cordis_define(kind:new)` at DSH's execution boundary; every other tool remains governed by the current Profile's Agent scope.

## Baseline

Maintenance line `0.5.1`. Verified on DSH `0.1.0-rc.6`, Cordis `4.0.1`, and Node.js `>=22.19.0 \|\| >=24`. Review receipts record the actual `dsh --version`; an unknown version does not authorize installation.

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
