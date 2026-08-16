# AutoEvo

English | [中文](README.md)

> Evolution continues.

<p align="center">
  <img src="docs/assets/kanban.png" alt="AutoEvo" width="420">
</p>

`dsh-plugin-autoevo` is a capability-reuse and safe-evolution plugin for DeepSeek Harness (DSH). When an Agent needs a new ability, it checks local tools and skills first, then searches, reviews, and deploys a community plugin — and improves a candidate when only a small gap remains. For dynamic Cordis plugins, AutoEvo enforces that order at the tool-execution boundary.

`Resolve → Search → Review → Deploy → Verify → Upgrade`

`Reuse before build. Improve before replace.`

## Install

```powershell
dsh plugin --profile web add --save-exact github:klarkxy/dsh-plugin-autoevo#v0.1.2
```

Restart the DSH process afterward. Bundles load at process start.

To upgrade to another published version, replace the tag explicitly and run the install command again. For example:

```powershell
dsh plugin --profile web add --save-exact github:klarkxy/dsh-plugin-autoevo#v0.1.2
```

DSH forwards `plugin` dependency operations to pnpm: registry semver, Git tags, and exact commits can all define a version boundary, but DSH neither follows new releases automatically nor hot-loads them. Explicitly change the pinned tag/commit and restart the corresponding process.

From this checkout:

```powershell
pnpm install
pnpm build
pnpm exec dsh plugin --profile web add --save-exact "link:<absolute-path-to-this-repo>"
```

`link:` is only for this trusted checkout. Third-party candidates are materialized as owned `file:...tgz` packages.

## Capability Evolution mode

After AutoEvo installs, it safely materializes the user agent preset **Capability Evolution** (id `evolution`, display name `能力进化`, description `先复用，再改进，最后才创建`) under `<dshHome>/.agent-presets/evolution` by default. Config `evolutionPreset` defaults to `true`. Setting it to `false` skips install/update and **never** auto-deletes an existing preset.

Because this directory lives in DSH's user preset root, the UI marks it **Custom** with `user` trust; it is not a built-in system mode. Restart the corresponding DSH process after first install or upgrade. AutoEvo upgrades only managed versions whose files and manifest exactly match a package-known historical release. User-edited files or manifests, an unexpected file set, and a foreign same-name directory are preserved with a warning and are never overwritten or deleted.

Start or switch a blank/new session to **能力进化** for the managed dynamic-creation path. The preset mounts `dsh-plugin-autoevo/evolution-mode`, registers the `autoevo-plugin-creator` skill, and publishes the `autoevoEvolutionMode` marker behind an isolate realm. AutoEvo accepts an Agent as genuine evolution mode only when `agentPresets.serviceFor(agent, "autoevoEvolutionMode")` returns that exact marker; the preset id alone is never authority.

Official **Creator** remains for existing-plugin repair and static development. AutoEvo does **not** globally replace the shipped `cordis-plugin-development` skill.

Before uninstalling AutoEvo, remove **能力进化** through DSH's Agent preset management UI, then remove the plugin dependency and restart. Setting `evolutionPreset` to `false` alone does not delete the existing directory.

## How it works

- Agent-bound `cordis_define` with `plugin.kind = "new"` is allowed only in genuine Capability Evolution mode, and only after `capability_resolve`. Outside that mode the call is denied with an actionable instruction to switch to 能力进化. Inside the mode, reusable local capability, a modifiable candidate, or unfinished candidate review still blocks creation. Only completed discovery and review with no viable candidate yields one successful `scratch_ready` grant. Technical failures may retry, success consumes it, and a new resolution revokes an older grant.
- `plugin.kind = "existing"`, ordinary file edits, commands, tests, and repairs to existing plugins remain unaffected. The guard does not guess that generic development tools are plugin creation.
- Check tools the current Agent can see, model-invocable skills, and anything already reachable through a `tool_search` bridge.
- When local capability is insufficient, prefer an existing [`find_dsh_plugin`](https://github.com/awesome-dsh-plugin/dsh-find-plugin) in the current Agent scope. Only when it is absent, fails, or yields no valid results does AutoEvo fall back to bounded GitHub search through authenticated `gh`. Both paths discover candidates from the `dsh-plugin` topic before Agent reranking.
- Review the exact commit: manifest, README, and the source that matters. Results are paths, derived facts, risk codes, and content hashes.
- Install when the review is `full + use`, risk is `low` or `medium`, compatibility with the actual DSH runtime is `compatible`, and the declared `dsh.bundle.patch` exists in the snapshot and parses as a Loader patch.
- Install and remove both require a one-time DSH `allowed-once` approval.
- Temporary trials run in an isolated DSH home. Verification needs a real `tool/call`, a matching successful `tool/result`, and a final answer closed by `turn/end: completed`; callers may also require exact expected text in that answer.
- `partial` candidates get a minimal patch, upstream tests, a local re-review to `full`, then an immutable tgz.
- After the current task is done, generic improvements can be suggested as a contribution. fork, push, and PR still use `git` / `gh` after another explicit approval.

## Try it

After install and restart, tell the current Agent:

> I need a DSH plugin that can evaluate scientific notation. Look for an existing one first.

It should call `capability_resolve` first. AutoEvo reuses `find_dsh_plugin` when that tool is installed and exposed to the current scope; otherwise GitHub search uses the `gh` login already on this machine.

## Agent tools

| Tool | Role | Surface |
|---|---|---|
| `capability_resolve` | Check local capabilities; prefer `find_dsh_plugin`, then fall back to built-in `gh` discovery | read-only |
| `plugin_review` | Review a GitHub exact commit or a local Git checkout | read-only |
| `plugin_install` | Revalidate the review, request approval, materialize the package, verify a real task | approval |
| `plugin_remove` | Remove exactly one installation by receipt | approval |

AutoEvo adds these four high-level tools and guards `cordis_define(kind:new)` at DSH's execution boundary; every other tool remains governed by the current Profile's Agent scope.

## Baseline

Maintenance line `0.1.2`. Verified on DSH `0.1.0-rc.6`, Cordis `4.0.1`, and Node.js `>=22.19.0 \|\| >=24`. Review receipts record the actual `dsh --version`; an unknown version does not authorize installation.

```powershell
node --version
pnpm --version
gh auth status
pnpm check         # full gate: static checks, unit tests, Loader, local/adversarial/full/partial E2E
pnpm check:release # full gate + pack dry-run; required before release
```

Design: [architecture](docs/architecture.md). Safety gates: [security](docs/security.md).

## License

SATA. See [LICENSE](./LICENSE).
