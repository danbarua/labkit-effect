/**
 * The folders under `src/` that hold the abstract layers: data and pure machines. `oxlint.config.ts`
 * applies the abstract-layer lint rules to each folder, and `scripts/check-brands.ts` checks the
 * schemas in each folder. Both read this list, so a renamed or added layer changes both checks.
 */
export const abstractLayers = ["agent-machine", "agent-environment", "agent-policy"] as const;

export type AbstractLayer = (typeof abstractLayers)[number];
