import { t as applyHostVerification } from "./host-verification-driver.js";
import path from "node:path";
import Schema from "@deepseek-ai/schemastery";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
//#region src/verification-observer.ts
const Config = Schema.object({
	receiptPath: Schema.string().required(),
	expectedTools: Schema.array(Schema.string()).default([]),
	expectedText: Schema.string().default(""),
	expectedProvider: Schema.string().default(""),
	expectedModel: Schema.string().default(""),
	layer: Schema.string().default(""),
	packageName: Schema.string().default(""),
	fixtureDigest: Schema.string().default(""),
	fixturesJson: Schema.string().default(""),
	activatedFibersJson: Schema.string().default("")
});
const name = "dsh-plugin-autoevo-verification-observer";
const inject = ["tools", "sessions"];
function appendReceipt(receiptPath, event) {
	appendFileSync(receiptPath, `${JSON.stringify(event)}\n`, {
		encoding: "utf8",
		flag: "a"
	});
}
function hostLayer(value) {
	if (value === "bundle_activation" || value === "tool_roundtrip" || value === "manual_runtime") return value;
}
/**
* Trusted verification-only observer. It records call identity and outcome,
* never tool arguments, result content, environment values, or model text.
* When `layer` is a Host verification layer, this entry drives Loader/tool
* execution instead of observing an Agent turn.
*/
function apply(ctx, config) {
	const layer = hostLayer(config.layer);
	if (layer) {
		const driverConfig = {
			receiptPath: config.receiptPath,
			expectedTools: config.expectedTools,
			layer,
			packageName: config.packageName,
			fixtureDigest: config.fixtureDigest,
			...config.fixturesJson ? { fixturesJson: config.fixturesJson } : {},
			...config.activatedFibersJson ? { activatedFibersJson: config.activatedFibersJson } : {}
		};
		applyHostVerification(ctx, driverConfig);
		return;
	}
	if (!path.isAbsolute(config.receiptPath)) throw new Error("verification receiptPath must be absolute");
	const expected = new Set(config.expectedTools);
	const callSessions = /* @__PURE__ */ new Map();
	const successfulSessions = /* @__PURE__ */ new Set();
	const routes = /* @__PURE__ */ new Map();
	const finalByTurn = /* @__PURE__ */ new Map();
	mkdirSync(path.dirname(config.receiptPath), { recursive: true });
	ctx.on("tools/pre-execute", async (exec, next) => {
		if (expected.has(exec.name)) {
			if (exec.agent) callSessions.set(exec.callId, String(exec.agent.session.id));
			appendReceipt(config.receiptPath, {
				kind: "tool/call",
				callId: exec.callId,
				name: exec.name
			});
		}
		return next();
	});
	ctx.on("tools/result", (exec, result) => {
		if (expected.has(exec.name)) {
			const sessionId = callSessions.get(exec.callId);
			callSessions.delete(exec.callId);
			if (sessionId && result.isError === false) successfulSessions.add(sessionId);
			appendReceipt(config.receiptPath, {
				kind: "tool/result",
				callId: exec.callId,
				name: exec.name,
				isError: result.isError
			});
		}
	});
	ctx.on("session/event", (session, event) => {
		if (event.type === "request/context") {
			routes.set(String(session.id), {
				provider: event.data.provider,
				model: event.data.model
			});
			return;
		}
		if (event.type === "assistant/message") {
			if (expected.size > 0 && !successfulSessions.has(String(session.id))) return;
			const text = event.data.message.content.filter((block) => block.type === "text").map((block) => block.text).join("").trim();
			if (!text) return;
			finalByTurn.set(`${session.id}:${event.data.turn}`, {
				resultSha256: createHash("sha256").update(text).digest("hex"),
				...config.expectedText ? { matchedExpectation: text.includes(config.expectedText) } : {}
			});
			return;
		}
		if (event.type !== "turn/end") return;
		const turnKey = `${session.id}:${event.data.turn}`;
		const candidate = finalByTurn.get(turnKey);
		finalByTurn.delete(turnKey);
		if (event.data.reason.kind === "completed" && candidate) {
			const route = routes.get(String(session.id));
			appendReceipt(config.receiptPath, {
				kind: "task/result",
				...candidate,
				...route ? route : {}
			});
		}
	});
}
//#endregion
export { Config, apply, inject, name };

//# sourceMappingURL=verification-observer.js.map