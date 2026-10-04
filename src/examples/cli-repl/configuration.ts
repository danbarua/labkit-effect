/**
 * The CLI's configuration, in layers merged in order (`agent-config`), the last write winning:
 *
 * 1. the CLI's own defaults: the loop breaker, then permission, on tool calls; the loop breaker on
 *    model requests; a turn with thinking and no answer asked once more for it; the model's
 *    commands given the environment without its credentials;
 * 2. the user's file, and the project's (the folder the CLI runs in) and the local one when
 *    `--setting-sources` names them: a folder's files are not read unless asked for, as a cloned
 *    one's could turn off permission or pass the model's commands credentials. Named, they are read,
 *    and still may not name extensions or MCP servers (they are not trusted);
 * 3. `--settings`: JSON, or a file of JSON or YAML;
 * 4. with `--strict-mcp-config`, no MCP servers but those `--mcp-config` names;
 * 5. `--mcp-config`, each one JSON or a file of it, as Claude Code's `.mcp.json`
 *    (`{ "mcpServers": { <name>: { "command", "args", "env" } } }`);
 * 6. the flags: `--permission-mode` (the permission plug-in's mode), `--max-turns` (the most model
 *    requests a turn makes) and `--max-budget-usd` (the session's budget). A flag that sets a
 *    plug-in the model requests do not list adds it to their list, last.
 *
 * Everything but the project's file and the local one is the user's, so may load extensions.
 */

import { Effect, FileSystem } from "effect";
import { ConfigInvalid, type Configuration, fileLayer, type FileSource, fileSources, type LayerSource, loadConfiguration, policyLayers } from "../../agent-config/file.ts";
import { merged } from "../../agent-config/merge.ts";
import type { PermissionMode } from "../../agent-policy/permissions.ts";

/** The CLI's own defaults: the first layer. */
export const cliDefaults: LayerSource = {
  name: "the CLI's defaults",
  trusted: true,
  value: { toolCalls: ["loopBreaker", "permissions"], modelRequests: ["loopBreaker"], turnEnd: ["retryIncomplete"], maxHolds: 1, commandEnvironment: ["credentials"] },
};

/** The flags that make the CLI's layers. */
export interface ConfigFlags {
  /** Which files to read: `user`, `project`, `local`, comma-separated. */
  readonly settingSources?: string | undefined;
  /** A layer: JSON, or a file of JSON or YAML. */
  readonly settings?: string | undefined;
  /** MCP servers, each JSON or a file of it, as Claude Code's `.mcp.json`. */
  readonly mcpConfig: ReadonlyArray<string>;
  /** Whether the MCP servers are only those `mcpConfig` names. */
  readonly strictMcpConfig: boolean;
  readonly permissionMode?: PermissionMode | undefined;
  readonly maxTurns?: number | undefined;
  readonly maxBudgetUsd?: number | undefined;
}

const isMapping = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A layer from `given`: JSON when it starts with `{`, else a file, of JSON when it ends `.json`, else of YAML. */
const givenLayer = (flag: string, given: string): Effect.Effect<LayerSource, ConfigInvalid, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const json = (text: string, name: string) =>
      Effect.try({ try: (): unknown => JSON.parse(text), catch: (cause) => new ConfigInvalid({ file: name, path: "", problem: `Not JSON: ${String(cause)}` }) });
    if (given.trim().startsWith("{")) return { name: flag, value: yield* json(given, flag), trusted: true };
    if (!given.endsWith(".json")) {
      const layer = yield* fileLayer(given, true);
      if (layer === undefined) return yield* new ConfigInvalid({ file: given, path: "", problem: `No such file, named by ${flag}` });
      return layer;
    }
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(given).pipe(Effect.mapError((cause) => new ConfigInvalid({ file: given, path: "", problem: `Could not be read, named by ${flag}: ${String(cause)}` })));
    return { name: given, value: yield* json(text, given), trusted: true };
  });

/**
 * The file layers `--setting-sources` names: the user's alone, unless it says. A project's file and
 * the local one come with the folder the CLI runs in, and could change what runs without asking or
 * what a command is given, so they are read only when named, until a folder can be trusted.
 */
const sourcesOf = (given: string | undefined): Effect.Effect<ReadonlyArray<FileSource>, ConfigInvalid> => {
  if (given === undefined) return Effect.succeed(["user"]);
  const named = given.split(",").map((each) => each.trim()).filter((each) => each !== "");
  const unknown = named.find((each) => !fileSources.includes(each as FileSource));
  return unknown === undefined
    ? Effect.succeed(named as ReadonlyArray<FileSource>)
    : Effect.fail(new ConfigInvalid({ file: "--setting-sources", path: "", problem: `${JSON.stringify(unknown)} is not a source; those are: ${fileSources.join(", ")}` }));
};

/** The flags' own layer, over `before`: a plug-in a flag sets is added to the model requests' list when it is not on it. */
const flagLayer = (flags: ConfigFlags, before: ReadonlyArray<LayerSource>): LayerSource => {
  const sofar = merged(before.map((layer) => layer.value ?? {}));
  const listed = isMapping(sofar) && Array.isArray(sofar["modelRequests"]) ? (sofar["modelRequests"] as ReadonlyArray<unknown>) : [];
  const added = [...(flags.maxTurns === undefined ? [] : ["maxTurnRequests"]), ...(flags.maxBudgetUsd === undefined ? [] : ["maxBudget"])].filter((name) => !listed.includes(name));
  const plugins = {
    ...(flags.permissionMode === undefined ? {} : { permissions: { mode: flags.permissionMode } }),
    ...(flags.maxTurns === undefined ? {} : { maxTurnRequests: { limit: flags.maxTurns } }),
    ...(flags.maxBudgetUsd === undefined ? {} : { maxBudget: { usd: flags.maxBudgetUsd } }),
  };
  return {
    name: "the command line",
    trusted: true,
    value: { ...(Object.keys(plugins).length === 0 ? {} : { plugins }), ...(added.length === 0 ? {} : { modelRequests: [...listed, ...added] }) },
  };
};

/** The CLI's layers, in order, for a CLI run in `project`. */
export const cliLayers = (project: string, flags: ConfigFlags, options: { readonly home?: string } = {}): Effect.Effect<ReadonlyArray<LayerSource>, ConfigInvalid, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const files = yield* policyLayers(project, { ...options, sources: yield* sourcesOf(flags.settingSources) });
    const settings = flags.settings === undefined ? [] : [yield* givenLayer("--settings", flags.settings)];
    const strict: ReadonlyArray<LayerSource> = flags.strictMcpConfig ? [{ name: "--strict-mcp-config", trusted: true, value: { mcpServers: null } }] : [];
    const mcp = yield* Effect.forEach(flags.mcpConfig, (given) =>
      Effect.map(givenLayer("--mcp-config", given), (layer): LayerSource => ({ ...layer, value: { mcpServers: isMapping(layer.value) ? (layer.value["mcpServers"] ?? {}) : layer.value } })),
    );
    const before = [cliDefaults, ...files, ...settings, ...strict, ...mcp];
    return [...before, flagLayer(flags, before)];
  });

/** The CLI's configuration, for a CLI run in `project`, and the layers it was made from. */
export const cliConfiguration = (
  project: string,
  flags: ConfigFlags,
  options: { readonly home?: string } = {},
): Effect.Effect<Configuration & { readonly layers: ReadonlyArray<LayerSource> }, ConfigInvalid, FileSystem.FileSystem> =>
  Effect.flatMap(cliLayers(project, flags, options), (layers) => Effect.map(loadConfiguration(layers), (configuration) => ({ ...configuration, layers })));
