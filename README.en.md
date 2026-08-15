# AutoEvo

English | [中文](README.md)

> Evolution continues.

<p align="center">
  <img src="docs/assets/kanban.png" alt="AutoEvo" width="420">
</p>

`dsh-plugin-autoevo` is a capability-reuse and safe-evolution plugin for DeepSeek Harness (DSH). When an Agent needs a new ability, it checks local tools and skills first, then searches, reviews, and deploys a community plugin — and improves a candidate when only a small gap remains.

`Resolve → Search → Review → Deploy → Verify → Upgrade`

`Reuse before build. Improve before replace.`

## Install

```powershell
dsh plugin --profile web add --save-exact github:klarkxy/dsh-plugin-autoevo#v0.1.1
```

Restart the DSH process afterward. Bundles load at process start.

To upgrade to another published version, replace the tag explicitly and run the install command again. For example:

```powershell
dsh plugin --profile web add --save-exact github:klarkxy/dsh-plugin-autoevo#v0.1.1
```

DSH forwards `plugin` dependency operations to pnpm: registry semver, Git tags, and exact commits can all define a version boundary, but DSH neither follows new releases automatically nor hot-loads them. Explicitly change the pinned tag/commit and restart the corresponding process.

From this checkout:

```powershell
pnpm install
pnpm build
pnpm exec dsh plugin --profile web add --save-exact "link:<absolute-path-to-this-repo>"
```

`link:` is only for this trusted checkout. Third-party candidates are materialized as owned `file:...tgz` packages.

## How it works

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

AutoEvo adds only these four high-level tools; every other tool remains governed by the current Profile's Agent scope.

## Baseline

Maintenance line `0.1.1`. Verified on DSH `0.1.0-rc.6`, Cordis `4.0.1`, and Node.js `>=22.19.0 \|\| >=24`. Review receipts record the actual `dsh --version`; an unknown version does not authorize installation.

```powershell
node --version
pnpm --version
gh auth status
pnpm check         # full gate: static checks, unit tests, Loader, local/full/partial E2E
pnpm check:release # full gate + pack dry-run; required before release
```

Design: [architecture](docs/architecture.md). Safety gates: [security](docs/security.md).

## License

SATA. See [LICENSE](./LICENSE).
