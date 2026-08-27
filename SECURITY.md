# Security and responsibility boundary

AutoEvo is a workflow plugin, not a sandbox or package-security engine. It binds discovery, review, a fresh user choice, and installation evidence to the same source and target. DSH Core remains responsible for tool permissions, workspace isolation, side-effect approval, and process execution.

AutoEvo reports lifecycle scripts, process, network, filesystem, compatibility, license, and code-risk observations as warnings. A warning is not proof that a package is safe or unsafe. If DSH permits the operation, a user may accept those warnings after reading the review summary.

AutoEvo blocks only low-cost mechanical errors that would make it act on the wrong or unidentifiable object, such as an invalid package identity, a source/install-spec mismatch, an unusable manifest, an incomplete snapshot, or an obvious unsupported path entry. It does not claim complete protection from third-party code.

## Reporting a vulnerability

Please use the repository's private GitHub security-advisory channel when available. Otherwise open a minimal issue asking for a private contact without including secrets, exploit payloads, user paths, tokens, receipts, or private source.

Include the affected AutoEvo version, DSH version, operating system, a redacted reproduction, the expected boundary, and the observed behavior. Do not upload complete state directories or raw stderr containing local information.

## Supported release

Security fixes target the latest stable GitHub Release. Published tags are immutable; a serious defect is fixed forward in a new patch release. npm publication is not an AutoEvo distribution channel.
