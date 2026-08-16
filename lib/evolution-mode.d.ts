import { Context } from "@deepseek-ai/cordis";
//#region src/evolution-contracts.d.ts
/** Exact marker owner. Preset id alone is never authority. */
declare const EVOLUTION_MODE_OWNER: "dsh-plugin-autoevo";
/** Integer protocol version for the evolution-mode marker payload. */
declare const EVOLUTION_MODE_PROTOCOL_VERSION: 1;
interface EvolutionModeMarker {
  owner: typeof EVOLUTION_MODE_OWNER;
  protocolVersion: typeof EVOLUTION_MODE_PROTOCOL_VERSION;
}
//#endregion
//#region src/evolution-mode.d.ts
declare const name = "autoevo-evolution-mode";
declare const inject: readonly ["skills", "systemPrompt"];
declare function apply(ctx: Context): void;
declare function readEvolutionModeMarker(ctx: Context): EvolutionModeMarker | undefined;
//#endregion
export { apply, inject, name, readEvolutionModeMarker };
//# sourceMappingURL=evolution-mode.d.ts.map