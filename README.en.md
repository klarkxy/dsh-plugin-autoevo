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

| Audience / topic | Entry point |
| --- | --- |
| Users: install, first run, two confirmation gates, outcomes, and recovery | [User Guide](docs/user-guide.en.md) |
| Developers: local setup, runtime entry points, tests, debugging, and contribution | [Developer Guide](docs/developer-guide.en.md) |
| State machine, data layout, and runtime seams | [Architecture](docs/architecture.md) (Chinese) |
| Trust boundaries, install gates, and verification evidence | [Security Model](docs/security.md) (Chinese) |

Each topic has one canonical home: operating procedures live in the User Guide, development workflows in the Developer Guide, and internal state/security invariants in the architecture and security references.

Interactive flow diagrams (standalone HTML with pan/zoom, search, and export): [main workflow](docs/assets/flowcharts/autoevo-main-workflow-en.html) · [install outcome state machine](docs/assets/flowcharts/autoevo-install-outcomes-en.html) · [managed construction](docs/assets/flowcharts/autoevo-managed-work-en.html).

## Install

Install into the DSH profile you actually use. This example targets `web` (run DSH through npx; no global install needed):

```powershell
npx @deepseek-ai/dsh plugin --profile web add --save-exact github:klarkxy/dsh-plugin-autoevo#v1.0.0
```

- The command must carry the `@deepseek-ai/` prefix; the unscoped `dsh` package on npm is an unrelated project.
- For day-to-day use, start the profile with `npx @deepseek-ai/dsh web`.
- Restart the target DSH profile after installing or upgrading AutoEvo so it loads the new bundle; whether later capability installs need another restart is covered in [User Guide §5](docs/user-guide.en.md#5-outcomes-and-next-steps).

Version requirements: Node.js `^22.19.0 || ^24.0.0`; DSH `>=0.1.0-rc.6 <0.2.0` (unverified `0.1` updates produce a warning but are still allowed to run).

## Quick start

1. Start a new DSH session and select the user preset **Capability Evolution** (id `evolution`).
2. Describe the needed capability in ordinary language, for example:

   > I need a DSH plugin that can synchronize project records. Search for an existing one first.

3. If material ambiguity blocks useful search, answer the single clarification. AutoEvo then presents 1–5 candidates or explicitly reports no match.
4. With candidates, use a fresh chat message to choose one for review. With no candidates, choose continued search, creating a new capability, or stopping.
5. After review, use another fresh message to decide whether to reuse, install, improve, search again, create from scratch, or stop.

Steps 4 and 5 are two independent confirmation gates; the full flow is in [User Guide §3](docs/user-guide.en.md#3-your-first-complete-workflow). A typical loop:

```text
Search-first → candidate selection → factual review and warnings → user decision
→ install or managed construction → re-review → confirm final install → distinguish installed/loaded/activated/verified outcomes
```

[![AutoEvo main workflow: Search-first with two confirmation gates](docs/assets/flowcharts/autoevo-main-workflow-en.svg)](docs/assets/flowcharts/autoevo-main-workflow-en.html)

(Click the diagram for the interactive viewer with pan/zoom, search, and export.) Step-by-step screenshots of real runs (two complete cases: create after an empty result, and an advisory-only review tool) are in [`example/README.md`](example/README.md).

## Understand the outcome

| Result | Meaning | Next step |
| --- | --- | --- |
| `verified` | The Host completed the expected tool round trip | Use the capability |
| `activated` / `awaiting_user_test` | Loaded without round-trip evidence, or needs a real client/profile test | Try it once in the target profile |
| `restartRequired: true` | A non-failure install result exists, but the current process did not fully hot-load it | Restart the target profile |
| `failed_absent` / `recovery_required` | Installation failed, or install/cleanup state cannot be determined safely | Inspect diagnostics; recover first when the state is unclear |

`installed` and `loaded` do not mean functionally verified. Only `verified` supports that claim. See [Outcomes and next steps](docs/user-guide.en.md#5-outcomes-and-next-steps).

[![AutoEvo install outcome state machine](docs/assets/flowcharts/autoevo-install-outcomes-en.svg)](docs/assets/flowcharts/autoevo-install-outcomes-en.html)

AutoEvo also tracks an installation version chain per package: `capability_versions` lists versions, `capability_rollback` restores a historical version, `capability_adopt` registers plugins installed outside the workflow into the ledger, and `capability_updates` checks upstream releases read-only. See [Versions, adoption, and upstream updates](docs/user-guide.en.md#46-versions-adoption-and-upstream-updates).

## Safety boundary

- AutoEvo owns workflow, warnings, and evidence records. DSH Core owns enforcement of permissions, sandboxes, and approvals; AutoEvo cannot expand, replace, or bypass those DSH Core controls.
- Discovery, review, and diagnosis are read-only by default. Actual install, removal, modify, and create side effects remain subject to DSH Core permissions and one-time approval. Warnings are shown and recorded, but may be accepted when DSH Core permits it and the user explicitly chooses to continue; installed third-party code ultimately runs with the current user's authority.
- See the [Security Model](docs/security.md) (Chinese) for the full trust boundary, and [User Guide §8](docs/user-guide.en.md#8-safety-and-privacy) for safety and privacy notes in daily use.

## Develop

```powershell
pnpm install --frozen-lockfile
pnpm check
```

See the [Developer Guide](docs/developer-guide.en.md) for source layout, generated `lib/`, the test matrix, and release gates.

## License

SATA. See [LICENSE](./LICENSE).
