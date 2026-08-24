# AutoEvo

English | [中文](README.md)

> Evolution continues.

<p align="center">
  <img src="docs/assets/kanban.png" alt="AutoEvo" width="420">
</p>

`dsh-plugin-autoevo` is the capability-reuse and safe-evolution layer for DeepSeek Harness (DSH). The Capability Evolution preset is a superset of official Creator mode: runtime inspect, live plugin experiments, preset authoring, and delegation stay available. When an Agent needs a reusable capability, AutoEvo checks local tools and skills first, then discovers, reviews, and installs community plugins. If a candidate is close but incomplete, it can be changed, re-reviewed, and installed from a Host-managed source.

`Resolve → Search → Review → Deploy → Verify → Upgrade`

`Reuse before build. Improve before replace.`

## Documentation

| Audience / topic | Entry point |
| --- | --- |
| Users: install, first run, two confirmation gates, outcomes, and recovery | [User Guide](docs/user-guide.en.md) |
| Developers: local setup, runtime entry points, tests, debugging, and contribution | [Developer Guide](docs/developer-guide.en.md) |
| Policy, data layout, and runtime seams | [Architecture](docs/architecture.md) (Chinese) |
| Trust boundaries, install gates, and verification evidence | [Security Model](docs/security.md) (Chinese) |
| Reproducible scenarios and evidence levels | [Real-world Samples](docs/real-world-samples.md) (Chinese) |

Each topic has one canonical home: operating procedures live in the User Guide, development workflows in the Developer Guide, and internal state/security invariants in the architecture and security references.

## Install

Install into the DSH profile you actually use. This example targets `web`:

```powershell
dsh plugin --profile web add --save-exact github:klarkxy/dsh-plugin-autoevo#v0.5.1
```

Restart the target DSH profile after installing or upgrading AutoEvo so it loads the new bundle. Once AutoEvo is running and installs another capability, that later workflow uses `restartRequired: true` to tell you whether the capability's target profile needs another restart.

The latest installable release is `v0.5.1`; repository version `0.5.3` is the next unreleased version. Node.js must satisfy `>=22.19.0 || >=24.0.0`; current development and acceptance use DSH `0.1.0-rc.6` and Cordis `4.0.1`.

## Quick start

1. Start a new DSH session and select the **Capability Evolution** user preset (id `evolution`).
2. Describe the needed capability in ordinary language, for example:

   > I need a DSH plugin that can calculate scientific notation. Search for an existing one first.

3. When AutoEvo presents 1–5 candidates, use a fresh chat message to choose the candidate to review.
4. After review, use another fresh message to decide whether to reuse, install, improve, search again, create from scratch, or stop.

Those replies are two separate confirmation gates. A one-time DSH approval authorizes a concrete side effect; it never replaces candidate selection or the final user decision. Ordinary language is enough—internal action names are not passphrases.

## Understand the outcome

| Result | Meaning | Next step |
| --- | --- | --- |
| `verified` | The Host completed the expected tool round trip | Use the capability |
| `activated` | The bundle loaded, but no tool round trip was observed | Try it in the target profile |
| `awaiting_user_test` | The capability requires a real client/profile test | Perform one real use test |
| `restartRequired: true` | A non-failure install result exists, but the current process did not fully hot-load it | Restart the target profile |
| `failed_absent` | Installation failed and the Host proved the target is absent | Inspect diagnostics before retrying |
| `recovery_required` | Install or cleanup state cannot be determined safely | Recover first; do not reinstall blindly |

`installed` and `loaded` do not mean functionally verified. Only `verified` supports that claim. See [Outcomes and next steps](docs/user-guide.en.md#5-outcomes-and-next-steps).

## Safety boundary

- Discovery, review, and diagnosis are read-only by default. Install, removal, modify, and create require a real user decision; side effects also require one-time DSH approval.
- Modify and create work stays visible in the current Capability Evolution session inside a Host-managed Git source. AutoEvo does not start a hidden child Agent and does not fall back to `code`.
- On Windows, the sandbox is integrity-oriented partial isolation, not a confidentiality, credential, or network sandbox. Installed third-party code ultimately runs with the current user's authority.
- A weak model may map natural language to the wrong legal action or candidate. Use a model with reliable instruction following, context retention, and structured tool use.

## Develop

```powershell
pnpm install --frozen-lockfile
pnpm check
```

See the [Developer Guide](docs/developer-guide.en.md) for source layout, generated `lib/`, the test matrix, and release gates.

## License

SATA. See [LICENSE](./LICENSE).
