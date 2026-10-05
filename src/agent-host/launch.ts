/**
 * What both hosts are launched with: the options they share, as flags, and the configuration's
 * layers those options make (agent-config).
 *
 * Each option is a flag with a variable as its twin. A flag not given is read from its variable
 * (`launchVariables`): the brand's prefix, the host's own part (`ACP_` for the ACP launcher's, none
 * for the CLI's), then the flag's name in capitals, `_` for `-` (`--max-turns`: `LABKIT_MAX_TURNS`,
 * `LABKIT_ACP_MAX_TURNS`). A flag given wins; `--mcp-config`, which may be given again, takes one
 * value from its variable.
 *
 * The layers, merged in order, the last write winning:
 *
 * 1. the host's own defaults;
 * 2. the user's file, and the project's and the local one when `--setting-sources` names them: a
 *    folder's files are not read unless asked for, as a cloned one's could turn off permission or
 *    pass the model's commands credentials. Named, they are read, and still may not name extensions
 *    or MCP servers (they are not trusted);
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

import { Config, ConfigProvider, Effect, FileSystem, Option } from "effect";
import { Command, Flag } from "effect/cli";
import { ConfigInvalid, type Configuration, fileLayer, type FileSource, fileSources, type LayerSource, loadConfiguration, policyLayers } from "../agent-config/file.ts";
import { merged } from "../agent-config/merge.ts";
import type { PermissionMode } from "../agent-policy/permissions.ts";
import { type Brand, envPrefixOf } from "./brand.ts";

/** The name a flag's value has in configuration: its name in camel case (`max-turns`: `maxTurns`). */
const keyOf = (flag: string): string => flag.replace(/-([a-z0-9])/g, (_, letter: string) => letter.toUpperCase());

const optional = <A>(flag: Flag.Flag<A>) => flag.pipe(Flag.optional, Flag.map(Option.getOrUndefined));

/** A flag of text, read from its variable when not given; undefined when neither says. */
export const textFlag = (name: string, description: string) =>
  optional(Flag.String(name).pipe(Flag.withDescription(description), Flag.withFallbackConfig(Config.String(keyOf(name)))));

/** A flag that is on or off, read from its variable when not given (`1`, `true`, `yes`, `on`); off when neither says. */
export const toggleFlag = (name: string, description: string) =>
  Flag.Boolean(name).pipe(Flag.withDescription(description), Flag.withFallbackConfig(Config.Boolean(keyOf(name))), Flag.withDefault(false));

/** A flag of a whole number, read from its variable when not given; undefined when neither says. */
export const intFlag = (name: string, description: string) =>
  optional(Flag.Int(name).pipe(Flag.withDescription(description), Flag.withFallbackConfig(Config.Int(keyOf(name)))));


/** The permission modes a host is launched in: `manual` is `default`. */
const permissionModes = ["default", "manual", "acceptEdits", "dontAsk", "bypassPermissions"] as const;

/** The options both hosts take, each with its variable as its twin. */
export const launchFlags = {
  model: textFlag("model", "A well-known model, or provider/model"),
  // `plan` and `auto` are not built.
  permissionMode: optional(
    Flag.Literals("permission-mode", permissionModes).pipe(
      Flag.withDescription(
        "When a tool call that changes things runs: default asks (manual is the same), acceptEdits runs file edits, dontAsk refuses, bypassPermissions runs all",
      ),
      Flag.withFallbackConfig(Config.Literals(permissionModes, keyOf("permission-mode"))),
    ),
  ),
  strictToolInput: toggleFlag("strict-tool-input", "Refuse a tool call whose input has properties its tool does not take, rather than run it without them"),
  maxTurns: intFlag("max-turns", "The most model requests one turn makes; the next ends it"),
  maxBudgetUsd: optional(
    Flag.Finite("max-budget-usd").pipe(
      Flag.withDescription("The session's budget in US dollars: once it has cost that much, its next model request ends its turn"),
      Flag.withFallbackConfig(Config.Finite(keyOf("max-budget-usd"))),
    ),
  ),
  // At least one, so that none given is missing and its variable is read.
  mcpConfig: Flag.String("mcp-config").pipe(
    Flag.atLeast(1),
    Flag.withDescription("MCP servers, as JSON or a file of it, as Claude Code's .mcp.json; the flag may be given again"),
    Flag.withFallbackConfig(Config.String(keyOf("mcp-config")).pipe(Config.map((one): ReadonlyArray<string> => [one]))),
    Flag.optional,
    Flag.map(Option.getOrElse((): ReadonlyArray<string> => [])),
  ),
  strictMcpConfig: toggleFlag("strict-mcp-config", "Use only the MCP servers --mcp-config names"),
  settings: textFlag("settings", "Settings: JSON, or a file of JSON or YAML, over the files"),
  settingSources: textFlag("setting-sources", "Which settings files to read, comma-separated: user, project, local (only user when not given)"),
};

/** The options a host was launched with. */
export type LaunchOptions = Command.Command.Config.Infer<typeof launchFlags>;

/**
 * Where the flags' twins are read from: `env`'s variables named with `brand`'s prefix and the host's
 * own part (`["ACP"]` for the ACP launcher's, none for the CLI's), then `env`'s variables as named,
 * for configuration that is not a flag's twin (`OTEL_EXPORTER_OTLP_ENDPOINT`). An empty variable is
 * none.
 */
export const launchVariables = (
  brand: Brand,
  host: ReadonlyArray<string> = [],
  env: Readonly<Record<string, string | undefined>> = process.env,
): ConfigProvider.ConfigProvider => {
  const named = ConfigProvider.fromEnvRecord({ ...env });
  return ConfigProvider.orElse(named.pipe(ConfigProvider.nested([envPrefixOf(brand).slice(0, -1), ...host]), ConfigProvider.constantCase), named);
};

/** The flags that make the layers. */
export interface ConfigFlags {
  /** Which files to read: `user`, `project`, `local`, comma-separated. */
  readonly settingSources?: string | undefined;
  /** A layer: JSON, or a file of JSON or YAML. */
  readonly settings?: string | undefined;
  /** MCP servers, each JSON or a file of it, as Claude Code's `.mcp.json`. */
  readonly mcpConfig: ReadonlyArray<string>;
  /** Whether the MCP servers are only those `mcpConfig` names. */
  readonly strictMcpConfig: boolean;
  readonly permissionMode?: PermissionMode | "manual" | undefined;
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
 * the local one come with the folder the host runs in, and could change what runs without asking or
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
  const mode = flags.permissionMode === "manual" ? "default" : flags.permissionMode;
  const plugins = {
    ...(mode === undefined ? {} : { permissions: { mode } }),
    ...(flags.maxTurns === undefined ? {} : { maxTurnRequests: { limit: flags.maxTurns } }),
    ...(flags.maxBudgetUsd === undefined ? {} : { maxBudget: { usd: flags.maxBudgetUsd } }),
  };
  return {
    name: "the command line",
    trusted: true,
    value: { ...(Object.keys(plugins).length === 0 ? {} : { plugins }), ...(added.length === 0 ? {} : { modelRequests: [...listed, ...added] }) },
  };
};

/**
 * The layers, in order, for a host run in `project` whose own defaults are `defaults`. With no
 * project (a launcher before any session has one), the user's file is the only file read.
 */
export const launchLayers = (
  project: string | undefined,
  defaults: LayerSource,
  flags: ConfigFlags,
  options: { readonly home?: string; readonly name?: string } = {},
): Effect.Effect<ReadonlyArray<LayerSource>, ConfigInvalid, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const sources = yield* sourcesOf(flags.settingSources);
    const files = yield* policyLayers(project ?? "", { ...options, sources: project === undefined ? sources.filter((source) => source === "user") : sources });
    const settings = flags.settings === undefined ? [] : [yield* givenLayer("--settings", flags.settings)];
    const strict: ReadonlyArray<LayerSource> = flags.strictMcpConfig ? [{ name: "--strict-mcp-config", trusted: true, value: { mcpServers: null } }] : [];
    const mcp = yield* Effect.forEach(flags.mcpConfig, (given) =>
      Effect.map(givenLayer("--mcp-config", given), (layer): LayerSource => ({ ...layer, value: { mcpServers: isMapping(layer.value) ? (layer.value["mcpServers"] ?? {}) : layer.value } })),
    );
    const before = [defaults, ...files, ...settings, ...strict, ...mcp];
    return [...before, flagLayer(flags, before)];
  });

/** Returns the configuration for a host run in `project` (none for a launcher before any session has a project) whose own defaults are `defaults`, and the layers it was made from. */
export const launchConfiguration = (
  project: string | undefined,
  defaults: LayerSource,
  flags: ConfigFlags,
  options: { readonly home?: string; readonly name?: string } = {},
): Effect.Effect<Configuration & { readonly layers: ReadonlyArray<LayerSource> }, ConfigInvalid, FileSystem.FileSystem> =>
  Effect.flatMap(launchLayers(project, defaults, flags, options), (layers) => Effect.map(loadConfiguration(layers), (configuration) => ({ ...configuration, layers })));
