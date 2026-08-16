import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
//#region src/evolution-contracts.ts
/**
* Shared Capability Evolution mode contracts.
* Owned by the top-level agent; leaves must import, not redefine or mutate.
*/
const EVOLUTION_PRESET_ID = "evolution";
const EVOLUTION_PRESET_DISPLAY_NAME = "能力进化";
/** Scoped Cordis service key published only behind a preset isolate realm. */
const EVOLUTION_MODE_SERVICE_KEY = "autoevoEvolutionMode";
/** Exact marker owner. Preset id alone is never authority. */
const EVOLUTION_MODE_OWNER = "dsh-plugin-autoevo";
/** Managed user-preset manifest filename under the evolution preset directory. */
const EVOLUTION_PRESET_MANIFEST_FILENAME = ".autoevo-preset.json";
/** Relative managed template files (posix style), excluding the generated manifest. */
const EVOLUTION_PRESET_MANAGED_CONTENT_FILES = ["preset.yml", "agent.cordis.yml"];
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
const OUTSIDE_EVOLUTION_MODE_DENIAL = "AutoEvo denied new Cordis plugin creation: start or switch a blank/new session to the 能力进化 (evolution) agent preset. Dynamic new Cordis definitions are permitted only in Capability Evolution mode after capability_resolve returns scratch_ready.";
//#endregion
//#region src/creator-skill.ts
const CREATOR_SKILL_NAME = "autoevo-plugin-creator";
const CREATOR_SKILL_PROVIDER = "dsh-plugin-autoevo";
const CREATOR_SKILL_MARKER = "autoevo-plugin-creator:v1";
const CREATOR_SKILL_DIRECTORY = fileURLToPath(new URL("../skills/autoevo-plugin-creator/", import.meta.url));
const CREATOR_SKILL_PATH = fileURLToPath(new URL("../skills/autoevo-plugin-creator/SKILL.md", import.meta.url));
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/u;
function parseCreatorSkill(raw) {
	const match = FRONTMATTER.exec(raw);
	if (!match) throw new Error(`AutoEvo bundled skill is missing valid frontmatter: ${CREATOR_SKILL_PATH}`);
	const metadata = parse(match[1]);
	if (metadata.name !== "autoevo-plugin-creator") throw new Error(`AutoEvo bundled skill must be named ${CREATOR_SKILL_NAME}`);
	if (typeof metadata.description !== "string" || metadata.description.trim().length === 0) throw new Error("AutoEvo bundled skill requires a non-empty description");
	const content = match[2].trim();
	if (!content.includes("autoevo-plugin-creator:v1")) throw new Error(`AutoEvo bundled skill is missing marker ${CREATOR_SKILL_MARKER}`);
	return {
		name: metadata.name,
		description: metadata.description.trim(),
		content
	};
}
function creatorSkillRegistration() {
	return {
		...parseCreatorSkill(readFileSync(CREATOR_SKILL_PATH, "utf8")),
		source: "runtime",
		provider: CREATOR_SKILL_PROVIDER,
		path: CREATOR_SKILL_PATH,
		resourceBase: {
			kind: "directory",
			path: CREATOR_SKILL_DIRECTORY
		}
	};
}
function registerCreatorSkill(ctx) {
	return ctx.skills.register(creatorSkillRegistration());
}
function isWorkflowSkill(name) {
	return name === "autoevo-plugin-creator" || name === "cordis-plugin-development";
}
//#endregion
export { EVOLUTION_MODE_SERVICE_KEY as a, EVOLUTION_PRESET_MANAGED_CONTENT_FILES as c, createEvolutionModeMarker as d, isEvolutionModeMarker as f, EVOLUTION_MODE_OWNER as i, EVOLUTION_PRESET_MANIFEST_FILENAME as l, isWorkflowSkill as n, EVOLUTION_PRESET_DISPLAY_NAME as o, isEvolutionPresetManifest as p, registerCreatorSkill as r, EVOLUTION_PRESET_ID as s, CREATOR_SKILL_NAME as t, OUTSIDE_EVOLUTION_MODE_DENIAL as u };

//# sourceMappingURL=creator-skill.js.map