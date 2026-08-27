# AutoEvo Developer Guide

English | [中文](developer-guide.md) · [Back to README](../README.en.md)

This guide is for maintainers who change AutoEvo Host seams, workflow behavior, managed-source evolution, install verification, or repository tooling. Policy/state and security invariants remain canonical in [Architecture](architecture.md) and the [Security Model](security.md).

## 1. Local environment

- Node.js `^22.19.0 || ^24.0.0`; CI covers both supported major lines.
- pnpm; CI currently uses `10.29.2`.
- Git; live GitHub discovery and review also require GitHub CLI.
- Host DSH CLI for packaged acceptance and E2E must not be a repo-root dependency — `npx @deepseek-ai/dsh` would then shadow the real CLI. CI installs the exact acceptance baseline `@deepseek-ai/dsh@0.1.1-rc.2` in runner-temp and points `DSH_PACKAGE_ROOT` there; it never rewrites the repository `package.json` or `pnpm-lock.yaml`. Locally, any DSH in `>=0.1.0-rc.6 <0.2.0` may be exercised, but release evidence must record the actual version.
- Windows/PowerShell is fully supported and the primary exercised environment. Linux/macOS promise build/import smoke only, not the complete DSH workflow, profile, or E2E path. Core execution uses argv runners and must not depend on interactive shell state.

```powershell
pnpm install --frozen-lockfile
pnpm check
```

| Command | Coverage | Use |
| --- | --- | --- |
| `pnpm lint` | Flat config `eslint.config.mjs`, `eslint src tests`; parse-level check for TS and `tests/**/*.mjs` | Fast source check |
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

Keep one canonical procedure. Other files should summarize and link.

## 3. Repository layout

```text
src/
├─ index.ts                    # Cordis/DSH entry and service composition
├─ config.ts                   # Public config schema/defaults
├─ contracts.ts                # Policy V11 contracts and receipts
├─ service.ts                  # CapabilityEvolutionService composition; split into the service-*.ts below
├─ service-resolution.ts       # Resolution, candidate pool, authorization flow
├─ service-review.ts           # Review orchestration and revalidation
├─ service-modification.ts     # Modification blockers and WorkOrder derivation
├─ service-semantic-review.ts  # Independent semantic reviewer orchestration
├─ service-managed-work.ts     # Managed create/modify execution and receipts
├─ semantic-host.ts            # Semantic session Host wiring and input validation
├─ internal-utils.ts           # Shared helpers (type guards, path containment)
├─ workflow/                   # Graph engine, lifecycle mapping, Agent view
├─ resolver/                   # Intent, local/installed source, lineage, profile ownership
├─ discovery/                  # scoped GitHub discovery and normalization
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
tests/helpers/                 # Shared fixtures (temp dirs, runtime config, records)
tests/*.mjs                    # Loader, package, and E2E acceptance
lib/                           # Generated, tracked, and published output
```

`src/workflow/engine.ts` is now a thin façade; the implementation is split across the `engine-core.ts` → `engine-driver.ts` → `engine-recovery.ts` → `engine-resume.ts` inheritance chain, with candidate snapshots in `candidates.ts` and selection receipt / commitment / lease minting in `grants.ts`.

Do not edit `lib/` directly. Change `src/`, run `pnpm build`, and review/include the generated diff.

## 4. Runtime entry

The package is ESM:

- Default entry: `lib/index.js`, from `src/index.ts`.
- Subpath exports: `./evolution-mode`, `./verification-observer`.
- `cordis.patch.yml` mounts the bundle as `id: autoevo` and passes `dshHome` / `stateDir`.

`apply()` is responsible for:

1. Normalizing `Config`;
2. Creating the `StateStore`, runner, `CreationGuard`, `ExecutionGuard`, and `CapabilityEvolutionService`;
3. Safely materializing `presets/evolution`;
4. Installing the fixed reuse policy and tool-execution hooks;
5. Registering `capability_workflow*`, `capability_versions` / `capability_rollback` / `capability_adopt` / `capability_updates`, and `plugin_remove`.

Prompts and presets are guidance, not authorization. AutoEvo receipts, fresh-turn bindings, and execution guards provide workflow consistency and evidence; DSH Core actually enforces permissions, sandboxes, and `allowed-once` approval. Never treat an AutoEvo warning, receipt, or status as DSH authorization, or a warning as an unacceptably hard block.

## 5. Workflow and two gates

Policy is V11. The state machine, both confirmation gates, and the lifecycle mapping are canonical in [Architecture](architecture.md#4-数据与状态) §4; this section only lists the boundaries developers most often trip over:

- Internal graph cursors are not public lifecycle states. The model only sees the versioned `AgentWorkflowViewV2`; never accept model-supplied repositories, review IDs, paths, or install specs — `use_this` / `modify_this` bind only candidate IDs from the sealed snapshot.
- Repeating resume within the same turn grants no new authorization; replay-protection failures do not consume the current valid interrupt.
- A DSH `allowed-once` approval authorizes one side effect; it never replaces Gate 1 or Gate 2.
- Selections, reviews, commitments, and leases from another policy version are never reused; the Host fails closed and requires new discovery.

## 6. Resolver and lineage

Resolution is local-first: Agent-visible tools, skills, bridges, then Host-owned `topic:dsh-plugin` GitHub search. Remote summaries are untrusted; only strict GitHub identities and bounded summaries enter the pool.

Installed sources must be resolved from live profile ownership, never inferred from local inventory alone. Replacement applies only to:

- `github_exact`: the profile genuinely depends on an exact GitHub SHA;
- `owned_chain`: an AutoEvo installation receipt proves the current install chain.

Historical `failed_install` / `reviewed_snapshot` entries whose state is `not_installed` or `removed` are treated as a first install after full revalidation, re-claim, re-review, and re-freeze; never relax `assertReplacementBinding()`'s live-spec drift protection.

`src/resolver/lineage.ts` and `SourceManager.validateCompletedSnapshot()` together prevent an arbitrary local review from impersonating a managed source: receipt, path, repository, base commit, review ID, artifact hash, clean HEAD/branch, Git config/hooks, and workspace containment must all match.

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

Cancellation or exceptions never reuse the cancelled signal for cleanup. The Host checkpoints bounded edits, validates state, and releases locks under an independent bounded lifetime; never misreport a cancel/timeout as a missing Git executable.

## 8. Data and configuration

The paths most often needed when debugging:

- `<workspace>/.autoevo/sources/<source-id>/`: managed source worktrees;
- `<dshHome>/autoevo/`: Host receipts (`resolutions/`, `reviews/`, `workflows/`, `installations/`, `source-control/`) plus `artifacts/`, `trials/`, and `verifications/`.

The full layout is canonical in [Architecture](architecture.md#4-数据与状态) §4. `StateStore` writes receipts with same-directory temporary files and atomic rename. Persist a provisional installation before any profile mutation; on final-write failure preserve a recovery anchor or compensate, never falsely report "not installed".

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

Install order in brief (full implementation in `src/lifecycle/install.ts`):

1. Validate the latest review, selection receipt, commitment/lease, and target profile; materialize the owned snapshot/tgz and recheck path, size, and hash;
2. Obtain one-time DSH approval, write a provisional receipt, mutate the target profile through the normal DSH install path, and reconcile the exact dependency against the visible package target;
3. Run Host verification and destination-process hot-load, then write the final receipt; failures land in `failed_absent` / `recovery_required`.

| Layer | Outcome | Valid claim |
| --- | --- | --- |
| `tool_roundtrip` | `verified` | Every expected tool executed and returned successfully |
| `bundle_activation` | `activated` | Reviewed Loader/Fiber settled |
| persistent `manual_runtime` | `awaiting_user_test` | Installed; a real client/profile test is pending |

`loaded` means destination-process bundle load. AutoEvo does not substitute a private preflight for live-profile evidence. Semantic verification and `taskResultMatchedExpectation` cannot mint `verified`.

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
| Packed runtime and isolation | `tests/packaged-acceptance.mjs` (validates docs/runtime resources and rejects test, snapshot, debug, and local-state residue) |
| Local/adversarial/marketplace E2E | `tests/e2e-runner.mjs` |
| Documentation contracts | `tests/unit/documentation.spec.ts` |

Start with the narrowest regression, then run `pnpm check:fast`. Workflow/profile/package/Loader changes should run at least `pnpm check`; release candidates run `pnpm check:release`.

## 11. Debug real DSH failures

Read persisted facts first; do not guess from model summaries:

```text
<dshHome>/autoevo/workflows/
<dshHome>/autoevo/reviews/
<dshHome>/autoevo/installations/
<dshHome>/autoevo/source-control/
<dshHome>/profiles/<profile>/package.json
```

Check in order:

| Step | What to inspect |
| --- | --- |
| 1 | workflow `status`, cursor, current interrupt, and failure |
| 2 | review exact source, policy, fit, risk, compatibility, and installSpec |
| 3 | installation `installState`, `installOutcome`, verification layer, `loaded`, `verified`, `restartRequired` |
| 4 | source receipt review/artifact hashes, `activeWorkflowId`, and Git state |
| 5 | live profile dependency spec and Loader-visible target |
| 6 | only then check whether the model misread the user decision |

HTTP 200 proves only that a Web service is reachable; it does not prove AutoEvo tools loaded, let alone that the target capability works. Real functional evidence requires seeing the target tool call/result.

`dsh --profile web --help` may enter profile preparation and write files; do not assume it is read-only diagnostics.

## 12. Contribution and release

Before committing:

1. Preserve existing user changes and declare the owned paths for this change;
2. Run tests proportionate to the change scope;
3. Rebuild and review `lib/` after source changes;
4. Update the canonical owner doc (user, developer, architecture, security, or samples);
5. Scan the diff for credentials, local paths, accounts, private addresses, and proprietary logic;
6. Run `git diff --check` and confirm no temporary artifacts slipped into the worktree;
7. At release time, sync the published tag in the install command across README.md, README.en.md, user-guide.md, and user-guide.en.md (`documentation.spec.ts` enforces consistency);
8. For a release candidate, run `pnpm check:release` and inspect pack contents.

CI verifies gates but does not publish a release. Distribution is GitHub-only: commit, push, tag, GitHub release, and upstream PR are separate maintainer-authorized actions, and CI never publishes to npm. `contributionAdvice.eligible` means a contribution can be suggested, not publication authority.

## References

- [Architecture](architecture.md) (Chinese)
- [Security Model](security.md) (Chinese)
- [User Guide](user-guide.en.md)
- `src/index.ts`
- `src/contracts.ts`
- `src/workflow/engine-core.ts` plus `engine-driver.ts` / `engine-recovery.ts` / `engine-resume.ts` (`engine.ts` is a thin façade)
- `src/lifecycle/install.ts`
- `src/source-manager.ts`
