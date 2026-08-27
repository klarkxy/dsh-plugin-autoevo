//#region src/evolution-contracts.ts
/**
* Shared Capability Evolution mode contracts.
* Owned by the top-level agent; leaves must import, not redefine or mutate.
*/
const EVOLUTION_PRESET_ID = "evolution";
/** Scoped Cordis service key published only behind a preset isolate realm. */
const EVOLUTION_MODE_SERVICE_KEY = "autoevoEvolutionMode";
/** Exact marker owner. Preset id alone is never authority. */
const EVOLUTION_MODE_OWNER = "dsh-plugin-autoevo";
/** Managed user-preset manifest filename under the evolution preset directory. */
const EVOLUTION_PRESET_MANIFEST_FILENAME = ".autoevo-preset.json";
/** Relative managed template files (posix style), excluding the generated manifest. */
const EVOLUTION_PRESET_MANAGED_CONTENT_FILES = [
	"preset.yml",
	"agent.cordis.yml",
	"skills/cordis-plugin-development/SKILL.md",
	"skills/editing-cordis-compositions/SKILL.md"
];
/**
* The one template this unreleased line owns.
*
* V13 is the last non-superset template. A pristine V13 install may upgrade
* to the current Creator-superset template. Anything else is preserved.
*/
const EVOLUTION_PRESET_V13_MANIFEST = Object.freeze({
	owner: EVOLUTION_MODE_OWNER,
	schemaVersion: 1,
	templateVersion: "13",
	files: Object.freeze({
		"agent.cordis.yml": "521d2133694c5642e3e78fcd5ddfa7f2d7af6eab80244fdd2c22030dd586d55c",
		"preset.yml": "d51f8ab85feeb76c73de0cb091735b7ddbdad4d2b3d8adfc878dd35b6e79bbbd"
	})
});
const EVOLUTION_PRESET_V14_MANIFEST = Object.freeze({
	owner: EVOLUTION_MODE_OWNER,
	schemaVersion: 1,
	templateVersion: "14",
	files: Object.freeze({
		"agent.cordis.yml": "0a1352f1dd4e68abf01a6c80f23be30aeb239294071207cc225815bfffa17c5b",
		"preset.yml": "c3e8587363b21edeba9c36e4009c8496c0938144f5c552e489ffda3b5316c4a4",
		"skills/cordis-plugin-development/SKILL.md": "01811d3ee9c03a466abae12d54d229e7de7bd74ca6b730c54ce9d5e696b294aa",
		"skills/editing-cordis-compositions/SKILL.md": "b223233e9df5c8cbedeb7dee8d38ddc47d545af54b323abe3830f4748b688f6c"
	})
});
const EVOLUTION_PRESET_KNOWN_MANIFESTS = Object.freeze([EVOLUTION_PRESET_V13_MANIFEST, EVOLUTION_PRESET_V14_MANIFEST]);
function createEvolutionModeMarker() {
	return {
		owner: EVOLUTION_MODE_OWNER,
		protocolVersion: 1
	};
}
function isEvolutionModeMarker(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value;
	const keys = Object.keys(record).sort((a, b) => a.localeCompare(b));
	if (keys.length !== 2 || keys[0] !== "owner" || keys[1] !== "protocolVersion") return false;
	return record.owner === "dsh-plugin-autoevo" && record.protocolVersion === 1;
}
function isEvolutionPresetManifest(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value;
	const expectedKeys = [
		"files",
		"owner",
		"schemaVersion",
		"templateVersion"
	];
	const actualKeys = Object.keys(record).sort((a, b) => a.localeCompare(b));
	if (actualKeys.length !== expectedKeys.length) return false;
	if (actualKeys.some((key, index) => key !== expectedKeys[index])) return false;
	if (record.owner !== "dsh-plugin-autoevo") return false;
	if (record.schemaVersion !== 1) return false;
	if (typeof record.templateVersion !== "string" || record.templateVersion.length === 0) return false;
	if (record.files === null || typeof record.files !== "object" || Array.isArray(record.files)) return false;
	const files = record.files;
	if (Object.keys(files).length === 0) return false;
	for (const [key, digest] of Object.entries(files)) {
		if (typeof key !== "string" || key.length === 0) return false;
		if (key.startsWith("/") || key.includes("\\") || key.split("/").some((part) => part === "" || part === "." || part === "..")) return false;
		if (typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest)) return false;
	}
	return true;
}
//#endregion
//#region src/evolution-mode.ts
const name = "autoevo-evolution-mode";
const inject = [];
const AUTOEVO_AUTONOMY_CONTRACT = `AutoEvo autonomy contract (runtime Policy V11): Capability Evolution is a Search-first governed preset. Every request for a new, reused, repaired, upgraded, modified, experimental, or supposedly temporary capability starts with capability_workflow before any direct or nested search, development, install, live mount, or model delegation. The model-supplied requirement is only a search summary; Host captures the latest top-level user message verbatim as the authoritative original requirement. If and only if a material ambiguity prevents useful search, supply one clarification_question when starting the workflow. Present that question and stop. A fresh top-level answer may resume with clarify_requirement and clarified_intent; it changes read-only search classification only and grants no selection, creation, modification, installation, or execution authority. Do not clarify twice. A new top-level requirement may supersede a workflow waiting for clarification.

Host performs local and remote read-only search. Present one to five real sealed candidates and stop; zero candidates is a valid result. With zero candidates, offer only continued search, creating a new capability, or stopping. Candidate review requires a fresh top-level selection and inspects only the selected fixed version. A later fresh top-level user message may choose to use it, modify it, create a new capability, search more, or stop. Creation after an empty result still requires that fresh final decision. Never treat a question-tool answer from the same turn as authority. Never expose machine identifiers or action enums in user-facing prose.

Public decisions never accept retention. Every adopted capability is persisted; the standard AutoEvo flow does not create a private preflight installation. Known-source repair or upgrade uses evolve_existing with target_name and does not rediscover an unrelated replacement. Host-bundled and unchanged local reuse remain read-only Host decisions as presented by the workflow.

The parent session may use Cordis inspect and safe cordis_stop, plus ordinary workspace file editing outside protected Host/profile/managed roots. It must not call Cordis define, run, mount, undefine, or unmount; load cordis-plugin-development; call find_dsh_plugin directly or through a bridge; mutate plugins through tools or shell; invoke ordinary subagent, agent, workflow, or model delegation; or use shell commands outside the read-only allowlist. Files created outside a Host-bound managed construction root cannot become install, mount, or managed-source inputs.

Before a long authorized modify, create, or install call, send one short natural-language acknowledgement of the coarse activity and that it may take several minutes; this is not an extra approval gate. After a valid Gate-2 create or modify decision, Host binds this workflow, user turn, boot identity, and one managed source root. Only then may a Host-owned managed child use its bounded filesystem, shell, build, test, and skill surface inside that root. Dependency mutation, nested collaboration, Git writes, plugin mutation, publication/release/deploy, and out-of-root filesystem writes remain denied; Host alone performs commit, final installation, and internal verification. DSH owns workspace sandboxing and tool permissions. Claim verified only from a Host tool-roundtrip pass; activated is not verified, and awaiting_user_test requires a real-client user test. Pre-V11 unfinished workflows and their grants are non-executable; start again from the current top-level requirement. Completed persistent installations and historical temporary receipts remain readable and explicitly removable.`;
function apply(ctx) {
	ctx.provide(EVOLUTION_MODE_SERVICE_KEY, createEvolutionModeMarker());
}
function readEvolutionModeMarker(ctx) {
	const value = ctx.get(EVOLUTION_MODE_SERVICE_KEY);
	return isEvolutionModeMarker(value) ? value : void 0;
}
//#endregion
export { readEvolutionModeMarker as a, EVOLUTION_PRESET_ID as c, EVOLUTION_PRESET_MANIFEST_FILENAME as d, isEvolutionModeMarker as f, name as i, EVOLUTION_PRESET_KNOWN_MANIFESTS as l, apply as n, EVOLUTION_MODE_OWNER as o, isEvolutionPresetManifest as p, inject as r, EVOLUTION_MODE_SERVICE_KEY as s, AUTOEVO_AUTONOMY_CONTRACT as t, EVOLUTION_PRESET_MANAGED_CONTENT_FILES as u };

//# sourceMappingURL=evolution-mode2.js.map