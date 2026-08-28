# AutoEvo Developer Guide

English | [中文](developer-guide.md) · [Back to README](../README.en.md)

This guide is for developers who maintain AutoEvo, extend its Host seams, fix workflows, or verify install semantics. The state machine and security invariants remain canonical in [Architecture](architecture.md) and the [Security Model](security.md).

## 1. Local environment

- Node.js `^22.19.0 || ^24.0.0`; CI covers both supported major lines.
- pnpm; CI currently uses `10.29.2`.
- Git; remote review and live GitHub discovery E2E also require GitHub CLI.
- Host DSH CLI for packaged acceptance and E2E must not be added as a repo-root dependency, or `npx @deepseek-ai/dsh` would resolve to a stale CLI. CI installs the acceptance baseline `@deepseek-ai/dsh@0.1.1-rc.2` (Cordis `4.0.1`) in a runner-temp directory and points `DSH_PACKAGE_ROOT` there; locally you may use any DSH in `>=0.1.0-rc.6 <0.2.0`, and release evidence must record the actual version.
- Windows / PowerShell is fully supported and is the primary tested environment. Linux / macOS only promise build and import smoke. Core execution uses argv runners and must not depend on interactive shell side effects.

Initialize and run the daily acceptance:

```powershell
pnpm install --frozen-lockfile
pnpm check
```

Common gates:

| Command | Coverage | When to use |
| --- | --- | --- |
| `pnpm lint` | Flat config `eslint.config.mjs`, `eslint src tests` | Quick syntax and rule check |
| `pnpm typecheck` | `tsc --noEmit` | Public types or contracts change |
| `pnpm test` | All Vitest unit and integration tests | Logic change |
| `pnpm build` | Rebuild `lib/` with tsdown | Source or exports change |
| `pnpm check:fast` | lint, typecheck, Vitest, build | Fast feedback gate before commit |
| `pnpm test:acceptance` | Loader smoke, packaged acceptance, local / adversarial offline E2E | Consolidated DSH runtime acceptance |
| `pnpm check` | `check:fast` plus `test:acceptance` | Complete daily integration gate |
| `pnpm check:release` | `check` plus live marketplace E2E and pack dry-run | Release candidate |
| `pnpm pack:dry-run` | Inspect release package contents | Docs, exports, or files change |

Live E2E touches external GitHub; it must not pretend to pass offline when network or auth is missing.

## 2. Documentation ownership

| Document | Canonical responsibility | Update trigger |
| --- | --- | --- |
| [README](../README.en.md) | Value, install, quick start, outcome boundary, navigation | Version, install command, minimum baseline, or entry change |
| [User Guide](user-guide.en.md) | User-observable workflow, choices, outcomes, recovery, uninstall | UI / behavior, user action, or result semantics change |
| This guide | Local development, code entry points, tests, debugging, contribution | Scripts, layout, development / release flow change |
| [Architecture](architecture.md) (Chinese) | State machine, data layout, runtime seams | Contract, storage, or injection change |
| [Security Model](security.md) (Chinese) | Trust boundary, install gate, verification and removal invariants | Permission, review, verification, cleanup boundary change |

Do not copy the full flow into multiple files. Other documents only keep a one-line summary and a link.

The interactive flow diagrams live in `docs/assets/flowcharts/` and ship in the release package. When a flow changes, edit the sibling `*.workflow.json` / `*.lifecycle.json` specification (English variants use the `-en` suffix), re-`deliver` the HTML with archify, then open the HTML in a browser and use Export → SVG to overwrite the matching `.svg`. Never hand-edit the HTML or SVG.

## 3. Repository layout

```text
src/
├─ index.ts                    # Cordis/DSH entry and service composition
├─ config.ts                   # Public config schema and defaults
├─ contracts.ts                # Policy V13 public contracts, review/install receipts
├─ service.ts                  # CapabilityEvolutionService composition; split into the service-*.ts below
├─ service-resolution.ts       # Resolution, candidate pool entry/exit, authorization flow
├─ service-review.ts           # Review orchestration and revalidation
├─ service-modification.ts     # Modification blockers and WorkOrder derivation
├─ service-semantic-review.ts  # Independent semantic reviewer orchestration
├─ service-managed-work.ts     # Managed create/modify execution and receipt
├─ semantic-host.ts            # Semantic session Host wiring and input validation
├─ internal-utils.ts           # Shared helpers (type guards, path containment)
├─ workflow/                   # Graph engine, lifecycle mapping, Agent view protocol
├─ resolver/                   # Local/installed sources, intent, lineage, profile ownership
├─ discovery/                  # Scoped GitHub discovery and normalization
├─ review/                     # Exact snapshot and mechanical review facts
├─ lifecycle/                  # install, snapshot, launcher, remove, recovery
├─ source-manager.ts           # Managed Git source, lock, commit, source receipt
├─ creation-guard.ts           # Fresh user turn, session/boot/interrupt binding
├─ execution-guard.ts          # Tool-execution authorization boundary
└─ host-verification-driver.ts # Three-layer Host verification selection and execution

presets/evolution/             # Managed Capability Evolution user preset
skills/autoevo-plugin-creator/ # Packaged Agent guidance and references, not an authorization boundary
tests/unit/                    # Contract, state, and fail-closed regressions
tests/integration/             # Managed create/modify/evolve closed loops
tests/helpers/                 # Shared test fixtures (temp dirs, runtime config, record builders)
tests/*.mjs                    # Loader, packaged, and E2E acceptance
lib/                           # Generated by tsdown, tracked and published
```

`src/workflow/engine.ts` is a thin façade; the engine implementation is split by inheritance chain into `engine-core.ts`, `engine-driver.ts`, `engine-recovery.ts`, `engine-resume.ts`, with candidate snapshots in `candidates.ts` and selection receipt / commitment / lease minting in `grants.ts`.

`lib/` is a generated directory, but the repo tracks and publishes it. Do not edit `lib/` directly; change `src/`, run `pnpm build`, and review the generated diff alongside the source change.

## 4. Runtime entry

The package is ESM. The default entry is `lib/index.js` (source `src/index.ts`); subpath exports are `./evolution-mode` and `./verification-observer`; `cordis.patch.yml` mounts the bundle as `id: autoevo` and passes `dshHome` / `stateDir`.

`apply()` is responsible for:

1. Normalizing `Config`;
2. Creating the `StateStore`, runner, `CreationGuard`, `ExecutionGuard`, and `CapabilityEvolutionService`;
3. Safely materializing `presets/evolution`;
4. Installing the fixed reuse policy and tool-execution hooks;
5. Registering `capability_workflow*`, `capability_versions` / `capability_rollback` / `capability_adopt` / `capability_updates`, and `plugin_remove`.

Prompts and presets are behavioral guidance, not authorization boundaries. AutoEvo's receipts, fresh-turn bindings, and execution guards only enforce workflow consistency and evidence; DSH Core actually enforces permissions, sandboxes, and `allowed-once` approval. Do not treat an AutoEvo warning, receipt, or status as DSH authorization, and do not treat a warning as a hard block either.

## 5. Workflow and the two confirmation gates

Policy is V13. The state machine, the two confirmation gates, and the lifecycle mapping are canonical in [Architecture §4](architecture.md#4-数据与状态); this section only lists the boundaries developers most often trip over:

- Internal graph cursor and public `lifecycleState` must not be mixed. The model only sees the versioned `AgentWorkflowViewV2`; never accept model-supplied repository, review ID, path, or install spec. `use_this` / `modify_this` only bind to candidate IDs from the sealed snapshot.
- Repeating resume within the same turn grants no new authorization; replay-protection failures do not consume the current valid interrupt.
- DSH `allowed-once` approval authorizes one side effect; it never replaces the two confirmation gates.
- Unfinished records (selection, review, commitment, lease) from a previous Policy version are never restored across versions; the Host fails closed and requires new discovery.

## 6. Resolver and source lineage

Resolution is local-first: Agent-visible tools, skills, bridge capabilities, then Host-owned `topic:dsh-plugin` GitHub search. Remote summaries are always untrusted. The Host validates strict repository identity and objective repository state, bounds and deduplicates the complete search union, and leaves semantic relevance to the Agent. Exact repositories are pinned; only the Agent-sealed 1–5 candidates receive bounded previews.

Installed sources must be resolved from live profile ownership, never inferred from local inventory alone. Replacement applies only to:

- `github_exact`: the profile genuinely depends on an exact GitHub SHA;
- `owned_chain`: an AutoEvo installation receipt proves the current install chain.

Historical `failed_install` / `reviewed_snapshot` entries whose state is `not_installed` or `removed` are treated as a first install after full revalidation, re-claim, re-review, and re-freeze; never relax `assertReplacementBinding()`'s live-spec drift protection.

`src/resolver/lineage.ts` and `SourceManager.validateCompletedSnapshot()` together prevent any local review from impersonating a managed source: receipt, path, repository, base commit, review ID, artifact hash, clean HEAD/branch, Git config/hooks, and workspace containment must all match.

## 7. Managed source lifecycle

[![AutoEvo managed construction workflow](assets/flowcharts/autoevo-managed-work-en.svg)](assets/flowcharts/autoevo-managed-work-en.html)

The default source root is `<workspace>/.autoevo/sources/`. The parent session owns decisions and progress while actual construction runs in a short-lived Host-owned child whose cwd is exactly the managed source:

1. The Host clones an exact GitHub commit or creates a scaffold;
2. Writes a sidecar source receipt and acquires the workflow exclusive lock;
3. `prepareModify()` / `prepareCreate()` set `pendingPath` and a structured WorkOrder;
4. The Host creates a child and verifies immutable cwd, the `workspace-write` root, parent ownership, the system Creator preset, and escape probes;
5. The child edits only inside the managed directory and runs bounded build/test checks, then returns its result to the Host;
6. The Host validates branch/HEAD, worktree, and Git config/hooks;
7. The Host creates a local commit with hooks and signing disabled;
8. Re-review, freeze the complete snapshot, and produce an owned tgz;
9. Release the lock or proceed to installation.

The parent never treats a synthetic cwd as confinement and never performs construction writes. The real write root comes from the child session's immutable cwd. The child is disposed after success or failure; decisions, re-review, installation, and publication authority remain with the Host/parent workflow.

Cancellation or exceptions never reuse the cancelled signal for cleanup. The Host checkpoints bounded edits, validates state, and releases locks under an independent bounded lifetime; never misreport a cancel/timeout as a missing Git executable.

## 8. Data and configuration

The paths most often needed when debugging:

- `<workspace>/.autoevo/sources/<source-id>/`: managed source worktree;
- `<dshHome>/autoevo/`: Host receipts (`resolutions/`, `reviews/`, `workflows/`, `installations/`, `source-control/`) plus `artifacts/`, `trials/`, `verifications/`.

The full layout is canonical in [Architecture §4](architecture.md#4-数据与状态). `StateStore` writes receipts with same-directory temporary files plus atomic rename. Persist a provisional installation before any profile mutation; on final-write failure preserve a recovery anchor or compensate and clean up, and never falsely report "not installed".

### `Config`

| Field | Default / purpose |
| --- | --- |
| `dshHome` | `DSH_HOME` or local `.dsh` |
| `stateDir` | `<dshHome>/autoevo`; Host receipts and artifacts |
| `sourceDir` | Current workspace `.autoevo/sources` when not set |
| `ghCommand` / `gitCommand` / `dshCommand` | Corresponding executable names |
| `dshCommandArgs` | Fixed extra arguments passed to DSH |
| `maxCandidates` | 1–20, default 20 |
| `maxFiles` | 4–200, default 80 |
| `maxRepositoryBytes` | 64 KiB–8 MiB, default 1 MiB |
| `commandTimeoutMs` | 1–300 seconds, default 30 seconds |
| `forwardedCredentialEnv` | Allowed credential environment-variable names, never values |
| `verificationPatchPaths` | Additional absolute verification patch paths |
| `evolutionPreset` | Default `true`; `false` only skips materialization, never auto-deletes |

Configuration boundary changes must be kept in sync with `src/config.ts`, the public types, the schema tests, and this guide.

## 9. Review, install, and verification

A review receipt binds Policy, requirement, exact source, inspected file hashes, manifest facts, actual DSH runtime, and compatibility. Installation re-reviews and compares materials before mutating.

Install order in brief (full implementation in `src/lifecycle/install.ts`):

1. Validate the latest review, selection receipt, commitment/lease, and target profile; materialize the owned snapshot/tgz and recheck path, size, and hash;
2. Obtain DSH `allowed-once` approval, write a provisional receipt, mutate the target profile through DSH's normal install path, and reconcile the exact dependency against the visible package target;
3. Run Host verification and destination-process hot-load, then write the final receipt; failures land in `failed_absent` / `recovery_required`.

The three verification layers are not interchangeable:

| Layer | Success outcome | Valid claim |
| --- | --- | --- |
| `tool_roundtrip` | `verified` | The Host executed every expected tool and got a successful return |
| `bundle_activation` | `activated` | The reviewed bundle's Loader/Fiber has settled |
| persistent `manual_runtime` | `awaiting_user_test` | Installed; a real client/profile test is pending |

`loaded` only means the destination-process bundle has been loaded. AutoEvo does not substitute a private preflight for live-profile evidence; the semantic verifier and `taskResultMatchedExpectation` cannot mint `verified`.

## 10. Test matrix

| Area | Primary tests |
| --- | --- |
| Two gates, fresh turn, replay protection | `tests/unit/confirmation-gates.spec.ts`, `workflow-engine.spec.ts` |
| Execution-layer rejection and parent-session scope | `creation-guard.spec.ts`, `execution-boundaries.spec.ts` |
| Source ownership and lineage | `lineage.spec.ts`, `profile-resolver.spec.ts`, `source-manager.spec.ts` |
| Install, replacement, reconciliation, recovery | `install-outcomes.spec.ts` |
| Three Host verification layers | `host-verification-driver.spec.ts`, `workflow-lifecycle.spec.ts` |
| Managed create/modify/upgrade | `tests/integration/managed-*.spec.ts` |
| Cordis load | `tests/loader-smoke.mjs` |
| Real package entry and isolation | `tests/packaged-acceptance.mjs` (validates docs/runtime resources and rejects test, snapshot, debug, and local-state residue) |
| Local / adversarial / marketplace E2E | `tests/e2e-runner.mjs` |
| Documentation navigation and key semantics | `tests/unit/documentation.spec.ts` |

For regression fixes, start with the narrowest test, then run `pnpm check:fast`; for workflow, profile, packaging, or Loader changes, at least run `pnpm check`. Release candidates run `pnpm check:release`.

## 11. Debug real DSH issues

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
| 2 | review exact source, Policy, fit, risk, compatibility, and installSpec |
| 3 | installation `installState`, `installOutcome`, verification layer, `loaded`, `verified`, `restartRequired` |
| 4 | source receipt review/artifact hashes, `activeWorkflowId`, and Git state |
| 5 | live profile dependency spec and Loader-visible target |
| 6 | Only then check whether the model misread the user decision |

HTTP 200 only proves a web service is reachable, not that the target capability works; real functional evidence requires seeing the target tool call/result.

Commands like `dsh --profile web --help` may enter profile preparation and write files; do not treat them as read-only diagnostics by default.

## 12. Contribution and release

Before committing:

1. Preserve existing user changes and declare the owned paths for this change;
2. Run tests proportionate to the change scope;
3. After source changes, rebuild and review `lib/`;
4. Update the corresponding user, developer, architecture, security, or sample documentation;
5. Scan the diff for credentials, local paths, accounts, private addresses, and proprietary logic;
6. Run `git diff --check` and confirm no temporary artifacts slipped into the worktree;
7. At release time, sync the published tag in the install command across README.md / README.en.md / user-guide.md / user-guide.en.md (`documentation.spec.ts` enforces consistency);
8. For a release candidate, run `pnpm check:release` and inspect pack contents.

Repository CI handles acceptance and does not create a release. Distribution is GitHub-only: commit, push, tag, GitHub release, and upstream PR are separate actions requiring explicit maintainer authorization, and CI never publishes to npm. The `contributionAdvice.eligible` flag in an installation receipt only means a contribution can be suggested, not publication authority.

## References

- [Architecture](architecture.md) (Chinese)
- [Security Model](security.md) (Chinese)
- [User Guide](user-guide.en.md)
- `src/index.ts`
- `src/contracts.ts`
- `src/workflow/engine-core.ts` plus `engine-driver.ts` / `engine-recovery.ts` / `engine-resume.ts` (`engine.ts` is a thin façade)
- `src/lifecycle/install.ts`
- `src/source-manager.ts`
