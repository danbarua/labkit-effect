import { recommended } from "@effect/tsgo/oxlint-presets";
import { defineConfig } from "oxlint";
import { type AbstractLayer, abstractLayers } from "./scripts/abstract-layers.ts";

/** What the abstract layers are held to, beyond the Effect preset. */
const abstractLayer = {
  "abstract/no-let": "error",
  "abstract/no-loop": "error",
  "abstract/no-in-place-change": "error",
  "abstract/no-string-keyword": "error",
  "abstract/branded-schema-string": "error",
  "no-plusplus": "error",
} as const;

/** The only thing an abstract layer takes from `effect`. */
const effectSchemaOnly = { name: "effect", allowImportNames: ["Schema"], message: "The abstract layers import only `Schema` from effect." };

/** The modules each abstract layer may import, besides `Schema` from effect and its own files. */
const importsAllowed: Record<AbstractLayer, { readonly group: ReadonlyArray<string>; readonly message: string }> = {
  "agent-machine": { group: ["*", "!effect", "!./*"], message: "agent-machine imports only `Schema` from effect, and its own files." },
  "agent-policy": {
    group: ["*", "!effect", "!./*", "!../agent-machine/*"],
    message: "agent-policy imports only `Schema` from effect, agent-machine, and its own files.",
  },
};

export default defineConfig({
  ignorePatterns: ["repos/**"],
  extends: [recommended],
  jsPlugins: ["./scripts/oxlint/abstract-layers.js"],
  overrides: abstractLayers.map((layer) => ({
    files: [`src/${layer}/**`],
    excludeFiles: ["**/*.test.ts"],
    rules: {
      ...abstractLayer,
      "no-restricted-imports": ["error", { paths: [effectSchemaOnly], patterns: [{ group: [...importsAllowed[layer].group], message: importsAllowed[layer].message }] }],
    },
  })),
});
