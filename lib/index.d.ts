import Schema from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";
import { Agent } from "@deepseek-ai/dsh-agent";
//#region src/config.d.ts
interface Config$1 {
  dshHome?: string;
  stateDir?: string;
  ghCommand?: string;
  gitCommand?: string;
  dshCommand?: string;
  dshCommandArgs?: string[];
  maxCandidates?: number;
  maxFiles?: number;
  maxRepositoryBytes?: number;
  commandTimeoutMs?: number;
  forwardedCredentialEnv?: string[];
  verificationPatchPaths?: string[];
  /** When true (default), materialize/upgrade the managed evolution user preset. Never auto-deletes. */
  evolutionPreset?: boolean;
}
declare const Config$1: Schema<Config$1>;
//#endregion
//#region src/index.d.ts
declare const name = "autoevo";
declare const inject: readonly ["tools", "skills", "subprocess", "systemPrompt"];
type Config = Config$1;
declare const Config: import("@deepseek-ai/schemastery").default<Config$1>;
declare function createIsEvolutionMode(ctx: Context): (agent: Agent) => boolean;
declare const _testing: {
  createIsEvolutionMode: typeof createIsEvolutionMode;
};
declare function apply(ctx: Context, input: Config): void;
//#endregion
export { Config, _testing, apply, inject, name };
//# sourceMappingURL=index.d.ts.map