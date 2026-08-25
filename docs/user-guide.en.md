# AutoEvo User Guide

English | [中文](user-guide.md) · [Back to README](../README.en.md)

This guide is for people who discover, install, improve, or create capabilities in DSH. Capability Evolution is a superset of official Creator mode: live plugin experiments, runtime inspect, preset authoring, and delegation stay available; AutoEvo governs community reuse, review, install, and upgrade. It explains the choices you make, what AutoEvo can actually prove, and how to recover safely. See [Architecture](architecture.md) and the [Developer Guide](developer-guide.en.md) for internals and source work.

## 1. Before you start

- Installable AutoEvo release `v0.5.1`; repository version `0.5.3` is not released yet.
- Node.js `>=22.19.0 || >=24.0.0`.
- A working DSH profile; examples below use `web`.
- For GitHub discovery/review, install GitHub CLI and make sure `gh auth status` works.
- Use a model with reliable instruction following, context retention, and structured tool use.

The `--profile web` argument must name the profile you actually use. Do not copy it into a test or production environment without checking the target.

## 2. Install, upgrade, and first load

Install the release listed in [§1](#1-before-you-start) (run DSH through npx; no global install needed — keep the `@deepseek-ai/` prefix, the unscoped `dsh` package on npm is an unrelated project):

```powershell
npx @deepseek-ai/dsh plugin --profile web add --save-exact github:klarkxy/dsh-plugin-autoevo#v0.5.1
```

Restart that DSH profile after installing or upgrading AutoEvo so the new bundle takes effect. The meaning of the `restartRequired` result field is explained under [Outcomes and next steps](#5-outcomes-and-next-steps).

After installation, look for the preset with id `evolution` (display name **Capability Evolution**) in the DSH user preset list. AutoEvo upgrades only an unchanged copy it owns. A same-name foreign directory or user-edited preset is preserved and diagnosed.

Setting `evolutionPreset: false` stops future materialization or upgrades. It never deletes an existing preset.

## 3. Your first complete workflow

### 3.1 State the need

Choose **Capability Evolution** in a new or blank DSH session and describe the goal:

> I need a DSH plugin that can calculate scientific notation. Search for an existing one first.

AutoEvo checks tools, skills, and bridges visible to the current Agent before searching GitHub for repositories tagged `dsh-plugin`. That search does not install a marketplace plugin and does not select a capability candidate.

### 3.2 Gate 1: choose what to review

The Agent may refine within a bounded budget and then seals a 1–5 item shortlist. Use a fresh chat reply to choose what to review, for example:

- “Review the second one.”
- “Go with the one you recommend.”
- “None of these fit — keep searching.”

This gate is read-only: it cannot install, modify, or create anything. If candidate identity or differences would materially change your choice, the Agent may ask one precise question first.

### 3.3 Gate 2: decide after review

The Host reviews exact source identity, manifest, required code, compatibility, and security facts. Use another fresh reply to decide whether to reuse, install, improve, create from scratch, search again, or stop.

Natural language is enough — it is the formal decision, and no internal action names are required. The Host binds your reply to the current turn, candidate, and review; side effects then request one-time DSH approval.

```text
Requirement
  ↓
Discovery and bounded refinement
  ↓
Sealed 1–5 candidate shortlist
  ↓  Gate 1: choose a candidate to review
Read-only review
  ↓  Gate 2: use / improve / create / search / stop
Install or managed-source work
  ↓
Host verification and receipt
```

## 4. Common tasks

### 4.1 Reuse an existing local capability

If a local tool or skill already satisfies the need, reuse it. This is a normal terminal result with no remote review or installation.

### 4.2 Install a complete candidate

Direct install is available only when the current-policy review binds an immutable source, materializable package, acceptable compatibility, full fit, and the required safety facts. Persistent install targets the real profile. Temporary trials are only available for layers the Host can verify automatically.

### 4.3 Improve a candidate or installed capability

When a candidate is almost right, an installed plugin needs an upgrade, or a historically failed source needs repair, choose “improve on this source”. AutoEvo will:

1. Validate the exact upstream or historical managed source;
2. Prepare a Host-managed Git source under `.autoevo/sources/` in the current session workspace;
3. Keep edits and checks visible in the current Capability Evolution session;
4. Have the Host commit, re-review, and freeze the result;
5. Wait for you to confirm the installation again.

AutoEvo does not launch a hidden child Agent for this step. A historical failed or removed source becomes a new first install after repair. Only a package that really exists in the live profile with exact source ownership is a replacement.

### 4.4 Create from scratch

Creation is available only after discovery is complete, no suitable candidate remains, and you explicitly choose create at Gate 2. Creation happens in the same visible managed source; after checks and local review, the final install still requires your explicit confirmation.

### 4.5 Stop

You can stop at either gate. Stop is never treated as install or create authority, and a DSH approval cannot override it. See the [FAQ](#9-faq) for how chat confirmation and DSH approval divide their roles.

### 4.6 Versions, adoption, and upstream updates

AutoEvo keeps an installation receipt chain per package. Four companion tools:

- `capability_versions`: lists the Host-tracked version chain for one package, marking the live version and artifact availability. Read-only.
- `capability_rollback`: rolls back to a historical version of the package (the direct predecessor by default). It reinstalls the linked reviewed source through the standard install path and still requires one-time DSH approval; adopted receipts have no linked review and cannot be rollback targets.
- `capability_adopt`: without arguments, scans the current profile for installed plugins the Host does not track; with `package_name`, registers one as an adopted receipt so the version and update tools can track it. Adopted receipts have no review and are never `verified`.
- `capability_updates`: read-only comparison of exact GitHub-pinned installations against the upstream default-branch head and latest release. Upgrading itself still goes through the improve flow in §4.3.

## 5. Outcomes and next steps

| Field / outcome | Exact meaning | Next step |
| --- | --- | --- |
| `installed: true` | Exact target-profile source match plus a non-failure completion | Inspect outcome, `loaded`, and `verified` |
| `loaded: true` | The Host proved the bundle loaded in the destination process | Do not call it functionally verified yet |
| `verified` / `verified: true` | Host `tool_roundtrip` (an automated real tool round trip) covered and successfully returned every expected tool | Use the capability |
| `activated` | `bundle_activation` (a bundle load check without tools) passed; Loader/Fiber settled | Try the capability in the target profile |
| `awaiting_user_test` | Persistent `manual_runtime` (verification left to you at runtime) completed without a Host fixture | Perform one real client/profile test |
| `restartRequired: true` | A non-failure result exists, but current-process hot-load was incomplete | Restart the target profile |
| `failed_absent` | The install command failed, and neither the profile nor the visible package target exists | Diagnose before retrying |
| `recovery_required` | Install, replacement, or cleanup state cannot be determined safely | Recover; do not reinstall or delete blindly |

An isolated minimal-DSH preflight proves that reviewed bytes settle in a throwaway `dsh-base` Loader. It does not prove destination loading or a real-client tool round trip. That sandbox does not use or modify the official `headless` profile.

For `activated` or `awaiting_user_test`, make one minimal, inspectable, side-effect-free request in the target profile. Record the actual tool call and its result; a model saying “looks successful” is not a Host `verified` receipt.

## 6. Diagnose and recover

### Only want to know what failed

Ask for read-only diagnosis explicitly:

> Inspect why this failed; do not retry, install, or clean up yet.

Diagnosis is read-only, bounded, and redacted: it does not retry, and it does not expose credentials, full private paths, raw stderr, or session content to the model.

### `recovery_required` during a failure

`recovery_required` uses the current sealed failure interrupt. Follow the legal options presented in a fresh reply; do not construct old workflow/review/installation IDs yourself.

### Cleaning up a completed install and starting over

This is a separate path. Again, say it directly, as a new top-level message:

> Clean up this completed installation and start discovery from scratch.

The Host removes only the installed artifacts owned by that workflow's installation receipt and starts over. It does not delete the managed source repository. Do not mix completed cleanup with a failure interrupt.

### Repeated failures

Repeated diagnosis, verification, and modification are bounded. Preserve receipts and compare new evidence instead of looping the same install or repair.

## 7. Uninstall AutoEvo

1. Remove **Capability Evolution** from the DSH user-preset UI.
2. Remove AutoEvo from the same profile:

   ```powershell
   npx @deepseek-ai/dsh plugin --profile web remove dsh-plugin-autoevo
   ```

3. Restart that DSH profile.

This differs from AutoEvo's `plugin_remove`, which removes a receipt-owned third-party capability. It does not uninstall AutoEvo or delete managed source.

## 8. Safety and privacy

- The full trust-boundary and review-evidence model lives in the [Security Model](security.md) (Chinese): GitHub READMEs, source code, manifests, and marketplace summaries are treated as untrusted data, and review conclusions rest on Host-derived facts and content hashes.
- An installed third-party plugin ultimately runs with the current user's authority. An isolated profile is not a malware sandbox.
- `forwardedCredentialEnv` is an AutoEvo config key that lists the names of environment variables allowed to be forwarded — names only, never values. Never put secrets in prompts, documentation, fixtures, or repositories.
- Before contributing a managed change upstream, inspect the diff for local paths, accounts, private endpoints, secrets, and proprietary logic, then obtain separate fork/push/PR approval.

## 9. FAQ

**Why can't one message select and install a candidate?** Selecting a candidate and the final side-effect decision are two separate gates. The read-only review between them may change your decision about fit, risk, or compatibility.

**Why confirm in chat after a DSH approval?** Chat selects the action and candidate. DSH approval authorizes one concrete side effect. Neither substitutes for the other.

**Is `activated` success?** It is a non-failure completion proving bundle load, not functional tool verification. A successful hands-on trial counts as independent runtime evidence, but the model must not rewrite the Host receipt into `verified`.

**Does deleting workspace source break an installed plugin?** No. Persistent install uses an AutoEvo-owned immutable artifact.

**Where are reproducible scenarios?** See [Real-world Samples](real-world-samples.md) (Chinese) and preserve its `real-live-passed`, `implemented`, and `planned` evidence labels — never describe a `planned` sample as live-verified.

## Further reading

- [Developer Guide](developer-guide.en.md)
- [Architecture](architecture.md) (Chinese)
- [Security Model](security.md) (Chinese)
- [Real-world Samples](real-world-samples.md) (Chinese)
