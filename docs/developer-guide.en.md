# AutoEvo Developer Guide

English | [中文](developer-guide.md) · [Back to README](../README.en.md)

This guide is for maintainers who change AutoEvo Host seams, workflow behavior, managed-source evolution, install verification, or repository tooling. Policy/state and security invariants remain canonical in [Architecture](architecture.md) and the [Security Model](security.md).

## 1. Local environment

- Node.js `>=22.19.0 || >=24.0.0`; CI uses Node 24.
- pnpm; CI currently uses `10.29.2`.
- Git; live marketplace/GitHub work also requires GitHub CLI.
- Windows/PowerShell is the primary exercised environment. Core execution uses argv runners and must not depend on interactive shell state.

```powershell
pnpm install --frozen-lockfile
pnpm check
```

| Command | Coverage | Use |
| --- | --- | --- |
| `pnpm lint` | TypeScript lint for `src/` and `tests/` | Fast source check |
| `pnpm typecheck` | `tsc --noEmit` | Public types/contracts |
| `pnpm test` | Vitest unit and integration tests | Logic changes |
| `pnpm build` | Rebuild tracked `lib/` with tsdown | Source/export changes |
| `pnpm check:fast` | lint, typecheck, Vitest, build, Loader smoke, packaged acceptance | Fast complete gate |
| `pnpm check` | `check:fast` plus offline local/adversarial E2E | Normal integration gate |
| `pnpm check:release` | `check` plus live marketplace E2E and pack dry-run | Release candidate |
| `pnpm pack:dry-run` | Inspect package contents | Docs/exports/files changes |

Live E2E uses external marketplace/GitHub state. Do not report it as offline success when network or authentication is unavailable.

## 2. Documentation ownership

| Document | Canonical responsibility | Update trigger |
| --- | --- | --- |
| [README](../README.en.md) | Value, install, one quick start, outcome boundary, navigation | Version, install command, baseline, or entry change |
| [User Guide](user-guide.en.md) | Observable workflow, choices, outcomes, recovery, uninstall | User action/UI/result semantics change |
| This guide | Local development, code map, tests, debugging, contribution | Scripts, layout, development/release flow change |
| [Architecture](architecture.md) | Policy, state machine, data layout, runtime seams | Contract, graph, storage, or injection change |
| [Security Model](security.md) | Trust, install, verification, and cleanup invariants | Permission/review/verification/removal boundary change |
| [Real-world Samples](real-world-samples.md) | Fixtures, evidence levels, cleanup ownership | Scenario or authoritative evidence change |

Keep one canonical procedure. Other files should summarize and link. Never turn `real-live-passed`, `implemented`, or `planned` into a broader product guarantee.

## 3. Repository layout

```text
src/
├─ index.ts                    # Cordis/DSH entry and service composition
├─ config.ts                   # Public config schema/defaults
├─ contracts.ts                # Policy V8 contracts and receipts
├─ workflow/                   # Graph engine, lifecycle mapping, Agent view
├─ resolver/                   # Intent, local/installed source, lineage, profile ownership
├─ discovery/                  # find_dsh_plugin dispatch and normalization
├─ review/                     # Exact snapshot and mechanical review facts
├─ lifecycle/                  # install, snapshot, launcher, remove, recovery
├─ source-manager.ts           # Managed Git source, lock, commit, source receipt
├─ creation-guard.ts           # Fresh turn/session/boot/interrupt binding
├─ execution-guard.ts          # Tool-execution authorization
└─ host-verification-driver.ts # Three Host verification layers

presets/evolution/             # Managed Capability Evolution user preset
skills/autoevo-plugin-creator/ # Packaged guidance/reference, not enforcement
tests/unit/                    # Contracts, state, fail-closed regression
tests/integration/             # Managed create/modify/evolve flows
tests/*.mjs                    # Loader, package, and E2E acceptance
lib/                           # Generated, tracked, and published output
```

Do not edit `lib/` directly. Change `src/`, run `pnpm build`, and review/include the generated diff.

## 4. Runtime entry

The package is ESM. Default runtime is `lib/index.js` from `src/index.ts`; subpath exports expose `./evolution-mode` and `./verification-observer`. `cordis.patch.yml` mounts `id: autoevo` and supplies `dshHome` / `stateDir`.

`apply()` normalizes config; creates `StateStore`, the command runner, `CreationGuard`, `ExecutionGuard`, and `CapabilityEvolutionService`; materializes `presets/evolution`; installs policy and execution hooks; and registers `capability_workflow*` plus `plugin_remove`.

Prompts and presets are guidance, not authorization. Enforcement comes from persisted receipts, fresh-turn guards, execution guards, ActionCommitment/ExecutionLease, and one-time DSH approval.

## 5. Workflow and two gates

Policy is V8. Persisted decisions, reviews, commitments, and leases from another policy fail closed and require new discovery.

```text
resolve
  ↓ model-controlled bounded discovery/refinement
sealed 1–5 candidate shortlist
  ↓ Gate 1: fresh user candidate selection
exact source review
  ↓ Gate 2: fresh structured decision
commitment / lease / one-time DSH approval
  ↓
reuse | install | managed modify/create | stop
  ↓
Host verification / recovery / receipt
```

Internal graph cursors are not public lifecycle states. The model sees `AgentWorkflowViewV2`: bounded facts, budgets, candidate-scoped actions, and legal tools. It cannot supply trusted repository paths, review IDs, or install specs.

Gate 1 accepts only candidates sealed by `capability_workflow_present`. Gate 2 must use a fresh real user turn after review. DSH approval authorizes one side effect but never replaces either gate.

## 6. Resolver and lineage

Resolution is local-first: Agent-visible tools, skills, bridges, then `find_dsh_plugin`. Finder text is untrusted; only strict GitHub identities and bounded summaries enter the pool.

Live profile ownership—not inventory—is authoritative for installed sources. Replacement is limited to `github_exact` and receipt-owned `owned_chain`. Historical `failed_install` / `reviewed_snapshot` entries that are absent or removed become a first install after full revalidation and re-freeze; never relax live-spec drift protection to force replacement.

`src/resolver/lineage.ts` and `SourceManager.validateCompletedSnapshot()` bind receipt, path, repository, base commit, review/artifact hashes, clean Git state/config/hooks, and workspace containment.

## 7. Managed source lifecycle

Default source root is `<workspace>/.autoevo/sources/`. Construction stays visible in the parent Capability Evolution session:

1. Clone an exact commit or create a scaffold.
2. Persist the source receipt and acquire the workflow lock.
3. `prepareModify()` / `prepareCreate()` publish `pendingPath` and a WorkOrder.
4. The current session edits and checks only within the managed source.
5. `finish_managed_work` triggers Host Git/worktree/config validation.
6. Host commits with hooks/signing disabled.
7. Re-review, freeze, and package an owned immutable tgz.
8. Release the lock or enter installation.

Runtime does not create child Agents. `src/managed-child.ts` is a legacy compatibility surface whose `run()` rejects the old path; do not expose it as an extension API.

Cancellation uses an independent bounded cleanup lifetime, checkpoints bounded edits, validates state, and releases locks. Do not collapse cancel, timeout, and executable lookup failure.

## 8. Data and configuration

```text
<workspace>/.autoevo/sources/<source-id>/

<dshHome>/autoevo/
├─ resolutions/  reviews/  workflows/  installations/
├─ source-control/  artifacts/  trials/
└─ verifications/
```

`StateStore` writes with same-directory temporary files and atomic rename. Persist a provisional installation before profile mutation; on final-write failure preserve a recovery anchor or compensate owned temporary state.

| Config | Default / purpose |
| --- | --- |
| `dshHome` | `DSH_HOME` or local `.dsh` |
| `stateDir` | `<dshHome>/autoevo` |
| `sourceDir` | `<workspace>/.autoevo/sources` when omitted |
| `ghCommand`, `gitCommand`, `dshCommand` | Executable names |
| `dshCommandArgs` | Fixed extra DSH args |
| `maxCandidates` | 1–20, default 20 |
| `maxFiles` | 4–200, default 80 |
| `maxRepositoryBytes` | 64 KiB–8 MiB, default 1 MiB |
| `commandTimeoutMs` | 1–300 seconds, default 30 seconds |
| `forwardedCredentialEnv` | Credential environment-variable names, never values |
| `verificationPatchPaths` | Additional absolute verification patch paths |
| `evolutionPreset` | Default `true`; `false` never auto-deletes |

## 9. Review, install, and verification

Review receipts bind policy, requirement, exact source, inspected hashes, manifest facts, actual DSH runtime, and compatibility. Installation re-reviews materials before mutation.

Persistent install materializes and rechecks an owned snapshot/tgz, obtains one-time approval, writes a provisional receipt, preflights the exact reviewed bundle in isolated headless Loader state, mutates and reconciles the target profile, performs Host verification and hot-load, then writes a final or recovery receipt.

| Layer | Outcome | Valid claim |
| --- | --- | --- |
| `tool_roundtrip` | `verified` | Every expected tool executed and returned successfully |
| `bundle_activation` | `activated` | Reviewed Loader/Fiber settled |
| persistent `manual_runtime` | `awaiting_user_test` | Installed; a real client/profile test is pending |

`loaded` means destination-process bundle load. Isolated preflight is recorded separately. Semantic verification and `taskResultMatchedExpectation` cannot mint `verified`.

## 10. Test matrix

| Area | Primary tests |
| --- | --- |
| Gates, fresh turns, replay | `confirmation-gates.spec.ts`, `workflow-engine.spec.ts` |
| Execution enforcement | `creation-guard.spec.ts`, `execution-boundaries.spec.ts` |
| Ownership and lineage | `lineage.spec.ts`, `profile-resolver.spec.ts`, `source-manager.spec.ts` |
| Install/replacement/recovery | `install-outcomes.spec.ts` |
| Host verification layers | `host-verification-driver.spec.ts`, `workflow-lifecycle.spec.ts` |
| Managed create/modify/evolve | `tests/integration/managed-*.spec.ts` |
| Cordis load | `tests/loader-smoke.mjs` |
| Packed runtime | `tests/packaged-acceptance.mjs` |
| Local/adversarial/market E2E | `tests/e2e-runner.mjs` |
| Documentation contracts | `tests/unit/documentation.spec.ts` |

Start with the narrowest regression, then run `pnpm check:fast`. Workflow/profile/package/Loader changes should run at least `pnpm check`; release candidates run `pnpm check:release`.

## 11. Debug real DSH failures

Inspect persisted facts before model summaries: workflow, review, installation, source-control receipt, target profile manifest, and Loader-visible target. Distinguish exact install state/outcome, verification layer, live loading, and functional roundtrip.

HTTP 200 proves only that a Web service is reachable. It does not prove AutoEvo tools loaded or a target capability worked. `dsh --profile web --help` may enter profile preparation and write state; do not assume it is read-only.

## 12. Contribution and release

Preserve user changes and record owned paths; run proportionate checks; rebuild/review `lib/`; update the canonical documentation owner; scan diffs for secrets/local/private data; run `git diff --check`; inspect pack contents; and run `pnpm check:release` for a release candidate.

CI verifies gates but does not publish a release. Commit, push, tag, publish, and upstream PR are separate maintainer-authorized actions. `contributionAdvice.eligible` is advice eligibility, not publication authority.

## References

- [Architecture](architecture.md) (Chinese)
- [Security Model](security.md) (Chinese)
- [User Guide](user-guide.en.md)
- [Real-world Samples](real-world-samples.md) (Chinese)
- `src/index.ts`
- `src/contracts.ts`
- `src/workflow/engine.ts`
- `src/lifecycle/install.ts`
- `src/source-manager.ts`
