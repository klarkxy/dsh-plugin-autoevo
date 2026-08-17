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
dsh plugin --profile web add --save-exact github:klarkxy/dsh-plugin-autoevo#v0.4.0
```

Restart the corresponding DSH process afterward. Bundles load at process start.

To upgrade, replace the tag and run the same command again, for example `#v0.4.0` to `#v0.4.1`.

DSH forwards `plugin` operations to pnpm. Semver, Git tags, and exact commits all pin a version, but DSH does not track or hot-load new releases. After pinning a tag or commit, upgrade explicitly and restart.

From this checkout:

```powershell
pnpm install
pnpm build
New-Item -ItemType Directory -Force C:\tmp\autoevo-pack
npm pack --pack-destination C:\tmp\autoevo-pack --ignore-scripts
dsh plugin --profile web add --save-exact "file:C:/tmp/autoevo-pack/dsh-plugin-autoevo-0.4.0.tgz"
```

The development install also uses an immutable `file:...tgz`. This avoids DSH rc.6 splitting a Windows `link:` argument whose path contains spaces. Third-party candidates likewise become owned `file:...tgz` packages.

## Capability Evolution mode

After install, AutoEvo adds the **Capability Evolution** user preset (id `evolution`) by default. It is based on Creator mode: the full Creator toolset, plus community-plugin reuse, review, install, and controlled dynamic Cordis creation. Config `evolutionPreset` defaults to `true`; `false` skips install/update and never deletes an existing preset.

The preset appears in DSH's user preset list as Custom, not as a built-in system mode. Restart the corresponding DSH process after first install or upgrade. AutoEvo upgrades only managed copies that have not been edited; user-edited files and a same-name foreign directory are left untouched.

To create a new dynamic Cordis plugin, start or switch a blank/new session to Capability Evolution. Official Creator remains for existing-plugin repair and static development. AutoEvo does not replace the shipped `cordis-plugin-development` skill globally.

Before uninstalling AutoEvo, remove Capability Evolution in DSH's Agent preset UI, then remove the plugin dependency and restart. Setting `evolutionPreset` to `false` alone does not delete the directory.

## How it works

- Agent-bound `cordis_define` with `plugin.kind = "new"` is allowed only in genuine Capability Evolution mode, and only after `capability_resolve`. Outside that mode the call is denied, with an instruction to switch to Capability Evolution.
- Inside the mode, AutoEvo pauses after discovery so the user can pick candidates, create new, or stop. Only selected repositories are reviewed. After review it pauses again for use this / create new / stop. `scratch_ready` means the user allowed one new plugin, not “start building”. Cancel is stop, never scratch. Technical failures may retry; success consumes the grant; a new resolution revokes an older one.
- `plugin.kind = "existing"`, ordinary file edits, commands, tests, and repairs to existing plugins remain unaffected. The guard does not treat generic development tools as plugin creation.
- Check tools the current Agent can see, model-invocable skills, and anything already reachable through a `tool_search` bridge.
- When local capability is insufficient, prefer an existing [`find_dsh_plugin`](https://github.com/awesome-dsh-plugin/dsh-find-plugin) in the current Agent scope. If that marketplace is missing, AutoEvo installs `dsh-find-plugin` by script after one-time approval and hot-loads it when the host allows. Restart only if hot-load fails. Do not review the marketplace as the requested capability, and do not search GitHub directly. An installed marketplace with no relevant hit means there is no reusable plugin.
- Review the exact commit: manifest, README, and the source that matters. Results are paths, derived facts, risk codes, and content hashes.
- Install when the review is `full + use`, risk is `low` or `medium`, the live DSH runtime is `compatible`, and the declared `dsh.bundle.patch` exists in the snapshot and parses as a Loader patch.
- Install and remove both require a one-time DSH `allowed-once` approval.
- Temporary trials run in an isolated DSH home. Verification needs a real `tool/call`, a matching successful `tool/result`, and a final answer closed by `turn/end: completed`; callers may also require exact expected text in that answer.
- `partial` candidates get a minimal patch, upstream tests, a local re-review to `full`, then an immutable tgz.
- After the current task is done, generic improvements can be suggested as a contribution. Fork, push, and PR still use `git` / `gh` after another explicit approval.

## Try it

After install and restart, tell the current Agent:

> I need a DSH plugin that can evaluate scientific notation. Look for an existing one first.

It should call `capability_resolve` first, explain what each candidate repo is for in chat, then call `capability_decide` after you reply. If `find_dsh_plugin` is not in the current scope, approve AutoEvo's marketplace script install. AutoEvo hot-loads it when possible; restart only if that fails.

## Agent tools

| Tool | Role | Surface |
|---|---|---|
| `capability_resolve` | Check local capabilities; prefer `find_dsh_plugin`; if the marketplace is missing, approve a script install. Returns a shortlist; does not pop a form | read-only / approval when installing marketplace |
| `capability_decide` | Record the user's chat choice (inspect / create new / use this / stop) | read-only |
| `plugin_review` | Review a user-selected GitHub exact commit or a local Git checkout after improve-this | read-only |
| `plugin_install` | Revalidate the review, request approval, install the reviewed package, verify a real task | approval |
| `plugin_remove` | Remove exactly one installation by receipt | approval |

AutoEvo adds these high-level tools and guards `cordis_define(kind:new)` at DSH's execution boundary; every other tool remains governed by the current Profile's Agent scope.

## Baseline

Maintenance line `0.4.0`. Verified on DSH `0.1.0-rc.6`, Cordis `4.0.1`, and Node.js `>=22.19.0 \|\| >=24`. Review receipts record the actual `dsh --version`; an unknown version does not authorize installation.

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
