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

```powershell
dsh plugin --profile web add --save-exact github:klarkxy/dsh-plugin-autoevo#v0.5.1
```

Restart that DSH profile after installing or upgrading AutoEvo so the new bundle takes effect. `restartRequired: true` belongs to later capability-install results produced by a running AutoEvo instance; it is not a no-restart guarantee for installing AutoEvo itself.

After installation, the DSH user preset list contains **Capability Evolution** (id `evolution`, usually marked Custom). AutoEvo upgrades only an unchanged copy it owns. A same-name foreign directory or user-edited preset is preserved and diagnosed.

Setting `evolutionPreset: false` stops future materialization or upgrades. It never deletes an existing preset.

## 3. Your first complete workflow

### 3.1 State the need

Choose **Capability Evolution** in a new or blank DSH session and describe the goal:

> I need a DSH plugin that can calculate scientific notation. Search for an existing one first.

AutoEvo checks tools, skills, and bridges visible to the current Agent before marketplace discovery. If `dsh-find-plugin` is missing, AutoEvo requests one-time DSH approval to install it. That approval authorizes the finder installation only; it does not select a capability candidate.

### 3.2 Gate 1: choose what to review

The Agent may refine within a bounded budget and then seals a 1–5 item shortlist. Use a fresh chat reply to choose a candidate, ask for another comparison, search again, or stop. This gate is read-only: it cannot install, modify, or create anything.

### 3.3 Gate 2: decide after review

The Host reviews exact source identity, manifest, required code, compatibility, and security facts. Use another fresh reply to decide whether to reuse, install, improve, create from scratch, search again, or stop.

Ordinary language is the decision. Internal names such as `use_this` and `modify_this` are not passphrases. The Host binds the model's interpretation to the current turn, candidate, and review. A concrete side effect also requires one-time DSH approval.

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

### Reuse an existing local capability

If a local tool or skill already satisfies the need, reuse it. This is a normal terminal result with no remote review or installation.

### Install a complete candidate

Direct install is available only when the current-policy review binds an immutable source, materializable package, acceptable compatibility, full fit, and the required safety facts. Persistent install targets the real profile. Temporary trials are only available for layers the Host can verify automatically.

### Improve a candidate or installed capability

AutoEvo validates the exact upstream or managed lineage, prepares a Host-managed Git source under `.autoevo/sources/`, keeps edits and checks visible in the current session, then commits, re-reviews, freezes, and waits for another install decision. It does not launch a hidden child Agent.

A historical failed or removed source becomes a new first install after repair. Only a package that really exists in the live profile with exact source ownership is a replacement.

### Create from scratch

Creation is available only after discovery is complete, no suitable candidate remains, and you explicitly choose create at Gate 2. Scaffold, edits, checks, review, and the later install decision remain separate steps.

### Stop

You can stop at either gate. Stop is never treated as install/create authority, and DSH approval cannot override it.

## 5. Outcomes and next steps

| Field / outcome | Exact meaning | Next step |
| --- | --- | --- |
| `installed: true` | Exact target-profile source match plus a non-failure completion | Inspect outcome, `loaded`, and `verified` |
| `loaded: true` | The Host proved the bundle loaded in the destination process | Do not call it functionally verified yet |
| `verified` / `verified: true` | Host `tool_roundtrip` covered and successfully returned every expected tool | Use the capability |
| `activated` | `bundle_activation` passed; Loader/Fiber settled without a tool round trip | Try the capability in the target profile |
| `awaiting_user_test` | Persistent `manual_runtime` completed without a Host fixture | Perform one real client/profile test |
| `restartRequired: true` | A non-failure result exists, but current-process hot-load was incomplete | Restart the target profile |
| `failed_absent` | Install failed and the Host proved both dependency and visible target absent | Diagnose before retrying |
| `recovery_required` | Install, replacement, or cleanup state cannot be determined safely | Recover; do not reinstall or delete blindly |

An isolated minimal-DSH preflight proves that reviewed bytes settle in a throwaway `dsh-base` Loader. It does not prove destination loading or a real-client tool round trip. That sandbox does not use or modify the official `headless` profile.

For `activated` or `awaiting_user_test`, make one minimal, inspectable, side-effect-free request in the target profile. A model saying “looks successful” is not a Host `verified` receipt.

## 6. Diagnose and recover

Ask for read-only diagnosis explicitly: “Inspect why this failed; do not retry, install, or clean up yet.” Diagnosis is bounded and redacted. It does not retry or expose credentials, full private paths, raw stderr, or session content.

`recovery_required` uses the current sealed failure interrupt. Follow the legal options presented in a fresh reply; do not construct old workflow/review/installation IDs yourself.

Completed-install cleanup is a separate path. Make a new top-level request such as: “Clean up this completed installation and start discovery from scratch.” The Host removes only receipt-owned installed artifacts. It does not delete the managed source repository.

Repeated diagnosis, verification, and modification are bounded. Preserve receipts and compare new evidence instead of looping the same action.

## 7. Uninstall AutoEvo

1. Remove **Capability Evolution** from the DSH user-preset UI.
2. Remove AutoEvo from the same profile:

   ```powershell
   dsh plugin --profile web remove dsh-plugin-autoevo
   ```

3. Restart that DSH profile.

This differs from AutoEvo's `plugin_remove`, which removes a receipt-owned third-party capability. It does not uninstall AutoEvo or delete managed source.

## 8. Safety and privacy

- GitHub content and marketplace summaries are untrusted data. Host-derived facts and hashes are the review evidence.
- An installed third-party plugin ultimately runs with the current user's authority. An isolated profile is not a malware sandbox.
- `forwardedCredentialEnv` lists environment-variable names that may be forwarded. Never put secrets in prompts, documentation, fixtures, or repositories.
- Before contributing a managed change upstream, inspect the diff for local paths, accounts, private endpoints, secrets, and proprietary logic, then obtain separate fork/push/PR approval.

## 9. FAQ

**Why can't one message select and install a candidate?** Because the read-only review between Gate 1 and Gate 2 may change your decision about fit, risk, or compatibility.

**Why confirm in chat after a DSH approval?** Chat selects the action and candidate. DSH approval authorizes one concrete side effect. Neither substitutes for the other.

**Is `activated` success?** It is a non-failure completion proving bundle load, not functional tool verification.

**Does deleting workspace source break an installed plugin?** No. Persistent install uses an AutoEvo-owned immutable artifact.

**Where are reproducible scenarios?** See [Real-world Samples](real-world-samples.md) and preserve its `real-live-passed`, `implemented`, and `planned` evidence labels.

## Further reading

- [Developer Guide](developer-guide.en.md)
- [Architecture](architecture.md) (Chinese)
- [Security Model](security.md) (Chinese)
- [Real-world Samples](real-world-samples.md) (Chinese)
