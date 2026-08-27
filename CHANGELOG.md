# Changelog

All notable changes to AutoEvo are documented here. AutoEvo follows Semantic Versioning for its public API and persisted Policy contract.

## 1.0.0

- Establish AutoEvo as a lightweight DSH capability discovery, review, and installation workflow.
- Preserve Search-first discovery and fresh user decisions while treating empty results and rejected shortlists as normal outcomes.
- Make semantic review advisory: installability is blocked only when the selected source or install target cannot be identified and installed correctly.
- Allow normal DSH-governed editing, builds, tests, dependency work, and collaboration after create or modify authorization.
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
