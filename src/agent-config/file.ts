/**
 * A session's configuration, read from layers merged in order, the last write winning (`merge.ts`):
 * the user's file (`~/.config/<name>/policies.yml`), then the project's (`<project>/.<name>/policies.yml`),
 * then the user's own for the project (`<project>/.<name>/policies.local.yml`), then what a host
 * adds (a settings file named on its command line, its flags). A file that is not there is an empty
 * layer. `<name>` is `configName` unless the caller says another.
 *
 * A layer is a mapping (YAML, read with `effect/encoding` `Yaml`; or a value a host makes) of:
 *
 * - `plugins`: the plug-ins used, by the name the lists use, each with its settings; `use` names the
 *   plug-in when it is not the name (two of one plug-in, with different settings). A setting not
 *   given takes its default, so a later layer can change one setting alone.
 * - a list for each seam (`toolCalls`, `modelRequests`, `turnEnd`, `knownModels`, `settling`,
 *   `toolSources`): names, in order, each one in `plugins` or a plug-in's own name (its defaults).
 *   A plug-in's settings are said once, in `plugins`, however many lists it is on.
 * - `maxHolds`: how many times the turn-end hooks may hold one turn open, which the layers must say
 *   when `turnEnd` lists hooks.
 * - `mcpServers`: the MCP servers a session starts, by name: a command it runs (`command`, `args`,
 *   `env`, `cwd`), or a server at a URL (`type: http` or `sse`, `url`, `headers`); whether the
 *   session needs it (`required`), and how long it has to connect (`connectTimeout`). `${VAR}` and
 *   `${VAR:-default}` in `command`, `args`, `env`, `url` and `headers` are the environment's.
 * - `extensions`: modules to load, each exporting by default a plug-in or a list of them, a path
 *   relative to its file's folder.
 *
 * Only a trusted layer, the user's own, may name extensions or MCP servers: both run code, and a
 * project's file comes with the project.
 *
 * The layers are decoded merged. A mistake is refused naming the layer that last wrote the value at
 * fault, where in it, and what is wrong. A plug-in's settings are decoded with its Schema, refusing a
 * property it does not have.
 */

import type { McpServerStdio } from "../agent-mcp/client.ts";
import type { McpServerRemote } from "../agent-mcp/http.ts";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Array as Arr, Data, Duration, Effect, FileSystem, Schema } from "effect";
import { Yaml } from "effect/encoding";
import { defaultBrand } from "../agent-host/brand.ts";
import { builtins } from "./builtins.ts";
import { merged } from "./merge.ts";
import { type AnyPlugin, type Seam, seams } from "./plugin.ts";

/** The name of the configuration's folders unless a caller says another: the default brand's (`agent-host/brand.ts`). */
export const configName = defaultBrand.name;

/** Where a configuration file is: the user's, the project's (kept with it), or the user's own for the project (`local`, kept out of its history). */
export type FileSource = "user" | "project" | "local";

export const fileSources: ReadonlyArray<FileSource> = ["user", "project", "local"];

/**
 * The files a session's policies are read from, in order: `~/.config/<name>/policies.yml`,
 * `<project>/.<name>/policies.yml`, `<project>/.<name>/policies.local.yml`.
 */
export const policyFiles = (project: string, options: { readonly name?: string; readonly home?: string } = {}): Readonly<Record<FileSource, string>> => {
  const name = options.name ?? configName;
  return {
    user: join(options.home ?? homedir(), ".config", name, "policies.yml"),
    project: join(project, `.${name}`, "policies.yml"),
    local: join(project, `.${name}`, "policies.local.yml"),
  };
};

/** A configuration that cannot be used: the layer, where in it, and what is wrong. */
export class ConfigInvalid extends Data.TaggedError("ConfigInvalid")<{
  readonly file: string;
  readonly path: string;
  readonly problem: string;
}> {
  override get message(): string {
    return `${this.file}: ${this.path === "" ? "" : `${this.path}: `}${this.problem}`;
  }
}

/** One layer: what names it in an error (its file, or "the command line"), its value as parsed, and whether it may load extensions. */
export interface LayerSource {
  readonly name: string;
  readonly value: unknown;
  readonly trusted: boolean;
}

/** One entry of a seam: the name it is listed by, its plug-in, and its settings as the plug-in's Schema decoded them. */
export interface Entry {
  readonly name: string;
  readonly plugin: AnyPlugin;
  readonly settings: unknown;
}

/** An MCP server the configuration starts: one it runs, or one at a URL; its variables expanded. */
export type McpServerConfig = (McpServerStdio | McpServerRemote) & {
  /** Whether a session that cannot connect to it is not to open. */
  readonly required: boolean;
  readonly connectTimeout?: Duration.Input | undefined;
};

/** The configuration decoded: each seam the layers list, in order; `maxHolds` when they say it; the MCP servers. A seam no layer lists is left out. */
export interface Configuration {
  readonly lists: Partial<Record<Seam, ReadonlyArray<Entry>>>;
  readonly maxHolds?: number;
  readonly mcpServers: ReadonlyArray<McpServerConfig>;
}

const isMapping = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);

const topKeys: ReadonlyArray<string> = ["plugins", ...seams, "maxHolds", "mcpServers", "extensions"];

const MaxHolds = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const serverTiming = {
  required: Schema.optionalKey(Schema.Boolean),
  /** A duration: `30 seconds`, `500 millis`. */
  connectTimeout: Schema.optionalKey(Schema.String),
};

/** An MCP server the session runs: Claude Code's `.mcp.json` may say `type: stdio`. */
const StdioServer = Schema.Struct({
  type: Schema.optionalKey(Schema.Literal("stdio")),
  command: Schema.NonEmptyString,
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  cwd: Schema.optionalKey(Schema.String),
  ...serverTiming,
});

/** An MCP server at a URL: Streamable HTTP (`http`), or HTTP+SSE (`sse`). */
const RemoteServer = Schema.Struct({
  type: Schema.Literals(["http", "sse"]),
  url: Schema.NonEmptyString,
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  ...serverTiming,
});

/** An MCP server as a layer writes it: what the file's JSON Schema is made from too. */
export const McpServerSchema = Schema.Union([StdioServer, RemoteServer]);

/** `${VAR}` or `${VAR:-default}`. */
const variable = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/** The value `${name}` or `${name:-fallback}` expands to: the variable's value when it is set and not empty, else the fallback. */
const expansionOf = (env: Readonly<Record<string, string | undefined>>, name: string, fallback: string | undefined): string | undefined => {
  const set = env[name];
  return set !== undefined && set !== "" ? set : fallback;
};

/**
 * Expands every `${VAR}` and `${VAR:-default}` in `text`. Returns the expanded text, or the name of
 * the first variable that is not set and has no default.
 */
const expandedIn = (text: string, env: Readonly<Record<string, string | undefined>>): { readonly value: string } | { readonly missing: string } => {
  const missing = [...text.matchAll(variable)].find(([, name = "", fallback]) => expansionOf(env, name, fallback) === undefined)?.[1];
  if (missing !== undefined) return { missing };
  // Every variable has a value here: the first check returned when one did not.
  return { value: text.replaceAll(variable, (whole, name: string, fallback: string | undefined) => expansionOf(env, name, fallback) ?? whole) };
};

/** The problem a Schema found, on one line. */
const problemOf = (error: Schema.SchemaError): string => error.message.replaceAll(/\s*\n\s*/g, " ");

/** The value at `path` in `value`, or undefined. */
const at = (value: unknown, path: ReadonlyArray<string>): unknown => path.reduce<unknown>((inner, key) => (isMapping(inner) ? inner[key] : undefined), value);

/** The layer that last wrote `path`, or the deepest part of it that one wrote: what an error at `path` names. */
const writerOf = (layers: ReadonlyArray<LayerSource>, path: ReadonlyArray<string>): string => {
  const newestFirst = Arr.reverse(layers);
  // `path` itself first, then each shorter prefix of it.
  const prefixes = Arr.makeBy(path.length, (shorter) => path.slice(0, path.length - shorter));
  const writer = prefixes.map((prefix) => newestFirst.find((layer) => at(layer.value, prefix) !== undefined)).find((found) => found !== undefined);
  return writer?.name ?? layers.at(-1)?.name ?? "the configuration";
};

/** The plug-ins configured in `plugins`, by name, with their settings decoded; each mistake named for the layer that wrote it. */
const pluginsOf = (layers: ReadonlyArray<LayerSource>, value: unknown, registry: ReadonlyArray<AnyPlugin>): Effect.Effect<ReadonlyMap<string, Entry>, ConfigInvalid> =>
  Effect.gen(function* () {
    if (value === undefined) return new Map<string, Entry>();
    const invalid = (path: ReadonlyArray<string>, problem: string) => new ConfigInvalid({ file: writerOf(layers, path), path: path.join("."), problem });
    if (!isMapping(value)) return yield* invalid(["plugins"], "Expected a mapping of names to their plug-in's settings");
    const entries = yield* Effect.forEach(Object.entries(value), ([name, configured]) =>
      Effect.gen(function* () {
        const path = ["plugins", name];
        if (configured !== null && !isMapping(configured)) return yield* invalid(path, "Expected a mapping of settings");
        const { use = name, ...settings } = configured ?? {};
        if (typeof use !== "string") return yield* invalid([...path, "use"], "Expected the name of a plug-in");
        // A plug-in's own name takes that plug-in's settings without `use`, as the JSON Schema says.
        if (configured !== null && "use" in configured && registry.some((each) => each.use === name))
          return yield* invalid(
            [...path, "use"],
            `plugins.${name} is the ${name} plug-in's own name, which takes its settings without use; ${use === name ? "leave use out" : `to use ${JSON.stringify(use)}, give the entry another name`}`,
          );
        const plugin = registry.find((each) => each.use === use);
        if (plugin === undefined) return yield* invalid(configured !== null && "use" in configured ? [...path, "use"] : path, `${JSON.stringify(use)} is not a plug-in; those are: ${registry.map((each) => each.use).join(", ")}`);
        // Each setting is decoded alone first, in order, so that a mistake names the layer that wrote it.
        yield* Effect.forEach(
          Object.entries(settings),
          ([key, setting]) => {
            const field = plugin.settings.fields[key];
            if (field === undefined) return Effect.fail(invalid([...path, key], `${use} has no setting ${key}; its settings are: ${Object.keys(plugin.settings.fields).join(", ")}`));
            // A plug-in's settings decode with no services (`AnyPlugin`), and so does each of them.
            const alone = Schema.Struct({ [key]: field }) as unknown as Schema.Codec<unknown, unknown>;
            return Schema.decodeEffect(alone)({ [key]: setting }).pipe(Effect.mapError((error) => invalid([...path, key], problemOf(error))));
          },
          { discard: true },
        );
        const decoded = yield* Schema.decodeEffect(plugin.settings)(settings, { onExcessProperty: "error" }).pipe(Effect.mapError((error) => invalid(path, problemOf(error))));
        return [name, { name, plugin, settings: decoded } satisfies Entry] as const;
      }),
    );
    return new Map<string, Entry>(entries);
  });

/** One seam's list: each name a plug-in configured in `plugins`, or a plug-in's own name with its defaults, on that seam. */
const listOf = (
  layers: ReadonlyArray<LayerSource>,
  seam: Seam,
  list: unknown,
  configured: ReadonlyMap<string, Entry>,
  registry: ReadonlyArray<AnyPlugin>,
): Effect.Effect<ReadonlyArray<Entry>, ConfigInvalid> => {
  const invalid = (problem: string, index?: number) => new ConfigInvalid({ file: writerOf(layers, [seam]), path: index === undefined ? seam : `${seam}[${index}]`, problem });
  if (!Array.isArray(list)) return Effect.fail(invalid("Expected a list of names, each one in plugins or a plug-in's own"));
  return Effect.forEach(list, (name: unknown, index) =>
    Effect.gen(function* () {
      if (typeof name !== "string") return yield* invalid("Expected a name", index);
      const own = registry.find((each) => each.use === name);
      const entry =
        configured.get(name) ??
        (own === undefined
          ? undefined
          : { name, plugin: own, settings: yield* Schema.decodeEffect(own.settings)({}).pipe(Effect.mapError((error) => invalid(problemOf(error), index))) });
      if (entry === undefined)
        return yield* invalid(`${JSON.stringify(name)} is neither in plugins nor a plug-in; the plug-ins are: ${registry.map((each) => each.use).join(", ")}`, index);
      if (!entry.plugin.on.includes(seam))
        return yield* invalid(`${name} is ${entry.plugin.use}, which is not on ${seam}; it is on ${entry.plugin.on.join(", ")}`, index);
      return entry;
    }),
  );
};

/** The MCP servers in `mcpServers`, by name, their variables `env`'s. */
const mcpServersOf = (layers: ReadonlyArray<LayerSource>, value: unknown, env: Readonly<Record<string, string | undefined>>): Effect.Effect<ReadonlyArray<McpServerConfig>, ConfigInvalid> =>
  Effect.gen(function* () {
    // `null` is no servers: a later layer that writes it takes away those of the layers before it.
    if (value === undefined || value === null) return [];
    const invalid = (path: ReadonlyArray<string>, problem: string) => new ConfigInvalid({ file: writerOf(layers, path), path: path.join("."), problem });
    if (!isMapping(value)) return yield* invalid(["mcpServers"], "Expected a mapping of names to servers");
    return yield* Effect.forEach(Object.entries(value), ([name, configured]) =>
      Effect.gen(function* () {
        const path = ["mcpServers", name];
        const remote = isMapping(configured) && (configured["type"] === "http" || configured["type"] === "sse");
        const server = yield* Schema.decodeUnknownEffect(remote ? RemoteServer : StdioServer)(configured, { onExcessProperty: "error" }).pipe(
          Effect.mapError((error) => invalid(path, problemOf(error))),
        );
        const timeout = server.connectTimeout === undefined ? undefined : Duration.fromInput(server.connectTimeout as Duration.Input);
        if (timeout !== undefined && timeout._tag === "None") return yield* invalid([...path, "connectTimeout"], `${JSON.stringify(server.connectTimeout)} is not a duration, such as "30 seconds"`);
        /** `text` at `at`, its variables the environment's. */
        const expand = (text: string, at: ReadonlyArray<string>) => {
          const done = expandedIn(text, env);
          return "value" in done ? Effect.succeed(done.value) : Effect.fail(invalid([...path, ...at], `\${${done.missing}} is not set, and has no default (\${${done.missing}:-default})`));
        };
        const expandAll = (record: Readonly<Record<string, string>> | undefined, key: string) =>
          Effect.map(
            Effect.forEach(Object.entries(record ?? {}), ([each, text]) => Effect.map(expand(text, [key, each]), (value) => [each, value] as const)),
            Object.fromEntries,
          );
        const timing = { required: server.required ?? false, ...(timeout?._tag === "Some" ? { connectTimeout: timeout.value } : {}) };
        if ("url" in server)
          return {
            name,
            transport: server.type,
            url: yield* expand(server.url, ["url"]),
            headers: yield* expandAll(server.headers, "headers"),
            ...timing,
          } satisfies McpServerConfig;
        return {
          name,
          command: yield* expand(server.command, ["command"]),
          args: yield* Effect.forEach(server.args ?? [], (arg, index) => expand(arg, ["args", String(index)])),
          env: yield* expandAll(server.env, "env"),
          ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
          ...timing,
        } satisfies McpServerConfig;
      }),
    );
  });

/** Fails with the first problem in `layer` taken alone: not a mapping, an unknown key, or extensions or MCP servers in an untrusted layer. */
const checkedLayer = (layer: LayerSource): Effect.Effect<void, ConfigInvalid> => {
  if (layer.value === undefined || layer.value === null) return Effect.void;
  if (!isMapping(layer.value)) return Effect.fail(new ConfigInvalid({ file: layer.name, path: "", problem: "Expected a mapping" }));
  const unknown = Object.keys(layer.value).find((key) => !topKeys.includes(key));
  if (unknown !== undefined) return Effect.fail(new ConfigInvalid({ file: layer.name, path: unknown, problem: `Not a key of the configuration; those are: ${topKeys.join(", ")}` }));
  if (!layer.trusted && layer.value["extensions"] !== undefined)
    return Effect.fail(new ConfigInvalid({ file: layer.name, path: "extensions", problem: "Extensions are loaded only from the user's own configuration: a project's does not run code" }));
  // A server is a command the session runs: a project's layer that names or changes one would run code that came with the project.
  if (!layer.trusted && layer.value["mcpServers"] !== undefined)
    return Effect.fail(new ConfigInvalid({ file: layer.name, path: "mcpServers", problem: "MCP servers are started only from the user's own configuration: a project's does not run commands" }));
  return Effect.void;
};

/** `layers`, merged and decoded against `registry`. */
export const decodeLayers = (
  layers: ReadonlyArray<LayerSource>,
  registry: ReadonlyArray<AnyPlugin>,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Effect.Effect<Configuration, ConfigInvalid> =>
  Effect.gen(function* () {
    yield* Effect.forEach(layers, checkedLayer, { discard: true });
    const value = merged(layers.map((layer) => layer.value ?? {}));
    const all = isMapping(value) ? value : {};
    const configured = yield* pluginsOf(layers, all["plugins"], registry);
    const listed = yield* Effect.forEach(
      seams.filter((seam) => all[seam] !== undefined),
      (seam) => Effect.map(listOf(layers, seam, all[seam], configured, registry), (entries) => [seam, entries] as const),
    );
    const maxHolds =
      all["maxHolds"] === undefined
        ? undefined
        : yield* Schema.decodeUnknownEffect(MaxHolds)(all["maxHolds"]).pipe(
            Effect.mapError((error) => new ConfigInvalid({ file: writerOf(layers, ["maxHolds"]), path: "maxHolds", problem: problemOf(error) })),
          );
    const lists: Configuration["lists"] = Object.fromEntries(listed);
    if ((lists.turnEnd?.length ?? 0) > 0 && maxHolds === undefined)
      return yield* new ConfigInvalid({ file: writerOf(layers, ["turnEnd"]), path: "maxHolds", problem: "Required when turnEnd lists hooks: how many times they may hold one turn open" });
    return { lists, ...(maxHolds === undefined ? {} : { maxHolds }), mcpServers: yield* mcpServersOf(layers, all["mcpServers"], env) };
  });

/** The layer in `file`, parsed, its extensions' paths made absolute; undefined when the file is not there. */
export const fileLayer = (file: string, trusted: boolean): Effect.Effect<LayerSource | undefined, ConfigInvalid, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const unreadable = (cause: unknown) => new ConfigInvalid({ file, path: "", problem: `Could not be read: ${String(cause)}` });
    if (!(yield* fs.exists(file).pipe(Effect.mapError(unreadable)))) return undefined;
    const text = yield* fs.readFileString(file).pipe(Effect.mapError(unreadable));
    const parsed = yield* Effect.try({ try: () => Yaml.parse(text), catch: (cause) => new ConfigInvalid({ file, path: "", problem: `Not YAML: ${String(cause)}` }) });
    if (!isMapping(parsed) || parsed["extensions"] === undefined) return { name: file, value: parsed ?? {}, trusted };
    const listed = parsed["extensions"];
    if (!Array.isArray(listed) || !listed.every((each): each is string => typeof each === "string"))
      return yield* new ConfigInvalid({ file, path: "extensions", problem: "Expected a list of module paths" });
    return { name: file, value: { ...parsed, extensions: listed.map((path) => (isAbsolute(path) ? path : resolve(dirname(file), path))) }, trusted };
  });

/**
 * The layers of `policyFiles`, those of `sources` (the user's alone, unless said), in order: the
 * user's file, which is trusted, then the project's and the local one, which are in the project's
 * folder, and are not. A folder's files are read only when named: one that comes with a cloned
 * project could turn off permission or give the model's commands credentials, until a folder can be
 * trusted. A file that is not there is left out.
 */
export const policyLayers = (
  project: string,
  options: { readonly name?: string; readonly home?: string; readonly sources?: ReadonlyArray<FileSource> } = {},
): Effect.Effect<ReadonlyArray<LayerSource>, ConfigInvalid, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const files = policyFiles(project, options);
    const read = fileSources.filter((source) => (options.sources ?? ["user"]).includes(source));
    const layers = yield* Effect.forEach(read, (source) => fileLayer(files[source], source === "user"));
    return layers.filter((layer): layer is LayerSource => layer !== undefined);
  });

const isPlugin = (value: unknown): value is AnyPlugin =>
  isMapping(value) &&
  typeof value["use"] === "string" &&
  Schema.isSchema(value["settings"]) &&
  isMapping((value["settings"] as { readonly fields?: unknown }).fields) &&
  Array.isArray(value["on"]) &&
  value["on"].every((seam) => seams.includes(seam as Seam)) &&
  typeof value["entries"] === "function";

/** The plug-ins a module exports by default: one, or a list. */
const loadExtension = (module: string, file: string): Effect.Effect<ReadonlyArray<AnyPlugin>, ConfigInvalid> =>
  Effect.tryPromise({
    try: () => import(pathToFileURL(module).href) as Promise<{ readonly default?: unknown }>,
    catch: (cause) => new ConfigInvalid({ file, path: "extensions", problem: `${module} could not be loaded: ${String(cause)}` }),
  }).pipe(
    Effect.flatMap((loaded) => {
      const exported = Array.isArray(loaded.default) ? loaded.default : [loaded.default];
      return exported.every(isPlugin)
        ? Effect.succeed(exported)
        : Effect.fail(new ConfigInvalid({ file, path: "extensions", problem: `${module} does not export a plug-in, or a list of them, by default` }));
    }),
  );

/**
 * The configuration in `layers`, in order, the last write winning, against `registry` (the built-in
 * plug-ins when not given) and the plug-ins the trusted layers' extensions export, each module
 * loaded once. A plug-in's name used twice is refused. The MCP servers' variables are `env`'s.
 */
export const loadConfiguration = (
  layers: ReadonlyArray<LayerSource>,
  registry: ReadonlyArray<AnyPlugin> = builtins,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Effect.Effect<Configuration, ConfigInvalid> =>
  Effect.gen(function* () {
    const modules = layers.flatMap((layer) => {
      const listed = layer.trusted && isMapping(layer.value) && Array.isArray(layer.value["extensions"]) ? layer.value["extensions"] : [];
      return listed.flatMap((module) => (typeof module === "string" ? [{ module, file: layer.name }] : []));
    });
    const unique = modules.filter((each, index) => modules.findIndex((other) => other.module === each.module) === index);
    const extended = (yield* Effect.forEach(unique, ({ module, file }) => loadExtension(module, file))).flat();
    const all = [...registry, ...extended];
    const twice = all.find((each, index) => all.findIndex((other) => other.use === each.use) !== index);
    if (twice !== undefined) return yield* new ConfigInvalid({ file: layers.map((layer) => layer.name).join(", "), path: "extensions", problem: `Two plug-ins are named ${twice.use}` });
    return yield* decodeLayers(layers, all, env);
  });
