# AutoEvo User Guide

English | [中文](user-guide.md) · [Back to README](../README.en.md)

This guide is for users who discover, install, improve, or create capabilities in DSH. The **Capability Evolution** preset uses a Search-first workflow: temporary experiments and formal needs follow the same path. AutoEvo owns the workflow, warnings, and evidence receipts; DSH Core enforces permissions, sandboxes, and approvals.

## 1. Before you start

- Node.js `^22.19.0 || ^24.0.0`.
- A working DSH profile; this guide uses `web` as the example — replace `--profile web` with the profile you actually use.
- GitHub discovery or review requires GitHub CLI; confirm `gh auth status` works.
- A model with reliable instruction following, context retention, and structured tool use.

## 2. Install, upgrade, and first load

```powershell
npx @deepseek-ai/dsh plugin --profile web add --save-exact github:klarkxy/dsh-plugin-autoevo#v1.0.0
```

Run DSH through npx; no global install needed. Keep the `@deepseek-ai/` prefix — the unscoped `dsh` package on npm is an unrelated project. Restart the profile after installing or upgrading so the new bundle takes effect.

After installation, the user preset **Capability Evolution** (id `evolution`) should appear in the preset list. AutoEvo only upgrades an unchanged copy it owns; a same-name foreign directory or user-edited preset is preserved and diagnosed. Setting `evolutionPreset` to `false` stops preset installs and upgrades, but never deletes an existing preset.

## 3. Your first complete workflow

### 3.1 State the need

In a new DSH session, choose **Capability Evolution** and describe the goal directly:

> I need a DSH plugin that can synchronize project records. Search for an existing one first.

A clear need starts search immediately. The Agent only asks a clarification when a material ambiguity would change the search direction. The clarification answer affects read-only search only and grants no selection, creation, modification, or installation authority.

### 3.2 Gate 1: choose a candidate to review

The Agent runs bounded supplemental queries, then seals 1–5 candidates. Use a fresh chat message to choose what to review, for example:

- "Review the second one."
- "Go with the one you recommend."
- "None of these fit — keep searching."

This gate is read-only and cannot install, modify, or create anything. Search may return no candidates; in that case only continued search, creating a new capability, or stopping is offered. Choosing "create" still requires a fresh confirmation later.

### 3.3 Gate 2: decide after review

The Host reviews the candidate's exact source, manifest, required source files, compatibility, and security facts. After review, use a fresh chat message to decide explicitly: reuse as is, install, improve, create from scratch, search again, or stop. Natural language is enough; actual side effects remain enforced by DSH Core permissions and one-time approval.

[![AutoEvo main workflow](assets/flowcharts/autoevo-main-workflow-en.svg)](assets/flowcharts/autoevo-main-workflow-en.html)

(Click the image for the interactive workflow viewer.)

## 4. Common tasks

### 4.1 Reuse an existing local capability

When a local tool or skill already meets the need, reuse it. This is a normal terminal state with no remote review or installation artifact.

### 4.2 Install a reviewed candidate

As long as the review identifies the source, target package, and a valid install description, the user decides whether to install. Fit, compatibility, lifecycle scripts, code risk, and reviewer opinions are shown as warnings and recommendations; they do not hide the install action. Only a non-materializable source must be repaired first. Every adopted capability is installed persistently into the target profile; lifecycle scripts and package-manager behavior follow DSH's normal permissions, sandbox, and approval rules.

### 4.3 Improve a candidate or installed capability

When a candidate is almost right, an installed plugin needs an upgrade, or a historically failed source needs repair, choose "improve on this source". AutoEvo will:

1. Validate the exact upstream or historical managed source;
2. Prepare a managed Git source under `.autoevo/sources/` in the current session workspace;
3. Have the Host start a short-lived construction session whose cwd is exactly that managed source, then perform edits and bounded checks there;
4. Have the Host commit, re-review, and freeze the result;
5. Wait for your confirmation of installation again.

The Host-owned construction child cannot escape the managed source, install plugins, mutate the profile, commit, or publish, and is disposed after it returns. A historical failed or removed source becomes a new first install after repair. Only a package that genuinely exists in the profile with exact source match is treated as a replacement.

### 4.4 Create from scratch

Creation is available only after discovery is complete, no suitable candidate remains, and you explicitly choose create at Gate 2. Creation uses the same cwd-bound managed construction session; after checks and local review, the final install still requires your confirmation again.

### 4.5 Stop

You can stop at either gate. Stop is never treated as install or create authority, and DSH approval cannot override it.

### 4.6 Versions, adoption, and upstream updates

AutoEvo keeps an installation receipt chain per package. Four companion tools:

| Tool | Purpose |
| --- | --- |
| `capability_versions` | Lists the version chain by package, marking the live version and artifact availability; read-only. |
| `capability_rollback` | Rolls back to a historical version (the direct predecessor by default). Reinstalls through the standard reviewed-source path and still requires one-time approval; adopted receipts without a linked review cannot be rollback targets. |
| `capability_adopt` | Without arguments, scans the current profile for untracked installed plugins; with `package_name`, registers one as an adopted receipt so the version and update tools can track it. Adopted receipts have no review and `verified` is false. |
| `capability_updates` | For installations pinned to an exact GitHub source, read-only comparison against the upstream default-branch head and the latest release. Upgrading itself still goes through the §4.3 improve flow. |

## 5. Outcomes and next steps

[![AutoEvo install outcome state machine](assets/flowcharts/autoevo-install-outcomes-en.svg)](assets/flowcharts/autoevo-install-outcomes-en.html)

(Click the image for the interactive state machine.)

| Field / outcome | Exact meaning | What you should do |
| --- | --- | --- |
| `installed: true` | Target profile matches the reviewed source, and the result is a non-failure completion | Continue to inspect `verified`, `loaded`, and outcome |
| `loaded: true` | The bundle is loaded in the destination process | Do not claim functional verification on this alone |
| `verified` | The Host's `tool_roundtrip` (an automated real tool round trip) covered the expected tools and returned successfully | The capability can be called verified |
| `activated` | `bundle_activation` (a bundle load check with no tools) passed | Try the capability in the target profile |
| `awaiting_user_test` | Persistent `manual_runtime` completed, no Host automatic fixture | Try it once in the real client or profile |
| `restartRequired: true` | A non-failure result exists, but the current process has no complete hot-load | Restart the profile and try again |
| `failed_absent` | The install command failed, and neither the profile nor the visible package target exists | Diagnose first, then decide whether to retry |
| `recovery_required` | Install, replacement, or cleanup state cannot be determined safely | Follow the recovery flow; do not reinstall or delete blindly |

AutoEvo records installed, loaded, activated, and verified against the real target-profile result. It does not substitute a private preflight result for real evidence.

For `activated` or `awaiting_user_test`, make one minimal, inspectable, side-effect-free request in the target profile and record the actual tool call and result. The model saying "looks successful" is not the same as a Host `verified` receipt.

## 6. Diagnose and recover

To only learn what failed, say it directly:

> Inspect why this failed; do not retry, install, or clean up yet.

Diagnosis is read-only, bounded, and redacted: it does not retry, and it does not hand full stderr, credentials, private paths, or session content to the model.

Failure recovery is bound to the current sealed interrupt. Use a fresh message to confirm reconciliation, cleanup, or retry among the legal options the Agent presents; do not manually stitch old workflow, review, or installation IDs together.

If pnpm's store conflicts with dependencies already linked in the target profile and the Host confirms that the selected plugin was not installed at all, AutoEvo stays on the current candidate and offers an explicit “fix the install environment, then retry this candidate” choice. After confirmation, the Host reuses the store already recorded by that profile for this install command only. The path is not exposed to the model, and no profile or global pnpm configuration is changed. This recovery is not offered when store metadata is missing, changed, or untrusted.

Cleaning up a completed install and starting over is a separate flow that requires a new top-level message:

> Clean up this completed installation and start discovery from scratch.

The Host precisely removes only the artifacts owned by that workflow's installation receipt and restarts; the managed source repository is not deleted. Do not mix completed cleanup with failure recovery.

AutoEvo bounds repeated diagnosis, verification, and modification attempts. On repeated failure, existing receipts are preserved, new evidence is compared, and a human decides the next step; the same install or repair is not looped.

## 7. Uninstall AutoEvo

1. Remove **Capability Evolution** from the DSH user-preset UI.
2. Remove the plugin from the same profile:

   ```powershell
   npx @deepseek-ai/dsh plugin --profile web remove dsh-plugin-autoevo
   ```

3. Restart that DSH profile.

This differs from AutoEvo's `plugin_remove`, which removes AutoEvo-installed third-party capabilities by receipt; it does not uninstall AutoEvo itself, and it does not delete managed source.

## 8. Safety and privacy

- GitHub READMEs, source code, manifests, and repository summaries are treated as untrusted data; review conclusions rest on Host-derived facts and content hashes. The full model is in the [Security Model](security.md) (Chinese).
- AutoEvo findings and recommendations are workflow evidence, not permission controls. DSH Core decides whether an operation is allowed; when allowed, you may explicitly accept a warning, which remains in the receipt.
- Installed third-party plugins ultimately run with the current user's authority. An isolated profile is not a malware sandbox.
- The `forwardedCredentialEnv` config lists only the names of environment variables allowed to be forwarded to installed capabilities, never values. Do not put secrets in prompts, documentation, fixtures, or repositories.
- Source modified or created locally may contain local paths, accounts, or proprietary logic. Before contributing upstream, recheck the diff and obtain separate fork, push, or PR approval.

## 9. FAQ

### Why can't one message both select a candidate and install it?

Selecting a candidate and the final side-effect decision are two different confirmation gates. The read-only review between them may change your judgment of fit, risk, and compatibility.

### Why does DSH prompt for approval and still need chat confirmation?

Chat confirmation states "what to do, on which candidate"; DSH approval authorizes one concrete side effect. The two cannot substitute for each other.

### Is `activated` a success?

It is a non-failure completion that proves the bundle loaded, not functional tool verification. A successful hands-on trial counts as independent runtime evidence, but the Host receipt is not rewritten to `verified`.

### If the workspace source is deleted, does the installed plugin break?

No. The persistent install uses an AutoEvo-owned immutable artifact, not the workspace managed source.

## Further reading

- [Developer Guide](developer-guide.en.md)
- [Architecture](architecture.md) (Chinese)
- [Security Model](security.md) (Chinese)
