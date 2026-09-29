import { recommended } from "@effect/tsgo/oxlint-presets";
import { defineConfig } from "oxlint";

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

export default defineConfig({
  ignorePatterns: ["repos/**"],
  extends: [recommended],
  jsPlugins: ["./scripts/oxlint/abstract-layers.js"],
  overrides: [
    {
      files: ["src/agent-core/**"],
      rules: {
        ...abstractLayer,
        "no-restricted-imports": [
          "error",
          {
            paths: [effectSchemaOnly],
            patterns: [{ group: ["*", "!effect", "!./*"], message: "agent-core imports only `Schema` from effect, and its own files." }],
          },
        ],
      },
    },
    {
      files: ["src/agent-policy/**"],
      rules: {
        ...abstractLayer,
        "no-restricted-imports": [
          "error",
          {
            paths: [effectSchemaOnly],
            patterns: [
              {
                group: ["*", "!effect", "!./*", "!../agent-core/*"],
                message: "agent-policy imports only `Schema` from effect, agent-core, and its own files.",
              },
            ],
          },
        ],
      },
    },
  ],
});
