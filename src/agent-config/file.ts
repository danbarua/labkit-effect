/**
 * A session's configuration, read from layers merged in order, the last write winning (`merge.ts`):
 * the user's file (`~/.config/<name>/policies.yml`), then the project's (`<project>/.<name>/policies.yml`),
 * then what a host adds (a settings file named on its command line, its flags). A file that is not
 * there is an empty layer. `<name>` is `configName` unless the caller says another.
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
 * - `mcpServers`: the MCP servers a session starts, by name, each its `command`, `args`, `env`, `cwd`,
 *   whether the session needs it (`required`), and how long it has to connect (`connectTimeout`).
 * - `extensions`: modules to load, each exporting by default a plug-in or a list of them, a path
 *   relative to its file's folder. Only a trusted layer, the user's own, may name them: a project's
 *   file comes with the project, and does not run code.
 *
 * The layers are decoded merged. A mistake is refused naming the layer that last wrote the value at
 * fault, where in it, and what is wrong. A plug-in's settings are decoded with its Schema, refusing a
 * property it does not have.
 */

import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Data, Duration, Effect, FileSystem, Schema } from "effect";
import { Yaml } from "effect/encoding";
import { builtins } from "./builtins.ts";
import { merged } from "./merge.ts";
import { type AnyPlugin, type Seam, seams } from "./plugin.ts";

/** The name of the configuration's folders, until the product has one. */
export const configName = "labkit";

/** The files a session's policies are read from, the user's first: `~/.config/<name>/policies.yml`, `<project>/.<name>/policies.yml`. */
export const policyFiles = (project: string, options: { readonly name?: string; readonly home?: string } = {}): ReadonlyArray<string> => {
  const name = options.name ?? configName;
  return [join(options.home ?? homedir(), ".config", name, "policies.yml"), join(project, `.${name}`, "policies.yml")];
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

/** An MCP server the configuration starts. */
export interface McpServerConfig {
  readonly name: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string | undefined;
  /** Whether a session that cannot connect to it is not to open. */
  readonly required: boolean;
  readonly connectTimeout?: Duration.Input | undefined;
}

/** The configuration decoded: each seam the layers list, in order; `maxHolds` when they say it; the MCP servers. A seam no layer lists is left out. */
export interface Configuration {
  readonly lists: Partial<Record<Seam, ReadonlyArray<Entry>>>;
  readonly maxHolds?: number;
  readonly mcpServers: ReadonlyArray<McpServerConfig>;
}

const isMapping = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);

const topKeys: ReadonlyArray<string> = ["plugins", ...seams, "maxHolds", "mcpServers", "extensions"];

const MaxHolds = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const McpServer = Schema.Struct({
  command: Schema.NonEmptyString,
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  cwd: Schema.optionalKey(Schema.String),
  required: Schema.optionalKey(Schema.Boolean),
  /** A duration: `30 seconds`, `500 millis`. */
  connectTimeout: Schema.optionalKey(Schema.String),
});

/** The problem a Schema found, on one line. */
const problemOf = (error: Schema.SchemaError): string => error.message.replaceAll(/\s*\n\s*/g, " ");

/** The value at `path` in `value`, or undefined. */
const at = (value: unknown, path: ReadonlyArray<string>): unknown => path.reduce<unknown>((inner, key) => (isMapping(inner) ? inner[key] : undefined), value);

/** The layer that last wrote `path`, or the deepest part of it that one wrote: what an error at `path` names. */
const writerOf = (layers: ReadonlyArray<LayerSource>, path: ReadonlyArray<string>): string => {
  for (let length = path.length; length > 0; length--) {
    const writer = [...layers].reverse().find((layer) => at(layer.value, path.slice(0, length)) !== undefined);
    if (writer !== undefined) return writer.name;
  }
  return layers.at(-1)?.name ?? "the configuration";
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
        const plugin = registry.find((each) => each.use === use);
        if (plugin === undefined) return yield* invalid(configured !== null && "use" in configured ? [...path, "use"] : path, `${JSON.stringify(use)} is not a plug-in; those are: ${registry.map((each) => each.use).join(", ")}`);
        // Each setting decoded alone first, so that a mistake names the layer that wrote it.
        for (const [key, setting] of Object.entries(settings)) {
          const field = plugin.settings.fields[key];
          if (field === undefined) return yield* invalid([...path, key], `${use} has no setting ${key}; its settings are: ${Object.keys(plugin.settings.fields).join(", ")}`);
          // A plug-in's settings decode with no services (`AnyPlugin`), and so does each of them.
          const alone = Schema.Struct({ [key]: field }) as unknown as Schema.Codec<unknown, unknown>;
          const one = yield* Effect.result(Schema.decodeUnknownEffect(alone)({ [key]: setting }));
          if (one._tag === "Failure") return yield* invalid([...path, key], problemOf(one.failure));
        }
        const decoded = yield* Schema.decodeUnknownEffect(plugin.settings)(settings, { onExcessProperty: "error" }).pipe(Effect.mapError((error) => invalid(path, problemOf(error))));
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
          : { name, plugin: own, settings: yield* Schema.decodeUnknownEffect(own.settings)({}).pipe(Effect.mapError((error) => invalid(problemOf(error), index))) });
      if (entry === undefined)
        return yield* invalid(`${JSON.stringify(name)} is neither in plugins nor a plug-in; the plug-ins are: ${registry.map((each) => each.use).join(", ")}`, index);
      if (!entry.plugin.on.includes(seam))
        return yield* invalid(`${name} is ${entry.plugin.use}, which is not on ${seam}; it is on ${entry.plugin.on.join(", ")}`, index);
      return entry;
    }),
  );
};

/** The MCP servers in `mcpServers`, by name. */
const mcpServersOf = (layers: ReadonlyArray<LayerSource>, value: unknown): Effect.Effect<ReadonlyArray<McpServerConfig>, ConfigInvalid> =>
  Effect.gen(function* () {
    if (value === undefined) return [];
    const invalid = (path: ReadonlyArray<string>, problem: string) => new ConfigInvalid({ file: writerOf(layers, path), path: path.join("."), problem });
    if (!isMapping(value)) return yield* invalid(["mcpServers"], "Expected a mapping of names to servers");
    return yield* Effect.forEach(Object.entries(value), ([name, configured]) =>
      Effect.gen(function* () {
        const path = ["mcpServers", name];
        const server = yield* Schema.decodeUnknownEffect(McpServer)(configured, { onExcessProperty: "error" }).pipe(Effect.mapError((error) => invalid(path, problemOf(error))));
        const timeout = server.connectTimeout === undefined ? undefined : Duration.fromInput(server.connectTimeout as Duration.Input);
        if (timeout !== undefined && timeout._tag === "None") return yield* invalid([...path, "connectTimeout"], `${JSON.stringify(server.connectTimeout)} is not a duration, such as "30 seconds"`);
        return {
          name,
          command: server.command,
          args: server.args ?? [],
          env: server.env ?? {},
          ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
          required: server.required ?? false,
          ...(timeout?._tag === "Some" ? { connectTimeout: timeout.value } : {}),
        };
      }),
    );
  });

/** `layers`, merged and decoded against `registry`. */
export const decodeLayers = (layers: ReadonlyArray<LayerSource>, registry: ReadonlyArray<AnyPlugin>): Effect.Effect<Configuration, ConfigInvalid> =>
  Effect.gen(function* () {
    for (const layer of layers) {
      if (layer.value === undefined || layer.value === null) continue;
      if (!isMapping(layer.value)) return yield* new ConfigInvalid({ file: layer.name, path: "", problem: "Expected a mapping" });
      const unknown = Object.keys(layer.value).find((key) => !topKeys.includes(key));
      if (unknown !== undefined) return yield* new ConfigInvalid({ file: layer.name, path: unknown, problem: `Not a key of the configuration; those are: ${topKeys.join(", ")}` });
      if (!layer.trusted && layer.value["extensions"] !== undefined)
        return yield* new ConfigInvalid({ file: layer.name, path: "extensions", problem: "Extensions are loaded only from the user's own configuration: a project's does not run code" });
    }
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
    return { lists, ...(maxHolds === undefined ? {} : { maxHolds }), mcpServers: yield* mcpServersOf(layers, all["mcpServers"]) };
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

/** The layers of `policyFiles`: the user's file, trusted, then the project's, not; a file that is not there is left out. */
export const policyLayers = (project: string, options: { readonly name?: string; readonly home?: string } = {}): Effect.Effect<ReadonlyArray<LayerSource>, ConfigInvalid, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const [user, own] = policyFiles(project, options);
    const layers = [yield* fileLayer(user!, true), yield* fileLayer(own!, false)];
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
 * loaded once. A plug-in's name used twice is refused.
 */
export const loadConfiguration = (layers: ReadonlyArray<LayerSource>, registry: ReadonlyArray<AnyPlugin> = builtins): Effect.Effect<Configuration, ConfigInvalid> =>
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
    return yield* decodeLayers(layers, all);
  });
