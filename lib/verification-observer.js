import path from "node:path";
import Schema from "@deepseek-ai/schemastery";
import { appendFileSync, mkdirSync } from "node:fs";
//#region src/verification-observer.ts
const Config = Schema.object({
	receiptPath: Schema.string().required(),
	expectedTools: Schema.array(Schema.string()).default([])
});
const name = "dsh-plugin-autoevo-verification-observer";
const inject = ["tools"];
function appendReceipt(receiptPath, event) {
	appendFileSync(receiptPath, `${JSON.stringify(event)}\n`, {
		encoding: "utf8",
		flag: "a"
	});
}
/**
* Trusted verification-only observer. It records call identity and outcome,
* never tool arguments, result content, environment values, or model text.
*/
function apply(ctx, config) {
	if (!path.isAbsolute(config.receiptPath)) throw new Error("verification receiptPath must be absolute");
	const expected = new Set(config.expectedTools);
	mkdirSync(path.dirname(config.receiptPath), { recursive: true });
	ctx.on("tools/pre-execute", async (exec, next) => {
		if (expected.has(exec.name)) appendReceipt(config.receiptPath, {
			kind: "tool/call",
			callId: exec.callId,
			name: exec.name
		});
		return next();
	});
	ctx.on("tools/result", (exec, result) => {
		if (expected.has(exec.name)) appendReceipt(config.receiptPath, {
			kind: "tool/result",
			callId: exec.callId,
			name: exec.name,
			isError: result.isError
		});
	});
}
//#endregion
export { Config, apply, inject, name };

//# sourceMappingURL=verification-observer.js.map