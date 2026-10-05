/**
 * A session's configuration, read from layers merged in order, the last write winning (`merge.ts`):
 * the user's file (`~/.config/<name>/policies.yml`), the project's (`<project>/.<name>/policies.yml`),
 * the user's own for the project (`<project>/.<name>/policies.local.yml`), then what a host adds (a
 * settings file named on its command line, its flags). A file that does not exist is an empty layer.
 * `<name>` is `configName` unless the caller gives another. `docs/agent-config.md` lists what a layer
 * holds.
 *
 * - Only a trusted layer, the user's own, may name extensions or MCP servers, because both run code
 *   and a project's file comes with the project.
 * - The merged layers are decoded together. A mistake is refused with an error naming the layer that
 *   last wrote the value at fault, the path in it, and the problem. A plug-in's settings are decoded
 *   with its Schema, which refuses a property that the plug-in does not have.
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

/** The name of the configuration's folders unless a caller gives another: the default brand's (`agent-host/brand.ts`). */
export const configName = defaultBrand.name;

/** Which configuration file: the user's, the project's (kept with the project), or the user's own for the project (`local`, kept out of the project's history). */
export type FileSource = "user" | "project" | "local";

export const fileSources: ReadonlyArray<FileSource> = ["user", "project", "local"];

/**
 * Returns the paths of the files that a session's policies are read from, in order:
 * `~/.config/<name>/policies.yml`, `<project>/.<name>/policies.yml`,
 * `<project>/.<name>/policies.local.yml`.
 */
export const policyFiles = (project: string, options: { readonly name?: string; readonly home?: string } = {}): Readonly<Record<FileSource, string>> => {
  const name = options.name ?? configName;
  return {
    user: join(options.home ?? homedir(), ".config", name, "policies.yml"),
    project: join(project, `.${name}`, "policies.yml"),
    local: join(project, `.${name}`, "policies.local.yml"),
  };
};

/** A configuration that cannot be used: the layer, the path in it, and the problem. */
export class ConfigInvalid extends Data.TaggedError("ConfigInvalid")<{
  readonly file: string;
  readonly path: string;
  readonly problem: string;
}> {
  override get message(): string {
    return `${this.file}: ${this.path === "" ? "" : `${this.path}: `}${this.problem}`;
  }
}

/** One layer: the name that an error gives it (its file, or "the command line"), its value as parsed, and whether it is trusted to load extensions and start MCP servers. */
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

/** An MCP server that the configuration starts: run as a process, or reached at a URL, with its variables expanded. */
export type McpServerConfig = (McpServerStdio | McpServerRemote) & {
  /** Whether a session that cannot connect to the server must not open. */
  readonly required: boolean;
  readonly connectTimeout?: Duration.Input | undefined;
};

/** The decoded configuration: each seam that the layers list, in order; `maxHolds` when they give it; the MCP servers. A seam that no layer lists is absent. */
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

/** An MCP server that the session runs as a process. `type: stdio` is accepted, as Claude Code's `.mcp.json` writes it. */
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

/** An MCP server as a layer writes it; the file's JSON Schema is made from it too. */
export const McpServerSchema = Schema.Union([StdioServer, RemoteServer]);

/** `${VAR}` or `${VAR:-default}`. */
const variable = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/** Returns the value that `${name}` or `${name:-fallback}` expands to: the variable's value when it is set and not empty, else the fallback. */
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
  // Every variable has a value here, because the check above returned when one did not.
  return { value: text.replaceAll(variable, (whole, name: string, fallback: string | undefined) => expansionOf(env, name, fallback) ?? whole) };
};

/** Returns the problem that a Schema found, on one line. */
const problemOf = (error: Schema.SchemaError): string => error.message.replaceAll(/\s*\n\s*/g, " ");

/** Returns the value at `path` in `value`, or undefined. */
const at = (value: unknown, path: ReadonlyArray<string>): unknown => path.reduce<unknown>((inner, key) => (isMapping(inner) ? inner[key] : undefined), value);

/** Returns the name of the layer that last wrote `path`, or the deepest prefix of `path` that a layer wrote: the layer that an error at `path` names. */
const layerThatWrote = (layers: ReadonlyArray<LayerSource>, path: ReadonlyArray<string>): string => {
  const newestFirst = Arr.reverse(layers);
  // `path` itself first, then each shorter prefix of it.
  const prefixes = Arr.makeBy(path.length, (shorter) => path.slice(0, path.length - shorter));
  const writer = prefixes.map((prefix) => newestFirst.find((layer) => at(layer.value, prefix) !== undefined)).find((found) => found !== undefined);
  return writer?.name ?? layers.at(-1)?.name ?? "the configuration";
};

/** Decodes the plug-ins configured in `plugins`, by name, with their settings; each mistake names the layer that wrote it. */
const pluginsOf = (layers: ReadonlyArray<LayerSource>, value: unknown, registry: ReadonlyArray<AnyPlugin>): Effect.Effect<ReadonlyMap<string, Entry>, ConfigInvalid> =>
  Effect.gen(function* () {
    if (value === undefined) return new Map<string, Entry>();
    const invalid = (path: ReadonlyArray<string>, problem: string) => new ConfigInvalid({ file: layerThatWrote(layers, path), path: path.join("."), problem });
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

/** Decodes one seam's list: each name is a plug-in configured in `plugins`, or a plug-in's own name with its defaults, and must be on that seam. */
const listOf = (
  layers: ReadonlyArray<LayerSource>,
  seam: Seam,
  list: unknown,
  configured: ReadonlyMap<string, Entry>,
  registry: ReadonlyArray<AnyPlugin>,
): Effect.Effect<ReadonlyArray<Entry>, ConfigInvalid> => {
  const invalid = (problem: string, index?: number) => new ConfigInvalid({ file: layerThatWrote(layers, [seam]), path: index === undefined ? seam : `${seam}[${index}]`, problem });
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

/** Decodes the MCP servers in `mcpServers`, by name, with their variables expanded from `env`. */
const mcpServersOf = (layers: ReadonlyArray<LayerSource>, value: unknown, env: Readonly<Record<string, string | undefined>>): Effect.Effect<ReadonlyArray<McpServerConfig>, ConfigInvalid> =>
  Effect.gen(function* () {
    // `null` means no servers: a later layer that writes it removes the servers of the layers before it.
    if (value === undefined || value === null) return [];
    const invalid = (path: ReadonlyArray<string>, problem: string) => new ConfigInvalid({ file: layerThatWrote(layers, path), path: path.join("."), problem });
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
        /** Expands the variables in `text`, found at `at`; a missing variable fails with an error naming that path. */
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

/** Fails with the first problem in `layer` on its own: not a mapping, an unknown key, or extensions or MCP servers in an untrusted layer. */
const checkedLayer = (layer: LayerSource): Effect.Effect<void, ConfigInvalid> => {
  if (layer.value === undefined || layer.value === null) return Effect.void;
  if (!isMapping(layer.value)) return Effect.fail(new ConfigInvalid({ file: layer.name, path: "", problem: "Expected a mapping" }));
  const unknown = Object.keys(layer.value).find((key) => !topKeys.includes(key));
  if (unknown !== undefined) return Effect.fail(new ConfigInvalid({ file: layer.name, path: unknown, problem: `Not a key of the configuration; those are: ${topKeys.join(", ")}` }));
  if (!layer.trusted && layer.value["extensions"] !== undefined)
    return Effect.fail(new ConfigInvalid({ file: layer.name, path: "extensions", problem: "Extensions are loaded only from the user's own configuration: a project's does not run code" }));
  // A server is a command that the session runs, so a project's layer that names or changes one would run code that came with the project.
  if (!layer.trusted && layer.value["mcpServers"] !== undefined)
    return Effect.fail(new ConfigInvalid({ file: layer.name, path: "mcpServers", problem: "MCP servers are started only from the user's own configuration: a project's does not run commands" }));
  return Effect.void;
};

/** Merges `layers` and decodes the result against `registry`. */
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
            Effect.mapError((error) => new ConfigInvalid({ file: layerThatWrote(layers, ["maxHolds"]), path: "maxHolds", problem: problemOf(error) })),
          );
    const lists: Configuration["lists"] = Object.fromEntries(listed);
    if ((lists.turnEnd?.length ?? 0) > 0 && maxHolds === undefined)
      return yield* new ConfigInvalid({ file: layerThatWrote(layers, ["turnEnd"]), path: "maxHolds", problem: "Required when turnEnd lists hooks: how many times they may hold one turn open" });
    return { lists, ...(maxHolds === undefined ? {} : { maxHolds }), mcpServers: yield* mcpServersOf(layers, all["mcpServers"], env) };
  });

/** Reads and parses the layer in `file`, with its extensions' paths made absolute; undefined when the file does not exist. */
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
 * Reads the layers of `policyFiles` named in `sources` (only the user's, unless given), in order: the
 * user's file, which is trusted, then the project's and the local one, which are in the project's
 * folder and are not trusted. A folder's files are read only when named, because a file that comes
 * with a cloned project could turn off permission or give the model's commands credentials. A file
 * that does not exist is omitted.
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

/** Loads the plug-ins that a module exports by default: one plug-in, or a list. */
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
 * Decodes the configuration in `layers`, in order, the last write winning, against `registry` (the
 * built-in plug-ins when not given) and the plug-ins that the trusted layers' extensions export; each
 * module is loaded once. A plug-in name used twice is refused. The MCP servers' variables are
 * expanded from `env`.
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
