# Changelog

All notable changes to AutoEvo are documented here. AutoEvo follows Semantic Versioning for its public API and persisted Policy contract.

## Unreleased

## 1.3.0

- Remove the never-wired independent semantic reviewer/verifier stack (`DshSemanticReviewerHost`, `DshSemanticVerifierHost`, `ReviewerRequest`/`ReviewerVerdict`, `VerifierRequest`/`VerificationVerdict`, the `reviewerRequestId`/`reviewerVerdictDigest` commitment fields). Mechanical verification was already Host-only; the Agent view now exposes `semantic_context_required` as a hint instead of a reviewer decision. Historical review receipts that still carry reviewer fields remain readable.
- Remove the isolated minimal-DSH preflight profile, temporary (`trial`) installation retention, `verificationTask` / `verificationExpectedText`, and `DshLauncher.verify()`. Public decisions already forced persistent installs; historical temporary receipts remain readable and removable through `plugin_remove`.
- Drop dead pre-install revalidation and duplicated guards that re-checked facts already enforced by the frozen artifact hash, the atomic profile-patch write, or an outer cancellation handler. Errors that were previously swallowed into same-shaped defaults (predecessor lookup, malformed profile-patch rows) now fail closed.
- Collapse duplicated guard layers: `CreationGuard` no longer re-denies Cordis live mutation or shell `dsh plugin add` (the outer `ExecutionGuard` already does in evolution mode); the unreachable `ensure_market` workflow node, `WorkflowHost.ensureMarket` / `reviewGithub`, and the unused refinement/diagnosis budget fields are removed. Persisted legacy `ensure_market` cursors continue to the discovery checkpoint.
- Fail closed instead of shrinking: `receiptOwnedRoots`, `StateStore.get`, preset `pathExists`, bundled-capability `readdir`, and GitHub payload parsing now surface non-ENOENT read or parse failures rather than returning an empty or default result. Three separate PID-liveness helpers are unified into `isProcessAlive`.
- `PluginInstaller` takes an options object instead of positional constructor arguments.

## 1.2.1

- Move the public Policy contract to V14. Unfinished V13 workflows and their grants cannot resume; start again from the current top-level requirement. Completed installations and historical receipts remain readable.
- Stop minting `ExecutionLease`. Authorization is `SelectionReceipt` plus `ActionCommitment`. The public `ExecutionLease` type, the `leased` lifecycle state, and lease re-signing are removed. Model-supplied `executionLease` / `lease` fields are still rejected.
- Historical workflow JSON that still contains `executionLease` is stripped on read and never written back.
- Publish exclusive installation receipts through a complete temp file plus exclusive link so concurrent Windows creates cannot read a partial JSON body.
- Keep the default local and pull-request gate to in-process Vitest, lint, typecheck, and build. Pack-spawning Vitest, DSH acceptance, and live marketplace E2E run at `pnpm check:release` and on release tags.

## 1.2.0

- Add a completion-first fault-repair workflow that seals the repair objective, requires explicit confirmation in a fresh top-level user turn, and then launches a temporary Host-owned standard coding Agent with unrestricted local repair authority.
- Apply DSH's official `danger-full-access` permission preset with no per-command prompts, while preserving compatibility with DSH 0.1.1 by writing the equivalent sandbox and approval policy events when the preset service is unavailable.
- Let the confirmed repair Agent use arbitrary shell, file, process, dependency, network, project, plugin, Profile, and Host-runtime operations instead of a predefined repair-action catalogue, then return its verification evidence and dispose the elevated child.
- Keep same-turn, replayed, cross-session, cross-boot, and already-consumed repair requests non-executable, without permanently elevating the parent session.

## 1.1.1

- Cache each exact GitHub commit under the current workspace's `.autoevo/cache/git` directory, then reuse the local Git objects for bounded preview and formal package freezing instead of repeatedly reading repository trees and blobs through GitHub APIs.
- Expand collection repositories into exact `repository + commit + packagePath` candidates, isolate nested package ownership, and let the Agent retry collections larger than five packages with a Host-returned exact package selector.
- Return legacy repository-only review queues to fresh preview rather than guessing a collection root or failing during formal review.
- Never use the DSH Desktop executable to interpret npm's JavaScript CLI; resolve a native `node` executable and fail closed when one is unavailable.
- Keep Git configuration and credentials isolated while selecting Git for Windows' bundled OpenSSL transport so public HTTPS cache fetches work in non-interactive Desktop processes.

## 1.1.0

- After a discovered GitHub capability installs successfully, preserve its Host-validated upstream lineage and present the canonical project URL with a voluntary Star invitation; never perform the Star or show the prompt for failed installs.
- Freeze remote and managed-local candidates once with `npm pack --ignore-scripts`, inspect the complete tgz entry set selected by npm (including glob and `.npmignore` semantics), and install that same Host-owned `file:` artifact only after SHA-256 rechecks.
- Treat `maxFiles` and `maxRepositoryBytes` as bounded discovery-preview controls rather than package eligibility limits; large install packages are reviewed completely, and actual I/O/resource failures remain retryable failures rather than permanent rejection.
- Keep historical source-only reviews readable but require a fresh frozen-package review before installation; block packages whose declared runtime entrypoint is absent from the tgz.
- Recover complete verbose subprocess output through DSH spill files, retain complete creator/change evidence, and stop silently dropping requirements, active Fibers, package manifests, or local candidates at arbitrary fixed counts.
- Disable lifecycle scripts both while packing review artifacts and while DSH/pnpm installs the reviewed artifact.
- Keep the public Policy contract at V13: unfinished historical source-only reviews remain readable but cannot authorize installation, while current workflows can recover through a fresh package review.
- Preserve a bounded, redacted summary from both stdout and stderr when DSH/pnpm installation fails, and expose its exit code and structured state to users, agents, and diagnosis probes.
- Preserve trusted Windows `LOCALAPPDATA` for DSH subprocesses so nested pnpm installs reuse the Web profile's existing store instead of failing with `ERR_PNPM_UNEXPECTED_STORE`.
- Keep a retryable install-stage failure eligible for a fresh user-confirmed attempt when capability verification never started, including persisted workflows affected by the earlier bookkeeping error.
- Classify bounded pnpm failures for one same-authority transient retry, or expose Host-sealed semantic recovery choices that the Agent diagnoses, compares, and selects by opaque ID; the current dependency-age executor still exempts only exact existing lockfile versions for one install command without changing pnpm policy files.
- When pnpm reports `ERR_PNPM_UNEXPECTED_STORE` and the target is confirmed absent, park at the existing confirmation gate and offer an explicit Host-sealed “fix the install environment and retry this candidate” choice; the retry reuses only the unchanged store recorded by that profile for one command and never exposes paths or edits pnpm configuration.
- Accept model-planned baseline discovery queries as a bounded field separate from the Host-captured requirement, with deterministic extraction only as a compatibility fallback.
- Keep numbered or option-only clarification answers and the Host `Clarification:` label out of GitHub search phrases so discovery still uses the original capability terms.
- Preserve meaningful clarification wording verbatim while using normalization only for classification.
- Carry fresh search-more terms and exact GitHub repository roots through the existing bounded Host refinement path before consuming the user turn.
- Return the complete bounded union of five GitHub searches to the Agent, use relevance only as reading order, pin exact repositories, and preview only the Agent-sealed shortlist before formal review.

## 1.0.0

- Establish AutoEvo as a lightweight DSH capability discovery, review, and installation workflow.
- Preserve Search-first discovery and fresh user decisions while treating empty results and rejected shortlists as normal outcomes.
- Make semantic review advisory: installability is blocked only when the selected source or install target cannot be identified and installed correctly.
- Run authorized create/modify work in a Host-owned child whose immutable cwd and DSH workspace-write root are the exact managed source; keep profile mutation, Git commits, publication, and final acceptance Host-owned.
- Return structured lifecycle failures and keep installed, activated, awaiting-user-test, and verified outcomes distinct.
- Add provisional installation receipts, exact-source removal checks, basic persisted-record validation, and in-process profile mutation serialization.
- Keep managed-source construction recoverable when finalization or re-review fails: return to the authorized modify phase with a structured retryable failure instead of exposing a stale install choice.
- Move the public Policy contract to V11 and invalidate unfinished older-policy workflows without replaying their decisions.
- Align the supported Node, pnpm, Cordis, and DSH versions; publish release artifacts through GitHub only.

## Compatibility policy

- Public AutoEvo APIs and Policy records follow SemVer.
- Completed historical receipts remain readable when their basic schema is valid.
- Unfinished records from an older Policy must start a fresh workflow.
- Windows is the fully supported platform for the complete DSH workflow. Linux and macOS receive build, unit, and package-import smoke coverage.
