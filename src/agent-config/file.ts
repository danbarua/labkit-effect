/**
 * A session's policies, read from configuration files (`policies.yml`): the user's
 * (`~/.config/<name>/policies.yml`), then the project's (`<project>/.<name>/policies.yml`), merged
 * in that order, the last write winning (`merge.ts`). A file that is not there is an empty layer.
 * `<name>` is `configName` unless the caller says another.
 *
 * A file is YAML (read with `effect/encoding` `Yaml`), a mapping of:
 *
 * - a list for each seam (`toolCalls`, `modelRequests`, `turnEnd`, `knownModels`, `settling`,
 *   `toolSources`), in order, each entry `use: <plug-in>` and that plug-in's settings;
 * - `maxHolds`, how many times the turn-end hooks may hold one turn open, which a file that lists
 *   turn-end hooks must say, here or in another layer;
 * - `extensions`, modules to load, each path relative to the file's folder, each exporting by
 *   default a plug-in or a list of them.
 *
 * Each file is decoded alone, so that a mistake names the file it is in; the merged layers are
 * decoded again. An entry is decoded in two steps: its `use` against the plug-ins registered on its
 * seam, then the rest with that plug-in's Schema, refusing a property it does not have. The
 * extensions of every layer are loaded, in order, before any entry is decoded.
 */

import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Data, Effect, FileSystem, Schema } from "effect";
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

/** A configuration that cannot be used: the file, where in it, and what is wrong. */
export class ConfigInvalid extends Data.TaggedError("ConfigInvalid")<{
  readonly file: string;
  readonly path: string;
  readonly problem: string;
}> {
  override get message(): string {
    return `${this.file}: ${this.path === "" ? "" : `${this.path}: `}${this.problem}`;
  }
}

/** One entry of a seam: its plug-in, and its settings as the plug-in's Schema decoded them. */
export interface Entry {
  readonly plugin: AnyPlugin;
  readonly settings: unknown;
}

/** The configuration decoded: each seam the files list, in order, and `maxHolds` when they say it. A seam no file lists is left out. */
export interface Configuration {
  readonly lists: Partial<Record<Seam, ReadonlyArray<Entry>>>;
  readonly maxHolds?: number;
}

const isMapping = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);

const topKeys: ReadonlyArray<string> = [...seams, "maxHolds", "extensions"];

const MaxHolds = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** The problem a Schema found, on one line. */
const problemOf = (error: Schema.SchemaError): string => error.message.replaceAll(/\s*\n\s*/g, " ");

/** The entries of one seam's list, decoded against the plug-ins registered on it. */
const entriesOf = (seam: Seam, list: unknown, registry: ReadonlyArray<AnyPlugin>, file: string): Effect.Effect<ReadonlyArray<Entry>, ConfigInvalid> => {
  if (!Array.isArray(list)) return Effect.fail(new ConfigInvalid({ file, path: seam, problem: "Expected a list of entries, each `use: <plug-in>` and its settings" }));
  const on = registry.filter((each) => each.on.includes(seam));
  return Effect.forEach(list, (entry: unknown, index) => {
    const path = `${seam}[${index}]`;
    if (!isMapping(entry) || typeof entry["use"] !== "string")
      return Effect.fail(new ConfigInvalid({ file, path, problem: "Expected a mapping with `use: <plug-in>`" }));
    const { use, ...settings } = entry;
    const plugin = on.find((each) => each.use === use);
    if (plugin === undefined) {
      const names = on.length === 0 ? "none is registered" : `those are: ${on.map((each) => each.use).join(", ")}`;
      return Effect.fail(new ConfigInvalid({ file, path: `${path}.use`, problem: `${JSON.stringify(use)} is not a plug-in on ${seam}; ${names}` }));
    }
    return Schema.decodeUnknownEffect(plugin.settings)(settings, { onExcessProperty: "error" }).pipe(
      Effect.map((decoded): Entry => ({ plugin, settings: decoded })),
      Effect.mapError((error) => new ConfigInvalid({ file, path, problem: `${use}: ${problemOf(error)}` })),
    );
  });
};

/** One layer, or the merged layers, decoded against `registry`. `file` names it in an error. */
export const decodeConfiguration = (value: unknown, registry: ReadonlyArray<AnyPlugin>, file: string): Effect.Effect<Configuration, ConfigInvalid> =>
  Effect.gen(function* () {
    if (value === undefined || value === null) return { lists: {} };
    if (!isMapping(value)) return yield* new ConfigInvalid({ file, path: "", problem: "Expected a mapping" });
    const unknown = Object.keys(value).find((key) => !topKeys.includes(key));
    if (unknown !== undefined) return yield* new ConfigInvalid({ file, path: unknown, problem: `Not a key of the file; those are: ${topKeys.join(", ")}` });
    const listed = yield* Effect.forEach(
      seams.filter((seam) => value[seam] !== undefined),
      (seam) => Effect.map(entriesOf(seam, value[seam], registry, file), (entries) => [seam, entries] as const),
    );
    const maxHolds =
      value["maxHolds"] === undefined
        ? undefined
        : yield* Schema.decodeUnknownEffect(MaxHolds)(value["maxHolds"]).pipe(
            Effect.mapError((error) => new ConfigInvalid({ file, path: "maxHolds", problem: problemOf(error) })),
          );
    return { lists: Object.fromEntries(listed), ...(maxHolds === undefined ? {} : { maxHolds }) };
  });

/** One file, parsed, with its extensions' paths made absolute; undefined when it is not there. */
interface Layer {
  readonly file: string;
  readonly value: Readonly<Record<string, unknown>>;
  readonly extensions: ReadonlyArray<string>;
}

const readLayer = (file: string): Effect.Effect<Layer | undefined, ConfigInvalid, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const unreadable = (cause: unknown) => new ConfigInvalid({ file, path: "", problem: `Could not be read: ${String(cause)}` });
    if (!(yield* fs.exists(file).pipe(Effect.mapError(unreadable)))) return undefined;
    const text = yield* fs.readFileString(file).pipe(Effect.mapError(unreadable));
    const parsed = yield* Effect.try({ try: () => Yaml.parse(text), catch: (cause) => new ConfigInvalid({ file, path: "", problem: `Not YAML: ${String(cause)}` }) });
    if (parsed === undefined || parsed === null) return { file, value: {}, extensions: [] };
    if (!isMapping(parsed)) return yield* new ConfigInvalid({ file, path: "", problem: "Expected a mapping" });
    const listed = parsed["extensions"] ?? [];
    if (!Array.isArray(listed) || !listed.every((each): each is string => typeof each === "string"))
      return yield* new ConfigInvalid({ file, path: "extensions", problem: "Expected a list of module paths" });
    const extensions = listed.map((path) => (isAbsolute(path) ? path : resolve(dirname(file), path)));
    return { file, value: { ...parsed, extensions }, extensions };
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
 * The configuration in `files`, in order, the last write winning, against `registry` (the built-in
 * plug-ins when not given) and the plug-ins the files' extensions export. A plug-in's name used twice
 * is refused.
 */
export const loadConfiguration = (
  files: ReadonlyArray<string>,
  registry: ReadonlyArray<AnyPlugin> = builtins,
): Effect.Effect<Configuration, ConfigInvalid, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const layers = (yield* Effect.forEach(files, readLayer)).filter((layer): layer is Layer => layer !== undefined);
    const modules = layers.flatMap((layer) => layer.extensions.map((module) => ({ module, file: layer.file })));
    const unique = modules.filter((each, index) => modules.findIndex((other) => other.module === each.module) === index);
    const extended = (yield* Effect.forEach(unique, ({ module, file }) => loadExtension(module, file))).flat();
    const all = [...registry, ...extended];
    const twice = all.find((each, index) => all.findIndex((other) => other.use === each.use) !== index);
    if (twice !== undefined)
      return yield* new ConfigInvalid({ file: files.join(", "), path: "extensions", problem: `Two plug-ins are named ${twice.use}` });
    yield* Effect.forEach(layers, (layer) => decodeConfiguration(layer.value, all, layer.file), { discard: true });
    const configuration = yield* decodeConfiguration(merged(layers.map((layer) => layer.value)), all, files.join(", "));
    if ((configuration.lists.turnEnd?.length ?? 0) > 0 && configuration.maxHolds === undefined)
      return yield* new ConfigInvalid({ file: files.join(", "), path: "maxHolds", problem: "Required when turnEnd lists hooks: how many times they may hold one turn open" });
    return configuration;
  });
