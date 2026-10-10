import { strict } from "@effect/tsgo/oxlint-presets";
import { defineConfig, type OxlintOverride } from "oxlint";
import { type AbstractLayer, abstractLayers } from "./scripts/abstract-layers.ts";
import { nonNullAssertions, typeAssertions } from "./scripts/lint-exceptions.ts";

/** What the abstract layers are held to, beyond the Effect preset. */
const abstractLayer = {
  "abstract/no-let": "error",
  "abstract/no-loop": "error",
  "abstract/no-in-place-change": "error",
  "abstract/no-property-assignment": "error",
  "abstract/log-event-from-table": "error",
  "abstract/no-string-keyword": "error",
  "abstract/branded-schema-string": "error",
  "no-plusplus": "error",
  "typescript/switch-exhaustiveness-check": "error",
} as const;

/** The only thing an abstract layer takes from `effect`. */
const effectSchemaOnly = { name: "effect", allowImportNames: ["Schema"], message: "The abstract layers import only `Schema` from effect." };

/** The modules each abstract layer may import, besides `Schema` from effect and its own files. */
const importsAllowed: Record<AbstractLayer, { readonly group: ReadonlyArray<string>; readonly message: string }> = {
  "agent-machine": { group: ["*", "!effect", "!./*"], message: "agent-machine imports only `Schema` from effect, and its own files." },
  "agent-policy": {
    group: ["*", "!effect", "!./*", "!../agent-machine/*", "!../agent-environment/*"],
    message: "agent-policy imports only `Schema` from effect, agent-machine, agent-environment, and its own files.",
  },
};

/**
 * What every module that has been refactored to functional code is held to: no mutable bindings,
 * no loop statements, no in-place changes (by a call or an assignment to a property), no nested
 * conditional expressions, and every log event
 * named from its module's log key table. A module joins `functionalModules` when its refactor is
 * done.
 */
const functional = {
  "abstract/no-let": "error",
  "abstract/no-loop": "error",
  "abstract/no-in-place-change": "error",
  "abstract/no-property-assignment": "error",
  "abstract/log-event-from-table": "error",
  "no-plusplus": "error",
  "no-nested-ternary": "error",
  // A `switch` over a union names every member: a `default` does not count, so a new member is a decision the compiler asks for.
  "typescript/switch-exhaustiveness-check": "error",
} as const;

/** The modules under `src/` held to `functional`, besides the abstract layers. */
const functionalModules = ["agent-environment", "agent-process", "agent-config", "agent-tools", "agent-host", "agent-mcp", "agent-context", "agent-session", "agent-acp", "examples", "instrumentation"] as const;

/**
 * Files that are glue to an imperative API, where mutable state or loops are needed. Each entry
 * names the API it adapts.
 */
const imperativeBoundaries: ReadonlyArray<string> = [
  // Synchronous appends and renames, for a logger, which Effect calls synchronously (node:fs).
  "src/agent-host/log-file.ts",
  // A copy of effective-acp's JSON-RPC peer (`effective-acp/src/peer.ts`), kept close to it so its changes can be carried over.
  "src/agent-mcp/peer.ts",
  // Raw mode and key events on Node's stdin (node:tty), around Effect's terminal prompts.
  "src/examples/cli-repl/turn-keys.ts",
  // A span that keeps its events, as Effect's Tracer.Span, whose methods Effect calls synchronously.
  "src/instrumentation/telemetry.ts",
  // The command parser's WebAssembly module: loaded once, its memory written and read in place.
  "src/agent-host/command-parser.ts",
  // A line diff's table of common subsequences, filled in place.
  "src/agent-tools/line-diff.ts",
];

export default defineConfig({
  ignorePatterns: ["repos/**"],
  extends: [strict],
  jsPlugins: ["./scripts/oxlint/abstract-layers.js"],
  rules: {
    // A cast through `unknown` or `any` turns off the check that the types exist to make.
    "abstract/no-double-cast": "error",
    // A cast is a claim the compiler cannot check: narrow, annotate, or decode instead. `as const` is allowed.
    "typescript/consistent-type-assertions": ["error", { assertionStyle: "never" }],
    "typescript/no-non-null-assertion": "error",
    // A workflow's body runs again on every replay: a clock or random read there differs each time.
    "abstract/workflow-deterministic": "error",
  },
  overrides: [
    // The files that had casts when the two cast rules started, each held to its count by `bun run check:casts` (`scripts/lint-exceptions.ts`).
    { files: Object.keys(typeAssertions), rules: { "typescript/consistent-type-assertions": "off" } },
    { files: Object.keys(nonNullAssertions), rules: { "typescript/no-non-null-assertion": "off" } },
    // Tests synchronize on events, or move the test clock; they do not sleep.
    { files: ["**/*.test.ts", "tests/**"], rules: { "abstract/no-sleep-in-tests": "error" } },
    // The in-memory stores are for a session that is not saved: `withSession` chooses them, and examples that keep no session, tests and probes use them.
    {
      files: ["src/**"],
      excludeFiles: ["**/*.test.ts", "src/agent-host/with-session.ts", "src/agent-host/ephemeral-session.ts", "src/examples/fizzbuzz/**"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              {
                group: ["**/ephemeral-session.ts", "**/ephemeral-session"],
                message: "The in-memory stores are for a session that is not saved, which `withSession` (agent-host/with-session.ts) chooses by `persist`: a saved session must not fall back to memory.",
              },
            ],
          },
        ],
      },
    },
    // Application code takes its configuration from `Config` or from the environment an entry point passes in.
    {
      files: ["src/**"],
      excludeFiles: ["**/*.test.ts"],
      plugins: ["unicorn", "typescript", "oxc", "effecttsgo", "node"],
      rules: { "node/no-process-env": "error" },
    },
    {
      files: functionalModules.map((module) => `src/${module}/**`),
      excludeFiles: ["**/*.test.ts", ...imperativeBoundaries],
      rules: functional,
    },
    ...abstractLayers.map(
      (layer): OxlintOverride => ({
        files: [`src/${layer}/**`],
        excludeFiles: ["**/*.test.ts"],
        rules: {
          ...abstractLayer,
          "no-restricted-imports": ["error", { paths: [effectSchemaOnly], patterns: [{ group: [...importsAllowed[layer].group], message: importsAllowed[layer].message }] }],
        },
      }),
    ),
  ],
});
