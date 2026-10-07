/**
 * What both hosts are launched with: the options they share, as flags, and the configuration layers
 * that those options make (agent-config).
 *
 * Each option is a flag with a twin variable. A flag that is not given is read from its variable
 * (`launchVariables`): the brand's prefix, the host's own part (`ACP_` for the ACP launcher, none for
 * the CLI), then the flag's name in capitals with `_` for `-` (`--max-turns`: `LABKIT_MAX_TURNS`,
 * `LABKIT_ACP_MAX_TURNS`). A flag given on the command line wins. `--mcp-config`, which can be
 * repeated, takes one value from its variable.
 *
 * The layers, merged in order, the last write winning:
 *
 * 1. the host's own defaults;
 * 2. the files of the user's configuration folder (`--config-dir`, else `~/.config/<brand>`), and
 *    the project's files and the local ones when `--setting-sources` names them, each folder's files
 *    in the order of their names. A project's files are read only when named, and only in a trusted
 *    folder (`trust.ts`), because a cloned folder's files could turn off permission or give the
 *    model's commands credentials. Naming them in a folder that is not trusted fails. In a trusted
 *    folder they are the user's own, so they may name extensions and MCP servers;
 * 3. `--settings`: JSON, or a file of JSON or YAML;
 * 4. with `--strict-mcp-config`, a layer that removes every MCP server except those `--mcp-config`
 *    names;
 * 5. each `--mcp-config`: JSON or a file of it, as Claude Code's `.mcp.json`
 *    (`{ "mcpServers": { <name>: { "command", "args", "env" } } }`);
 * 6. the flags: `--permission-mode` (the permission plug-in's mode), `--max-turns` (the maximum number
 *    of model requests in a turn) and `--max-budget-usd` (the session's budget). A flag that sets a
 *    plug-in that the model requests list does not have adds it to the end of that list.
 *
 * Every layer is the user's, so it may load extensions: the project's files and the local ones are
 * read only in a trusted folder.
 */

import { isAbsolute, resolve } from "node:path";
import { Config, ConfigProvider, Effect, FileSystem, Option } from "effect";
import { Command, Flag } from "effect/cli";
import { ConfigInvalid, type Configuration, configFolders, fileLayer, fileLayers, type FileSource, fileSources, type LayerSource, loadConfiguration } from "../agent-config/file.ts";
import { merged } from "../agent-config/merge.ts";
import type { PermissionMode } from "../agent-policy/permissions.ts";
import { type Brand, envPrefixOf } from "./brand.ts";
import { FolderNotTrusted } from "./trust.ts";

/** Returns a flag's name as a configuration key: in camel case (`max-turns`: `maxTurns`). */
const keyOf = (flag: string): string => flag.replace(/-([a-z0-9])/g, (_, letter: string) => letter.toUpperCase());

const optional = <A>(flag: Flag.Flag<A>) => flag.pipe(Flag.optional, Flag.map(Option.getOrUndefined));

/** A text flag, read from its variable when not given; undefined when neither gives a value. */
export const textFlag = (name: string, description: string) =>
  optional(Flag.String(name).pipe(Flag.withDescription(description), Flag.withFallbackConfig(Config.String(keyOf(name)))));

/** An on/off flag, read from its variable when not given (`1`, `true`, `yes`, `on`); off when neither gives a value. */
export const toggleFlag = (name: string, description: string) =>
  Flag.Boolean(name).pipe(Flag.withDescription(description), Flag.withFallbackConfig(Config.Boolean(keyOf(name))), Flag.withDefault(false));

/** A whole-number flag, read from its variable when not given; undefined when neither gives a value. */
export const intFlag = (name: string, description: string) =>
  optional(Flag.Int(name).pipe(Flag.withDescription(description), Flag.withFallbackConfig(Config.Int(keyOf(name)))));


/** The permission modes that a host can be launched in; `manual` means `default`. */
const permissionModes = ["default", "manual", "acceptEdits", "dontAsk", "bypassPermissions"] as const;

/** The options that both hosts accept, each with a twin variable. */
export const launchFlags = {
  model: textFlag("model", "The model to use: a model name, or provider/model"),
  // `plan` and `auto` are not built.
  permissionMode: optional(
    Flag.Literals("permission-mode", permissionModes).pipe(
      Flag.withDescription(
        "How tool calls that change things are allowed: default asks (manual is the same), acceptEdits allows file edits, dontAsk refuses, bypassPermissions allows all",
      ),
      Flag.withFallbackConfig(Config.Literals(permissionModes, keyOf("permission-mode"))),
    ),
  ),
  strictToolInput: toggleFlag("strict-tool-input", "Refuse a tool call with input properties the tool does not define, instead of dropping them"),
  maxTurns: intFlag("max-turns", "Maximum model requests per turn"),
  maxBudgetUsd: optional(
    Flag.Finite("max-budget-usd").pipe(
      Flag.withDescription("Spending limit in US dollars: once the session has cost this much, the turn ends at its next model request"),
      Flag.withFallbackConfig(Config.Finite(keyOf("max-budget-usd"))),
    ),
  ),
  // At least one, so that when none is given, the variable is read.
  mcpConfig: Flag.String("mcp-config").pipe(
    Flag.atLeast(1),
    Flag.withDescription("MCP servers as JSON, or a JSON file, in Claude Code's .mcp.json format; repeatable"),
    Flag.withFallbackConfig(Config.String(keyOf("mcp-config")).pipe(Config.map((one): ReadonlyArray<string> => [one]))),
    Flag.optional,
    Flag.map(Option.getOrElse((): ReadonlyArray<string> => [])),
  ),
  strictMcpConfig: toggleFlag("strict-mcp-config", "Use only the MCP servers from --mcp-config"),
  settings: textFlag("settings", "Settings as JSON, or a JSON or YAML file, applied over the configuration files"),
  configDir: textFlag("config-dir", "Configuration folder; its .yml files are read in name order (default ~/.config/<brand>)"),
  settingSources: textFlag("setting-sources", "Settings files to read, comma-separated: user, project, local (default user)"),
};

/** The options a host was launched with. */
export type LaunchOptions = Command.Command.Config.Infer<typeof launchFlags>;

/**
 * Returns where the flags' twin variables are read from: `env`'s variables named with `brand`'s prefix
 * and the host's own part (`["ACP"]` for the ACP launcher, none for the CLI), then `env`'s variables
 * under their own names, for configuration that is not a flag's twin (`OTEL_EXPORTER_OTLP_ENDPOINT`).
 * An empty variable counts as not set.
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
  /** The user's configuration folder, in place of `~/.config/<brand>`. */
  readonly configDir?: string | undefined;
  /** Which files to read: `user`, `project`, `local`, comma-separated. */
  readonly settingSources?: string | undefined;
  /** A layer: JSON, or a file of JSON or YAML. */
  readonly settings?: string | undefined;
  /** MCP servers, each JSON or a file of it, as Claude Code's `.mcp.json`. */
  readonly mcpConfig: ReadonlyArray<string>;
  /** Whether the MCP servers are limited to those that `mcpConfig` names. */
  readonly strictMcpConfig: boolean;
  readonly permissionMode?: PermissionMode | "manual" | undefined;
  readonly maxTurns?: number | undefined;
  readonly maxBudgetUsd?: number | undefined;
}

const isMapping = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Reads a layer from `value`: JSON when it starts with `{`; otherwise a file, read as JSON when its name ends `.json` and as YAML otherwise. */
const layerFromFlag = (flag: string, value: string): Effect.Effect<LayerSource, ConfigInvalid, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const json = (text: string, name: string) =>
      Effect.try({ try: (): unknown => JSON.parse(text), catch: (cause) => new ConfigInvalid({ file: name, path: "", problem: `Not JSON: ${String(cause)}` }) });
    if (value.trim().startsWith("{")) return { name: flag, value: yield* json(value, flag), trusted: true };
    if (!value.endsWith(".json")) {
      const layer = yield* fileLayer(value, true);
      if (layer === undefined) return yield* new ConfigInvalid({ file: value, path: "", problem: `No such file, named by ${flag}` });
      return layer;
    }
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(value).pipe(Effect.mapError((cause) => new ConfigInvalid({ file: value, path: "", problem: `Could not be read, named by ${flag}: ${String(cause)}` })));
    return { name: value, value: yield* json(text, value), trusted: true };
  });

/**
 * Returns the file sources that `--setting-sources` names: only the user's when it is not given. A
 * project's file and the local one come with the folder the host runs in, and could change what runs
 * without asking or what a command receives, so they are read only when named.
 */
const sourcesOf = (given: string | undefined): Effect.Effect<ReadonlyArray<FileSource>, ConfigInvalid> => {
  if (given === undefined) return Effect.succeed(["user"]);
  const named = given.split(",").map((each) => each.trim()).filter((each) => each !== "");
  const unknown = named.find((each) => !fileSources.includes(each as FileSource));
  return unknown === undefined
    ? Effect.succeed(named as ReadonlyArray<FileSource>)
    : Effect.fail(new ConfigInvalid({ file: "--setting-sources", path: "", problem: `${JSON.stringify(unknown)} is not a source; those are: ${fileSources.join(", ")}` }));
};

/** Returns the flags' own layer, over `before`. A plug-in that a flag sets is added to the model requests' list when the list does not have it. */
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

/** The folders' options for a host whose flags are `flags`: the user's folder is `--config-dir` (or its variable) when given. */
const folderOptionsOf = (flags: ConfigFlags, options: { readonly home?: string; readonly name?: string }) => ({
  ...options,
  ...(flags.configDir === undefined ? {} : { configDir: resolve(flags.configDir) }),
});

/**
 * Returns the user's configuration folder for a host whose flags are `flags`: `--config-dir` (or its
 * variable), else `~/.config/<name>`. Its files are the first files read (`launchLayers`), and a host
 * writes the user's settings into it.
 */
export const userFolderOf = (flags: ConfigFlags, options: { readonly home?: string; readonly name?: string } = {}): string =>
  configFolders("", folderOptionsOf(flags, options)).user;

/** Where a host's layers come from, besides its flags: the home and brand name of the user's folder, and whether the project's folder is trusted. */
export interface LayerOptions {
  readonly home?: string;
  readonly name?: string;
  /** Whether the project's folder is trusted (`trust.ts`), so that its files may be read; not trusted when left out. */
  readonly projectTrusted?: boolean;
}

/**
 * Returns the layers, in order, for a host run in `project` whose own defaults are `defaults`. With
 * no project (a launcher before any session has one), the user's file is the only file read.
 *
 * Fails when `--config-dir` (or its variable) is not an absolute path, since a relative one would
 * name a different folder in each folder the host runs in; and when `--setting-sources` names the
 * project's files or the local ones and the project's folder is not trusted.
 */
export const launchLayers = (
  project: string | undefined,
  defaults: LayerSource,
  flags: ConfigFlags,
  options: LayerOptions = {},
): Effect.Effect<ReadonlyArray<LayerSource>, ConfigInvalid | FolderNotTrusted, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    if (flags.configDir !== undefined && !isAbsolute(flags.configDir))
      return yield* new ConfigInvalid({ file: "--config-dir", path: "", problem: `Not an absolute path: ${flags.configDir}` });
    const sources = yield* sourcesOf(flags.settingSources);
    const named = project === undefined ? sources.filter((source) => source === "user") : sources;
    if (project !== undefined && options.projectTrusted !== true && named.some((source) => source !== "user")) return yield* new FolderNotTrusted({ folder: project });
    const files = yield* fileLayers(project ?? "", {
      ...folderOptionsOf(flags, options),
      sources: named,
      projectTrusted: options.projectTrusted === true,
    });
    const settings = flags.settings === undefined ? [] : [yield* layerFromFlag("--settings", flags.settings)];
    const strict: ReadonlyArray<LayerSource> = flags.strictMcpConfig ? [{ name: "--strict-mcp-config", trusted: true, value: { mcpServers: null } }] : [];
    const mcp = yield* Effect.forEach(flags.mcpConfig, (given) =>
      Effect.map(layerFromFlag("--mcp-config", given), (layer): LayerSource => ({ ...layer, value: { mcpServers: isMapping(layer.value) ? (layer.value["mcpServers"] ?? {}) : layer.value } })),
    );
    const before = [defaults, ...files, ...settings, ...strict, ...mcp];
    return [...before, flagLayer(flags, before)];
  });

/** Returns the configuration for a host run in `project` (none for a launcher before any session has a project) whose own defaults are `defaults`, and the layers it was made from. */
export const launchConfiguration = (
  project: string | undefined,
  defaults: LayerSource,
  flags: ConfigFlags,
  options: LayerOptions = {},
): Effect.Effect<Configuration & { readonly layers: ReadonlyArray<LayerSource> }, ConfigInvalid | FolderNotTrusted, FileSystem.FileSystem> =>
  Effect.flatMap(launchLayers(project, defaults, flags, options), (layers) => Effect.map(loadConfiguration(layers), (configuration) => ({ ...configuration, layers })));
