import Schema from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";
//#region src/verification-observer.d.ts
interface Config {
  receiptPath: string;
  expectedTools: string[];
  expectedText?: string;
  expectedProvider?: string;
  expectedModel?: string;
  layer?: string;
  packageName?: string;
  fixtureDigest?: string;
  fixturesJson?: string;
}
declare const Config: Schema<Config>;
declare const name = "dsh-plugin-autoevo-verification-observer";
declare const inject: string[];
/**
 * Trusted verification-only observer. It records call identity and outcome,
 * never tool arguments, result content, environment values, or model text.
 * When `layer` is a Host verification layer, this entry drives Loader/tool
 * execution instead of observing an Agent turn.
 */
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { Config, apply, inject, name };
//# sourceMappingURL=verification-observer.d.ts.map