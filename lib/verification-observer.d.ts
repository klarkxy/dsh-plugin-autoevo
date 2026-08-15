import Schema from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";
//#region src/verification-observer.d.ts
interface Config {
  receiptPath: string;
  expectedTools: string[];
  expectedText?: string;
}
declare const Config: Schema<Config>;
declare const name = "dsh-plugin-autoevo-verification-observer";
declare const inject: string[];
/**
 * Trusted verification-only observer. It records call identity and outcome,
 * never tool arguments, result content, environment values, or model text.
 */
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { Config, apply, inject, name };
//# sourceMappingURL=verification-observer.d.ts.map