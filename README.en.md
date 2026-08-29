# AutoEvo

English | [中文](README.md)

> Evolution continues.

<p align="center">
  <img src="docs/assets/kanban.png" alt="AutoEvo" width="420">
</p>

`dsh-plugin-autoevo` is a capability-reuse workflow plugin for DeepSeek Harness (DSH). In the **Capability Evolution** preset, every capability request goes Search-first: check local and remote candidates first, and reuse wins over building; when a candidate is almost right, improve it in a managed source, re-review, and then install. Every adopted capability carries an inspectable outcome receipt.

`Resolve → Search → Review → Deploy → Verify → Upgrade`

`Reuse before build. Improve before replace.`

## Documentation

| Topic | Entry point |
| --- | --- |
| Install, first run, two confirmation gates, outcomes, recovery | [User Guide](docs/user-guide.en.md) |
| Local setup, source entry points, tests, debugging, contribution | [Developer Guide](docs/developer-guide.en.md) |
| State machine, data layout, runtime seams | [Architecture](docs/architecture.md) (Chinese) |
| Trust boundaries, install gates, verification evidence | [Security Model](docs/security.md) (Chinese) |

Each topic has one canonical home. Interactive flow diagrams (standalone HTML with pan/zoom, search, and export): [main workflow](docs/assets/flowcharts/autoevo-main-workflow-en.html) · [install outcome state machine](docs/assets/flowcharts/autoevo-install-outcomes-en.html) · [managed construction](docs/assets/flowcharts/autoevo-managed-work-en.html).

## Install

```powershell
npx @deepseek-ai/dsh plugin --profile web add --save-exact github:klarkxy/dsh-plugin-autoevo#v1.1.0
```

- Replace `--profile web` with the profile you actually use; keep the `@deepseek-ai/` prefix (the unscoped `dsh` package on npm is an unrelated project).
- Restart the profile after installing or upgrading so it loads the new bundle; start it day to day with `npx @deepseek-ai/dsh web`.
- Requires Node.js `^22.19.0 || ^24.0.0` and DSH `>=0.1.0-rc.6 <0.2.0`.

## Quick start

1. Start a new DSH session and select the user preset **Capability Evolution** (id `evolution`).
2. Describe the needed capability in ordinary language, for example:

   > I need a DSH plugin that can synchronize project records. Search for an existing one first.

3. AutoEvo presents 1–5 candidates or explicitly reports no match. Use a fresh message to choose one for review — this is the first confirmation gate.
4. After review, use another fresh message to decide: reuse, install, improve, search again, create from scratch, or stop — the second gate.

The full flow is in [User Guide §3](docs/user-guide.en.md#3-your-first-complete-workflow); step-by-step screenshots of real runs are in [`example/README.md`](example/README.md).

[![AutoEvo main workflow: Search-first with two confirmation gates](docs/assets/flowcharts/autoevo-main-workflow-en.svg)](docs/assets/flowcharts/autoevo-main-workflow-en.html)

## Understand the outcome

| Result | Meaning | Next step |
| --- | --- | --- |
| `verified` | The Host completed the expected tool round trip | Use the capability |
| `activated` / `awaiting_user_test` | Loaded without round-trip evidence, or needs a manual test | Try it once in the target profile |
| `restartRequired: true` | A non-failure install result exists, but the current process did not fully hot-load it | Restart the target profile |
| `failed_absent` / `recovery_required` | Installation failed, or state cannot be determined safely | Inspect diagnostics; recover first when the state is unclear |

`installed` and `loaded` do not mean functionally verified. Only `verified` supports that claim. See [User Guide §5](docs/user-guide.en.md#5-outcomes-and-next-steps).

Version-chain tools: `capability_versions` lists versions, `capability_rollback` restores a historical version, `capability_adopt` registers manually installed plugins, and `capability_updates` checks upstream releases read-only. See [User Guide §4.6](docs/user-guide.en.md#46-versions-adoption-and-upstream-updates).

## Safety boundary

AutoEvo owns workflow, warnings, and evidence records; DSH Core enforces permissions, sandboxes, and approvals, and AutoEvo cannot bypass that. Discovery, review, and diagnosis are read-only by default; installed third-party code ultimately runs with the current user's authority. See the [Security Model](docs/security.md) (Chinese) for the full trust boundary.

## Develop

```powershell
pnpm install --frozen-lockfile
pnpm check
```

See the [Developer Guide](docs/developer-guide.en.md).

## License

SATA. See [LICENSE](./LICENSE).
