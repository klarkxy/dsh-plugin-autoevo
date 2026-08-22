//#region src/evolution-contracts.d.ts
/**
 * Shared Capability Evolution mode contracts.
 * Owned by the top-level agent; leaves must import, not redefine or mutate.
 */
declare const EVOLUTION_PRESET_ID: "evolution";
/** Exact marker owner. Preset id alone is never authority. */
declare const EVOLUTION_MODE_OWNER: "dsh-plugin-autoevo";
/** Integer protocol version for the evolution-mode marker payload. */
declare const EVOLUTION_MODE_PROTOCOL_VERSION: 1;
interface EvolutionModeMarker {
  owner: typeof EVOLUTION_MODE_OWNER;
  protocolVersion: typeof EVOLUTION_MODE_PROTOCOL_VERSION;
}
//#endregion
export { EvolutionModeMarker as n, EVOLUTION_PRESET_ID as t };
//# sourceMappingURL=evolution-contracts.d.ts.map