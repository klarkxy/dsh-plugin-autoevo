# AutoEvo

English | [中文](README.md)

> Evolution continues.

<p align="center">
  <img src="docs/assets/kanban.png" alt="AutoEvo" width="420">
</p>

`dsh-plugin-autoevo` is a lightweight capability-reuse workflow and evidence plugin for DeepSeek Harness (DSH). In the **Capability Evolution** preset, every capability request—including a temporary experiment—is Search-first. The Host preserves the user's original wording, allows at most one clarification, and then checks local and remote candidates. A close candidate can be changed in a Host-bound managed source, re-reviewed, and installed; every user-adopted capability is persisted with inspectable outcome evidence.

`Resolve → Search → Review → Deploy → Verify → Upgrade`

`Reuse before build. Improve before replace.`

## Documentation

| Audience / topic | Entry point |
| --- | --- |
| Users: install, first run, two confirmation gates, outcomes, and recovery | [User Guide](docs/user-guide.en.md) |
| Developers: local setup, runtime entry points, tests, debugging, and contribution | [Developer Guide](docs/developer-guide.en.md) |
| Policy, data layout, and runtime seams | [Architecture](docs/architecture.md) (Chinese) |
| Trust boundaries, install gates, and verification evidence | [Security Model](docs/security.md) (Chinese) |

Each topic has one canonical home: operating procedures live in the User Guide, development workflows in the Developer Guide, and internal state/security invariants in the architecture and security references.

## Install

Install into the DSH profile you actually use. This example targets `web` (run DSH through npx; no global install needed):

```powershell
npx @deepseek-ai/dsh plugin --profile web add --save-exact github:klarkxy/dsh-plugin-autoevo#v1.0.0
```

Start the profile day to day with `npx @deepseek-ai/dsh web`. Note the unscoped `dsh` package on npm is an unrelated project — the command must carry the `@deepseek-ai/` prefix.

Restart the target DSH profile after installing or upgrading AutoEvo so it loads the new bundle; whether later capability installs need another restart is covered in [User Guide §5](docs/user-guide.en.md#5-outcomes-and-next-steps).

The command above becomes available after the maintainer publishes `v1.0.0`; creating the tag and Release is a separate action. Node.js must satisfy `^22.19.0 || ^24.0.0`. AutoEvo accepts DSH `>=0.1.0-rc.6 <0.2.0`; unverified `0.1` updates remain warning-level and may be tried in the active Host. The reproducible development and acceptance baseline stays pinned to DSH `0.1.1-rc.2` and Cordis `4.0.1`.

## Quick start

1. Start a new DSH session and select the **Capability Evolution** user preset (id `evolution`).
2. Describe the needed capability in ordinary language, for example:

   > I need a DSH plugin that can synchronize project records. Search for an existing one first.

3. If material ambiguity blocks useful search, answer the single clarification. AutoEvo then presents 1–5 candidates or explicitly reports no match.
4. With candidates, use a fresh chat message to choose one for review. With no candidates, choose continued search, creating a new capability, or stopping.
5. After review, use another fresh message to decide whether to reuse, install, improve, search again, create from scratch, or stop.

Those replies are two separate confirmation gates; the full flow and rationale are in [User Guide §3](docs/user-guide.en.md#3-your-first-complete-workflow).

A typical loop is Search-first → candidate selection → factual review and warnings → user decision → installation or managed construction → re-review → user confirmation for the final install → distinct installed, loaded, activated, and verified outcomes. Production logic never reads examples or test fixtures; the screenshots are anonymized product-behavior records only.

## Workflow screenshots

An offline Gregorian/lunar calendar capability after a genuine no-match result:

![Create choice after no match](example/create/02-no-candidate-create-choice.png)

![Current source review and final install choice](example/create/04-review-install-choice.png)

![Installed outcome awaiting restart and user testing](example/create/07-installed-result.png)

![Real Gregorian-lunar round trip after restart](example/create/08-tool-roundtrip.png)

An LLM Auto Review capability similar in shape to Codex Auto Review: review the closest candidate first, then let the user choose a lightweight advisory-only tool that does not take over DSH approval.

![Auto Review candidate review](example/auto-review/02-candidate-review.png)

![Auto Review post-construction review and final choice](example/auto-review/04-review-install-choice.png)

![Precise Auto Review state after installation](example/auto-review/06-installed-result.png)

![Real advisory-only Auto Review tool result](example/auto-review/07-tool-roundtrip.png)

Both real runs continue through one-time DSH approval, installation, restart, and a real client tool call. The installation outcome still distinguishes `installed`, `loaded`, `activated`, and `verified`; the later client call is separate evidence and does not rewrite or overstate the installation receipt.

See [`example/README.md`](example/README.md) for the complete sequence and precise state at each step.

## Understand the outcome

| Result | Meaning | Next step |
| --- | --- | --- |
| `verified` | The Host completed the expected tool round trip | Use the capability |
| `activated` / `awaiting_user_test` | Loaded without round-trip evidence, or needs a real client/profile test | Try it once in the target profile |
| `restartRequired: true` | A non-failure install result exists, but the current process did not fully hot-load it | Restart the target profile |
| `failed_absent` / `recovery_required` | Installation failed, or install/cleanup state cannot be determined safely | Inspect diagnostics; recover first when the state is unclear |

`installed` and `loaded` do not mean functionally verified. Only `verified` supports that claim. See [Outcomes and next steps](docs/user-guide.en.md#5-outcomes-and-next-steps).

AutoEvo also tracks an installation version chain per package: `capability_versions` lists versions, `capability_rollback` restores a historical version (still through the standard approved install), `capability_adopt` registers plugins installed outside the workflow into the ledger, and `capability_updates` checks upstream releases read-only. See [User guide §4.6](docs/user-guide.en.md#46-versions-adoption-and-upstream-updates).

## Safety boundary

- AutoEvo owns workflow, warnings, and evidence records. DSH Core owns enforcement of permissions, sandboxes, and approvals; AutoEvo cannot expand, replace, or bypass those DSH Core controls.
- Discovery, review, and diagnosis are read-only by default. Actual install, removal, modify, and create side effects remain subject to DSH Core permissions and one-time approval. Warnings are shown and recorded, but may be accepted when DSH Core permits it and the user explicitly chooses to continue; installed third-party code ultimately runs with the current user's authority.
- See the [Security Model](docs/security.md) for the full trust boundary, and [User Guide §8](docs/user-guide.en.md#8-safety-and-privacy) for safety and privacy notes in daily use.

## Develop

```powershell
pnpm install --frozen-lockfile
pnpm check
```

See the [Developer Guide](docs/developer-guide.en.md) for source layout, generated `lib/`, the test matrix, and release gates.

## License

SATA. See [LICENSE](./LICENSE).
