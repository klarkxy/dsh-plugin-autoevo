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
dsh plugin --profile web add github:klarkxy/dsh-plugin-autoevo
```

Restart the DSH process afterward. Bundles load at process start.

From this checkout:

```powershell
pnpm install
pnpm build
pnpm exec dsh plugin --profile web add --save-exact "link:<absolute-path-to-this-repo>"
```

`link:` is only for this trusted checkout. Third-party candidates are materialized as owned `file:...tgz` packages.

## How it works

- Check tools the current Agent can see, model-invocable skills, and anything already reachable through a `tool_search` bridge.
- When local capability is insufficient, search GitHub through an authenticated `gh` CLI, then let the Agent rerank. Discovery starts at the `dsh-plugin` topic.
- Review the exact commit: manifest, README, and the source that matters. Results are paths, derived facts, risk codes, and content hashes.
- Install when the review is `full + use`, risk is `low` or `medium`, compatibility is `compatible` or `unknown`, and the manifest declares `dsh.bundle.patch`.
- Install and remove both require a one-time DSH `allowed-once` approval.
- Temporary trials run in an isolated DSH home. Verification needs a real `tool/call`, a matching successful `tool/result`, and a task result.
- `partial` candidates get a minimal patch, upstream tests, a local re-review to `full`, then an immutable tgz.
- After the current task is done, generic improvements can be suggested as a contribution. fork, push, and PR still use `git` / `gh` after another explicit approval.

## Try it

```powershell
npx @deepseek-ai/dsh@0.1.0-rc.6 web
```

Open http://127.0.0.1:3080 and add an API key in Settings. In another terminal, install AutoEvo, restart Web, then tell the Agent:

> I need a DSH plugin that can evaluate scientific notation. Look for an existing one first.

It should call `capability_resolve` first. GitHub search uses the `gh` login already on this machine.

## Agent tools

| Tool | Role | Surface |
|---|---|---|
| `capability_resolve` | Check local capabilities; search GitHub summaries when needed | read-only |
| `plugin_review` | Review a GitHub exact commit or a local Git checkout | read-only |
| `plugin_install` | Revalidate the review, request approval, materialize the package, verify a real task | approval |
| `plugin_remove` | Remove exactly one installation by receipt | approval |

The model only sees these four tools.

## Baseline

Maintenance line `0.1.0`. Verified on DSH `0.1.0-rc.6`, Cordis `4.0.1`, and Node.js `>=22.19.0 \|\| >=24`.

```powershell
node --version
pnpm --version
gh auth status
pnpm check
```

Design: [architecture](docs/architecture.md). Safety gates: [security](docs/security.md).

## License

SATA. See [LICENSE](./LICENSE).
