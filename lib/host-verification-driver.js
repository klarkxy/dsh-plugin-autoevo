import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { assertSupportedJsonSchema, validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
//#region src/state/hashes.ts
function canonical(value) {
	if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError("Cannot hash a non-finite number");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== void 0).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
	throw new TypeError(`Cannot hash value of type ${typeof value}`);
}
function canonicalJson(value) {
	return canonical(value);
}
function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}
function hashObject(value) {
	return sha256(canonicalJson(value));
}
//#endregion
//#region src/contracts.ts
/** Receipt policy. New resolution/review/workflow records use this value. */
const POLICY_VERSION = "13";
const TOOL_NAMES = [
	"capability_workflow",
	"capability_workflow_resume",
	"capability_workflow_recover",
	"capability_versions",
	"capability_rollback",
	"capability_adopt",
	"capability_updates",
	"plugin_remove"
];
const DEFAULT_REQUEST_INTENT = {
	operation: "discover_or_reuse",
	requiredSurface: "any"
};
const VERIFICATION_LAYER_KINDS = [
	"bundle_activation",
	"tool_roundtrip",
	"manual_runtime"
];
const VERIFICATION_STATUSES = [
	"passed",
	"pending_user_test",
	"blocked_precondition",
	"failed",
	"uncertain"
];
function toolHasSafeFixture(tool, fixtures) {
	return fixtures.some((item) => item.tool === tool && item.available && item.safe && item.hostValidated);
}
function requiresManualRuntime(surface) {
	if (surface.clientPlatform) return true;
	if (surface.expectedRoute) return true;
	if (surface.credentialsDependency || surface.credentialsRegistered) return true;
	if (surface.networkSignal || surface.environmentSignal || surface.processSignal) return true;
	if (surface.skillOnly || surface.unsafeTools) return true;
	if (surface.llmDependency || surface.llmRegistered) return true;
	if (surface.toolFixtures.some((item) => item.available && !item.safe)) return true;
	if (surface.expectedTools.length === 0 && surface.expectedRoute) return true;
	return false;
}
/**
* Static classification. Risk signals and missing Host-validated fixtures only
* downgrade; a plugin declaration cannot mint `tool_roundtrip`.
*/
function classifyRuntimeSurface(surface) {
	if (requiresManualRuntime(surface)) return "manual_runtime";
	if (surface.expectedTools.length > 0) {
		if (surface.expectedTools.every((tool) => toolHasSafeFixture(tool, surface.toolFixtures))) return "tool_roundtrip";
		return "manual_runtime";
	}
	if (surface.kind === "bundle" && surface.truncated !== true) return "bundle_activation";
	return "manual_runtime";
}
const BRIDGE_EXECUTION_TOOLS = [
	"tool_search",
	"tool_describe",
	"tool_call"
];
const FORGED_RESUME_HOST_KEYS = [
	"selectionReceipt",
	"actionCommitment",
	"executionLease",
	"commitment",
	"lease",
	"endpoint",
	"reviewerVerdict",
	"verificationVerdict",
	"verifierVerdict",
	"verifierRequest"
];
const MAX_FIBER_NAME = 214;
const MAX_FIBER_ID = 128;
function record$1(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function boundedToken(value, max) {
	if (typeof value !== "string") return void 0;
	const token = value.normalize("NFKC").replace(/[\u0000-\u001f\u007f]+/gu, "").trim();
	if (!token || token.length > max) return void 0;
	return token;
}
function pushTarget(out, seen, row) {
	if (out.length >= 32) return;
	const rec = record$1(row);
	if (!rec) return;
	const name = boundedToken(rec.name, MAX_FIBER_NAME);
	if (!name) return;
	const id = boundedToken(rec.id, MAX_FIBER_ID);
	const key = `${id ?? ""}\0${name}`;
	if (!seen.has(key)) {
		seen.add(key);
		out.push(id ? {
			id,
			name
		} : { name });
	}
	if (rec.group === true && Array.isArray(rec.config)) for (const child of rec.config) {
		if (out.length >= 32) return;
		pushTarget(out, seen, child);
	}
}
/** Insert rows a Loader patch actually activates. Carrier bundles name another package. */
function activationTargetsFromPatch(patches) {
	if (!Array.isArray(patches)) return [];
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	for (const item of patches) {
		const patch = record$1(item);
		if (!patch || !Array.isArray(patch.insert)) continue;
		for (const row of patch.insert) {
			if (out.length >= 32) return out;
			pushTarget(out, seen, row);
		}
	}
	return out;
}
function parseActivatedFibersJson(value) {
	if (!value) return [];
	try {
		return activationTargetsFromPatch([{ insert: JSON.parse(value) }]);
	} catch {
		return [];
	}
}
function entryIdentity(entry) {
	const id = boundedToken(entry.options?.id, MAX_FIBER_ID) ?? boundedToken(entry.id, MAX_FIBER_ID);
	const name = boundedToken(entry.options?.name, MAX_FIBER_NAME) ?? boundedToken(entry.name, MAX_FIBER_NAME);
	return {
		...id ? { id } : {},
		...name ? { name } : {}
	};
}
function matchesTarget(entry, target) {
	const ident = entryIdentity(entry);
	if (ident.name !== target.name) return false;
	if (target.id) return ident.id === target.id;
	return Boolean(ident.name);
}
function matchesPackageName(entry, packageName) {
	const name = entryIdentity(entry).name;
	return name === packageName || Boolean(name?.endsWith(`/${packageName}`));
}
/**
* When the patch listed insert targets, every target must resolve.
* Otherwise fall back to a Fiber named after the npm package.
*/
function matchActivatedEntries(entries, input) {
	if (input.targets.length === 0) return entries.filter((entry) => matchesPackageName(entry, input.packageName));
	const matched = [];
	for (const target of input.targets) {
		const found = entries.find((entry) => matchesTarget(entry, target));
		if (!found) return [];
		matched.push(found);
	}
	return matched;
}
function flattenLoaderOptions(entries) {
	const out = [];
	const walk = (rows) => {
		for (const row of rows) {
			const rec = record$1(row);
			if (!rec) continue;
			const id = boundedToken(rec.id, MAX_FIBER_ID);
			const name = boundedToken(rec.name, MAX_FIBER_NAME);
			if (id || name) out.push({
				...id ? { id } : {},
				options: {
					...id ? { id } : {},
					...name ? { name } : {}
				}
			});
			if (rec.group === true && Array.isArray(rec.config)) walk(rec.config);
		}
	};
	walk(entries);
	return out;
}
//#endregion
//#region src/host-verification-driver.ts
const HOST_OVERLAY_ID_PREFIX = "autoevo-host-verification-";
/** OS/runtime keys a verification child may inherit. Credentials are never listed. */
const VERIFICATION_ENV_ALLOWLIST = [
	"PATH",
	"Path",
	"PATHEXT",
	"SystemRoot",
	"WINDIR",
	"ComSpec",
	"COMSPEC",
	"TMP",
	"TEMP",
	"TMPDIR",
	"HOME",
	"USERPROFILE",
	"HOMEDRIVE",
	"HOMEPATH",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"PROCESSOR_ARCHITECTURE",
	"NUMBER_OF_PROCESSORS"
];
function record(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function isPlainJson(value) {
	if (value === null || typeof value === "boolean" || typeof value === "string") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isPlainJson);
	const rec = record(value);
	if (!rec) return false;
	return Object.values(rec).every(isPlainJson);
}
/** Exact candidate namespace. Broad `dsh.fixtures` / `dsh.bundle.fixtures` are ignored. */
function declaredVerificationFixtures(dsh) {
	return record(record(record(dsh?.autoevo)?.verification)?.fixtures) ?? {};
}
function declaredVerificationFixturesFromPackage(pkg) {
	return declaredVerificationFixtures(record(record(pkg)?.dsh));
}
/**
* JSON arguments for Host execution. Candidate `safe:true` is never read as
* safety evidence and never becomes executable arguments by itself.
*/
function extractFixtureArguments(value) {
	const rec = record(value);
	if (!rec) return void 0;
	const args = record(rec.arguments);
	if (!args || !isPlainJson(args)) return void 0;
	return args;
}
/** Candidate risk/approval/safe flags are never Host attestation. Kept as an explicit untrusted probe. */
function inspectLoadedToolSafety(tool) {
	return {
		safe: false,
		reason: "loaded tool self-declared risk, approval, or package safe flags are not Host attestation"
	};
}
function argumentsMatchToolSchema(parameters, args) {
	try {
		assertSupportedJsonSchema(parameters);
	} catch {
		return false;
	}
	return validateJsonSchemaValue(parameters, args, "arguments").length === 0;
}
function emptyFacts(review) {
	const surface = review.runtimeSurface;
	const expectedTools = [...surface?.expectedTools ?? review.manifest.expectedTools];
	if (surface) return {
		...surface.clientPlatform ? { clientPlatform: surface.clientPlatform } : {},
		...surface.expectedRoute ? { expectedRoute: surface.expectedRoute } : {},
		llmDependency: surface.llmDependency,
		llmRegistered: surface.llmRegistered,
		credentialsDependency: surface.credentialsDependency,
		credentialsRegistered: surface.credentialsRegistered,
		networkSignal: surface.networkSignal,
		environmentSignal: surface.environmentSignal,
		processSignal: surface.processSignal,
		skillOnly: surface.skillOnly,
		unsafeTools: surface.unsafeTools,
		expectedTools,
		toolFixtures: surface.toolFixtures.map((item) => ({ ...item })),
		...surface.kind ? { kind: surface.kind } : {},
		...surface.truncated !== void 0 ? { truncated: surface.truncated } : {}
	};
	return {
		llmDependency: false,
		llmRegistered: Boolean(review.manifest.expectedRoute),
		credentialsDependency: false,
		credentialsRegistered: false,
		networkSignal: false,
		environmentSignal: false,
		processSignal: false,
		skillOnly: review.manifest.kind === "skill",
		unsafeTools: false,
		expectedTools,
		toolFixtures: expectedTools.map((tool) => ({
			tool,
			available: false,
			safe: false,
			hostValidated: false
		})),
		kind: review.manifest.kind
	};
}
function decideHostFixtures(input) {
	return input.expectedTools.map((tool) => {
		if (!Object.hasOwn(input.declared, tool)) return {
			tool,
			available: false,
			executable: false,
			safe: false,
			hostValidated: false,
			reason: "no namespaced fixture declaration"
		};
		const declared = input.declared[tool];
		if (!extractFixtureArguments(declared)) return {
			tool,
			available: true,
			executable: false,
			safe: false,
			hostValidated: false,
			reason: "declared fixture is not Host-executable JSON arguments"
		};
		return {
			tool,
			available: true,
			executable: true,
			safe: false,
			hostValidated: false,
			reason: "JSON arguments declared; safety is Host-derived at load time"
		};
	});
}
function fixtureDigestFor(fixtures) {
	return hashObject(fixtures.map((item) => ({
		tool: item.tool,
		arguments: item.arguments
	})));
}
function hostAttestedFixtures(facts, expectedTools) {
	return expectedTools.every((tool) => facts.toolFixtures.some((item) => item.tool === tool && item.available === true && item.safe === true && item.hostValidated === true));
}
/**
* Install-time layer selection. Risk signals only downgrade. Plugin-declared
* `safe:true` / `risk:'safe'` cannot mint tool_roundtrip. Authorization comes
* only from frozen Host-attested review fixtures plus namespaced JSON arguments.
*/
function selectInstallVerificationLayer(input) {
	const facts = emptyFacts(input.review);
	const expectedTools = [...facts.expectedTools];
	const classified = classifyRuntimeSurface(facts);
	if (classified === "manual_runtime") return {
		layer: "manual_runtime",
		reason: classifyRuntimeSurface({
			...facts,
			expectedTools: [],
			toolFixtures: [],
			unsafeTools: false
		}) === "manual_runtime" ? "Frozen runtime-surface risk requires a user test; Host will not spawn automatic verification." : "Frozen runtime-surface lacks Host-attested safe fixtures; plugin self-declared safety cannot mint tool_roundtrip.",
		fixtures: [],
		fixtureDigest: fixtureDigestFor([]),
		expectedTools
	};
	if (classified === "bundle_activation") return {
		layer: "bundle_activation",
		reason: "No expected tools; Host will load the exact reviewed bundle without an Agent turn.",
		fixtures: [],
		fixtureDigest: fixtureDigestFor([]),
		expectedTools
	};
	if (!hostAttestedFixtures(facts, expectedTools)) return {
		layer: "manual_runtime",
		reason: "Frozen runtime-surface lacks Host-attested safe fixtures; plugin self-declared safety cannot mint tool_roundtrip.",
		fixtures: [],
		fixtureDigest: fixtureDigestFor([]),
		expectedTools
	};
	const executable = decideHostFixtures({
		expectedTools,
		declared: input.declaredFixtures
	}).filter((item) => item.executable);
	const fixtures = executable.map((item) => ({
		tool: item.tool,
		arguments: extractFixtureArguments(input.declaredFixtures[item.tool]) ?? {}
	}));
	if (!expectedTools.every((tool) => executable.some((item) => item.tool === tool))) return {
		layer: "manual_runtime",
		reason: "Host-attested review cannot execute without namespaced JSON fixture arguments for every expected tool.",
		fixtures: [],
		fixtureDigest: fixtureDigestFor([]),
		expectedTools
	};
	return {
		layer: "tool_roundtrip",
		reason: "Host-attested fixtures and namespaced JSON arguments cover every expected tool.",
		fixtures,
		fixtureDigest: fixtureDigestFor(fixtures),
		expectedTools
	};
}
function redactReason(reason) {
	return reason.normalize("NFKC").replace(/[\u0000-\u001f\u007f]+/gu, " ").trim().slice(0, 400);
}
/** Installation receipt: layer/status, source match, tool names, counts, stable diagnostics. */
function sanitizeHostVerificationEvidence(input) {
	const evidence = {
		attempted: input.attempted,
		expectedTools: [...input.expectedTools].sort(),
		calledTools: [...input.calledTools ?? []].sort(),
		resultTools: [...input.resultTools ?? []].sort(),
		failedTools: [...input.failedTools ?? []].sort(),
		sessionFiles: [],
		taskResultObserved: false,
		layer: input.layer,
		status: input.status,
		reason: redactReason(input.reason)
	};
	if (input.exitCode !== void 0) evidence.exitCode = input.exitCode;
	if (input.sourceMatched !== void 0) evidence.sourceMatched = input.sourceMatched;
	if (input.fixtureDigest) evidence.fixtureDigest = input.fixtureDigest;
	if (input.launchEvidence) evidence.launchEvidence = {
		attempted: input.launchEvidence.attempted,
		processOutcome: input.launchEvidence.processOutcome,
		observerEventCount: input.launchEvidence.observerEventCount,
		...input.launchEvidence.exitCode !== void 0 ? { exitCode: input.launchEvidence.exitCode } : {},
		...input.launchEvidence.signal !== void 0 ? { signal: input.launchEvidence.signal } : {},
		...input.launchEvidence.failureClass ? { failureClass: input.launchEvidence.failureClass } : {},
		...input.launchEvidence.diagnosticHash ? { diagnosticHash: input.launchEvidence.diagnosticHash } : {}
	};
	return evidence;
}
function hostLayerSuccess(input) {
	const evidence = input.verification;
	if (!input.sourceMatched || evidence.layer !== input.layer || evidence.status !== "passed") return false;
	if (input.layer === "bundle_activation") return evidence.attempted === true && evidence.exitCode === 0;
	if (input.layer === "tool_roundtrip") {
		const expected = evidence.expectedTools;
		return expected.length > 0 && evidence.attempted === true && evidence.exitCode === 0 && expected.every((name) => evidence.calledTools.includes(name) && evidence.resultTools.includes(name) && !evidence.failedTools.includes(name));
	}
	return false;
}
function verificationChildEnv(dshHome, parent = process.env) {
	const env = {
		DSH_HOME: dshHome,
		DSH_TELEMETRY_DISABLED: "1"
	};
	for (const name of VERIFICATION_ENV_ALLOWLIST) {
		const value = parent[name];
		if (value !== void 0) env[name] = value;
	}
	return env;
}
function hostVerificationOverlay(input) {
	const fixtures = {};
	for (const item of input.fixtures) fixtures[item.tool] = item.arguments;
	return [{ insert: [{
		id: `${HOST_OVERLAY_ID_PREFIX}${randomUUID()}`,
		name: input.observerUrl,
		config: {
			receiptPath: input.receiptPath,
			expectedTools: [...input.expectedTools],
			layer: input.layer,
			packageName: input.packageName,
			fixtureDigest: input.fixtureDigest,
			fixturesJson: JSON.stringify(fixtures),
			activatedFibersJson: JSON.stringify(input.activatedFibers ?? [])
		}
	}] }];
}
function appendReceipt(receiptPath, event) {
	appendFileSync(receiptPath, `${JSON.stringify(event)}\n`, {
		encoding: "utf8",
		flag: "a"
	});
}
function parseFixturesJson(value) {
	if (!value) return {};
	try {
		const rec = record(JSON.parse(value));
		if (!rec) return {};
		const fixtures = {};
		for (const [tool, args] of Object.entries(rec)) {
			const body = record(args);
			if (body && isPlainJson(body)) fixtures[tool] = body;
		}
		return fixtures;
	} catch {
		return {};
	}
}
function contextLoader(ctx) {
	return ctx.loader;
}
function packageEntries(ctx, packageName, targets) {
	const loader = contextLoader(ctx);
	if (!loader || typeof loader.entries !== "function") return [];
	const localTree = (ctx.fiber?.entry)?.parent?.tree;
	return matchActivatedEntries(localTree && typeof localTree.entries === "function" ? [...localTree.entries()] : [...loader.entries()], {
		packageName,
		targets
	});
}
async function waitForLoader(ctx, packageName, targets) {
	if (!contextLoader(ctx)) return {
		stable: false,
		sourceMatched: false,
		reason: "Host child has no Loader service."
	};
	const matched = packageEntries(ctx, packageName, targets);
	if (matched.length === 0) return {
		stable: false,
		sourceMatched: false,
		reason: "Reviewed package Fiber was not present after Loader settle."
	};
	for (const entry of matched) {
		if (!entry.fiber && entry._initTask) await entry._initTask;
		if (!entry.fiber) return {
			stable: false,
			sourceMatched: false,
			reason: "Reviewed package entry has no Fiber."
		};
		await entry.fiber.await();
		if (entry.fiber.state !== 2) return {
			stable: false,
			sourceMatched: false,
			reason: "Reviewed package Fiber did not become ACTIVE."
		};
	}
	return {
		stable: true,
		sourceMatched: true,
		reason: "Host loaded the reviewed bundle and Loader/Fiber settled without an Agent turn."
	};
}
var OnceMap = class {
	seen = /* @__PURE__ */ new Set();
	take(digest) {
		if (this.seen.has(digest)) return false;
		this.seen.add(digest);
		return true;
	}
};
function loadedTool(ctx, name) {
	return ctx.tools?.get(name);
}
async function executeFixture(input) {
	if (!input.once.take(input.digest)) return {
		called: false,
		ok: false,
		reason: "Host refused to retry the same review/source/layer/fixture digest."
	};
	const tool = loadedTool(input.ctx, input.tool);
	if (!tool) return {
		called: false,
		ok: false,
		reason: "expected tool is not registered after Loader settle"
	};
	if (!argumentsMatchToolSchema(tool.parameters, input.args)) return {
		called: false,
		ok: false,
		reason: "fixture arguments do not match the loaded tool schema"
	};
	if ((await input.ctx.tools.execute({
		callId: `host-verify:${randomUUID()}`,
		name: input.tool,
		arguments: input.args,
		signal: input.signal
	})).isError) return {
		called: true,
		ok: false,
		reason: "Host tool execution returned an error result."
	};
	return {
		called: true,
		ok: true,
		reason: "Host executed the expected tool once through ToolRuntime.execute."
	};
}
async function runHostVerification(ctx, config, signal) {
	const expectedTools = [...config.expectedTools].sort();
	const once = new OnceMap();
	const calledTools = [];
	const resultTools = [];
	const failedTools = [];
	let executedCount = 0;
	if (config.layer === "manual_runtime") return {
		layer: "manual_runtime",
		status: "pending_user_test",
		sourceMatched: false,
		expectedTools,
		calledTools,
		resultTools,
		failedTools,
		executedCount: 0,
		reason: "manual_runtime must not start a Host verification subprocess.",
		exitCode: 0
	};
	const loader = await waitForLoader(ctx, config.packageName, parseActivatedFibersJson(config.activatedFibersJson));
	if (!loader.stable || !loader.sourceMatched) return {
		layer: config.layer,
		status: "failed",
		sourceMatched: false,
		expectedTools,
		calledTools,
		resultTools,
		failedTools,
		executedCount: 0,
		reason: loader.reason,
		exitCode: 1
	};
	if (config.layer === "bundle_activation") {
		if (expectedTools.length > 0 && expectedTools.some((name) => !loadedTool(ctx, name))) return {
			layer: "bundle_activation",
			status: "failed",
			sourceMatched: true,
			expectedTools,
			calledTools,
			resultTools,
			failedTools,
			executedCount: 0,
			reason: "Bundle Fiber settled, but an expected tool was not registered.",
			exitCode: 1
		};
		return {
			layer: "bundle_activation",
			status: "passed",
			sourceMatched: true,
			expectedTools,
			calledTools,
			resultTools,
			failedTools,
			executedCount: 0,
			reason: loader.reason,
			exitCode: 0
		};
	}
	const fixtures = parseFixturesJson(config.fixturesJson);
	for (const tool of expectedTools) {
		const args = fixtures[tool];
		if (!args) return {
			layer: config.layer,
			status: "failed",
			sourceMatched: true,
			expectedTools,
			calledTools,
			resultTools,
			failedTools,
			executedCount,
			reason: "Parent-selected tool_roundtrip is missing namespaced fixture arguments; Host will not execute.",
			exitCode: 1
		};
		const digest = hashObject({
			layer: "tool_roundtrip",
			fixtureDigest: config.fixtureDigest,
			tool,
			arguments: args
		});
		const outcome = await executeFixture({
			ctx,
			tool,
			args,
			signal: signal ?? AbortSignal.timeout(3e4),
			once,
			digest
		});
		if (!outcome.ok && !outcome.called) return {
			layer: config.layer,
			status: "failed",
			sourceMatched: true,
			expectedTools,
			calledTools,
			resultTools,
			failedTools,
			executedCount,
			reason: `${outcome.reason}; Host will not execute a missing or schema-invalid fixture.`,
			exitCode: 1
		};
		calledTools.push(tool);
		executedCount += 1;
		if (outcome.ok) resultTools.push(tool);
		else failedTools.push(tool);
	}
	if (failedTools.length > 0) return {
		layer: "tool_roundtrip",
		status: "failed",
		sourceMatched: true,
		expectedTools,
		calledTools,
		resultTools,
		failedTools,
		executedCount,
		reason: "Host tool execution failed; the same fixture digest will not be retried.",
		exitCode: 1
	};
	return {
		layer: "tool_roundtrip",
		status: "passed",
		sourceMatched: true,
		expectedTools,
		calledTools,
		resultTools,
		failedTools,
		executedCount,
		reason: `Host executed ${executedCount} expected tool(s) once through ToolRuntime.execute.`,
		exitCode: 0
	};
}
function requestExit(ctx, code, override) {
	if (override) {
		override(code);
		return;
	}
	const cmdline = ctx.get("cmdline");
	if (typeof cmdline?.exit === "function") {
		cmdline.exit(code);
		return;
	}
	process.exitCode = code;
	process.exit(code);
}
function applyHostVerification(ctx, config) {
	if (!path.isAbsolute(config.receiptPath)) throw new Error("verification receiptPath must be absolute");
	mkdirSync(path.dirname(config.receiptPath), { recursive: true });
	queueMicrotask(() => {
		(async () => {
			let result;
			try {
				result = await runHostVerification(ctx, config);
			} catch {
				result = {
					layer: config.layer,
					status: "uncertain",
					sourceMatched: false,
					expectedTools: [...config.expectedTools],
					calledTools: [],
					resultTools: [],
					failedTools: [],
					executedCount: 0,
					reason: "Host verification ended without a stable Loader/tool result; the child cause is unknown.",
					exitCode: 1
				};
			}
			try {
				appendReceipt(config.receiptPath, {
					kind: "host/complete",
					version: 1,
					layer: result.layer,
					status: result.status,
					sourceMatched: result.sourceMatched,
					expectedTools: result.expectedTools,
					calledTools: result.calledTools,
					resultTools: result.resultTools,
					failedTools: result.failedTools,
					executedCount: result.executedCount,
					reason: result.reason
				});
			} catch {}
			requestExit(ctx, result.exitCode, config.requestExit);
		})();
	});
}
//#endregion
export { sha256 as S, TOOL_NAMES as _, hostVerificationOverlay as a, classifyRuntimeSurface as b, selectInstallVerificationLayer as c, flattenLoaderOptions as d, matchActivatedEntries as f, POLICY_VERSION as g, FORGED_RESUME_HOST_KEYS as h, hostLayerSuccess as i, verificationChildEnv as l, DEFAULT_REQUEST_INTENT as m, declaredVerificationFixturesFromPackage as n, inspectLoadedToolSafety as o, BRIDGE_EXECUTION_TOOLS as p, fixtureDigestFor as r, sanitizeHostVerificationEvidence as s, applyHostVerification as t, activationTargetsFromPatch as u, VERIFICATION_LAYER_KINDS as v, hashObject as x, VERIFICATION_STATUSES as y };

//# sourceMappingURL=host-verification-driver.js.map