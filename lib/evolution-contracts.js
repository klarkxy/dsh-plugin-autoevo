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
const EVOLUTION_PRESET_MANAGED_CONTENT_FILES = ["preset.yml", "agent.cordis.yml"];
/**
* Exact manifests that AutoEvo itself has shipped and may therefore upgrade.
*
* The on-disk manifest is only an integrity record, not an authority token:
* a user can rewrite both content and hashes.  Keep this allowlist in the
* package so an altered manifest is preserved instead of being upgraded over.
*
* Includes historical pristine v1–v7 shapes plus compatibility releases.
* Current V8 on-disk hashes from this checkout were not added in the Policy V5
* pass; those installs stay preserved until the hashes are recorded.
*/
const EVOLUTION_PRESET_KNOWN_MANIFESTS = Object.freeze([
	Object.freeze({
		owner: EVOLUTION_MODE_OWNER,
		schemaVersion: 1,
		templateVersion: "1",
		files: Object.freeze({
			"agent.cordis.yml": "1998d90fcb17ab3ca0a43e831ade6fe1f4e9513fe9efbe6777e00c417963edb5",
			"preset.yml": "6a571f49983f3c3bdde1b70c4500a0594ecea5f67dad7a893895d2952dbda751"
		})
	}),
	Object.freeze({
		owner: EVOLUTION_MODE_OWNER,
		schemaVersion: 1,
		templateVersion: "1",
		files: Object.freeze({
			"agent.cordis.yml": "9dfcbafa4f20267473c88c8a854f6ff0d400bf7a7a55f9cac3f5e35faa136f0f",
			"preset.yml": "4e7c85c66dd5b22a46023b85f0f8d730ab9bb2933c31cee4b60246537488fc82"
		})
	}),
	Object.freeze({
		owner: EVOLUTION_MODE_OWNER,
		schemaVersion: 1,
		templateVersion: "2",
		files: Object.freeze({
			"agent.cordis.yml": "50815c246fb23c6dedee57069541771b5d9b8934a49d5b3b5a043a7af278add9",
			"preset.yml": "bad59239f10692dbe91baac3e8eae13ba0492726c52d4420e6cc5e9f492c9334"
		})
	}),
	Object.freeze({
		owner: EVOLUTION_MODE_OWNER,
		schemaVersion: 1,
		templateVersion: "3",
		files: Object.freeze({
			"agent.cordis.yml": "488bf1f349435b969967fc4c78c56d0951082ba8519027039fabe570fdf25a3a",
			"preset.yml": "bad59239f10692dbe91baac3e8eae13ba0492726c52d4420e6cc5e9f492c9334"
		})
	}),
	Object.freeze({
		owner: EVOLUTION_MODE_OWNER,
		schemaVersion: 1,
		templateVersion: "4",
		files: Object.freeze({
			"agent.cordis.yml": "3e6f27a853b5c062f584214b6e4c322bdc3d3e1176e90c22a6f2c4ae9ac3596a",
			"preset.yml": "4e7c85c66dd5b22a46023b85f0f8d730ab9bb2933c31cee4b60246537488fc82"
		})
	}),
	Object.freeze({
		owner: EVOLUTION_MODE_OWNER,
		schemaVersion: 1,
		templateVersion: "5",
		files: Object.freeze({
			"agent.cordis.yml": "fbe6d39d435a072e31fdcd2985481cf4dcca517f68f80e6fabf10c5ec59876a1",
			"preset.yml": "daac55dc543b3ab749486292240ebd8a838b177e3b2048a7ef7dfdc542a822bd"
		})
	}),
	Object.freeze({
		owner: EVOLUTION_MODE_OWNER,
		schemaVersion: 1,
		templateVersion: "5",
		files: Object.freeze({
			"agent.cordis.yml": "56af4a141e74042b05bb10e4d0066b7d1cbb7ed701c7b845500014f2f6135f83",
			"preset.yml": "48ddb7f319f9f93705a901c2f6f95e8d303a153fc23517f2353529a4316d601e"
		})
	}),
	Object.freeze({
		owner: EVOLUTION_MODE_OWNER,
		schemaVersion: 1,
		templateVersion: "6",
		files: Object.freeze({
			"agent.cordis.yml": "219a29aa7c65432e722b505ef72c835cd455782c871d62fd71194259fb1dbd9d",
			"preset.yml": "daac55dc543b3ab749486292240ebd8a838b177e3b2048a7ef7dfdc542a822bd"
		})
	}),
	Object.freeze({
		owner: EVOLUTION_MODE_OWNER,
		schemaVersion: 1,
		templateVersion: "7",
		files: Object.freeze({
			"agent.cordis.yml": "8b0d426d5d1e0203625087f3f0b3f3d41f01b552259129622fa207c2cf5951c3",
			"preset.yml": "daac55dc543b3ab749486292240ebd8a838b177e3b2048a7ef7dfdc542a822bd"
		})
	}),
	Object.freeze({
		owner: EVOLUTION_MODE_OWNER,
		schemaVersion: 1,
		templateVersion: "7",
		files: Object.freeze({
			"agent.cordis.yml": "431053523105e7af9539d9944f486f8d239a8b752d4d748461167fc3795a2441",
			"preset.yml": "48ddb7f319f9f93705a901c2f6f95e8d303a153fc23517f2353529a4316d601e"
		})
	})
]);
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
	const expectedFiles = [...EVOLUTION_PRESET_MANAGED_CONTENT_FILES].sort((a, b) => a.localeCompare(b));
	const actualFiles = Object.keys(files).sort((a, b) => a.localeCompare(b));
	if (actualFiles.length !== expectedFiles.length) return false;
	if (actualFiles.some((key, index) => key !== expectedFiles[index])) return false;
	for (const [key, digest] of Object.entries(files)) {
		if (typeof key !== "string" || key.length === 0) return false;
		if (typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest)) return false;
	}
	return true;
}
/** Stable denial when cordis_define(kind:new) is attempted outside genuine evolution mode. */
const OUTSIDE_EVOLUTION_MODE_DENIAL = "AutoEvo denied new Cordis plugin creation: start or switch a blank/new session to the Capability Evolution (evolution) agent preset. Dynamic new Cordis definitions are not permitted on the parent session; create-new continues only in a managed git source child session after an explicit user decision.";
//#endregion
export { EVOLUTION_PRESET_MANAGED_CONTENT_FILES as a, createEvolutionModeMarker as c, EVOLUTION_PRESET_KNOWN_MANIFESTS as i, isEvolutionModeMarker as l, EVOLUTION_MODE_SERVICE_KEY as n, EVOLUTION_PRESET_MANIFEST_FILENAME as o, EVOLUTION_PRESET_ID as r, OUTSIDE_EVOLUTION_MODE_DENIAL as s, EVOLUTION_MODE_OWNER as t, isEvolutionPresetManifest as u };

//# sourceMappingURL=evolution-contracts.js.map