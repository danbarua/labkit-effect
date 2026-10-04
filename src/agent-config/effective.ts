/**
 * What a session's configuration resolved to, for a person finding out why a session did what it
 * did (`effective-settings.json`): the layers, in order; each seam's entries, by name, with their
 * plug-in and every setting as resolved, defaults included; `maxHolds`; the MCP servers; for every
 * value the layers wrote, the layer that wrote it last (`from`); and what the host says beside the
 * layers (`host`). An MCP server's environment is given by its variables' names, never their values,
 * and the value of an argument whose flag names a credential is left out (`redactedArgs`).
 */

import { Effect, FileSystem, type PlatformError, type Schema } from "effect";
import { redactedArgs } from "../agent-process/environment.ts";
import type { Configuration, LayerSource } from "./file.ts";
import { merged } from "./merge.ts";

const isMapping = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Every path of `value` to a value that is not a mapping, written as `a.b.c`. */
const leaves = (value: unknown, path: ReadonlyArray<string> = []): ReadonlyArray<ReadonlyArray<string>> =>
  isMapping(value) ? Object.entries(value).flatMap(([key, inner]) => leaves(inner, [...path, key])) : path.length === 0 ? [] : [path];

const at = (value: unknown, path: ReadonlyArray<string>): unknown => path.reduce<unknown>((inner, key) => (isMapping(inner) ? inner[key] : undefined), value);

/** For each value the merged layers have, the layer that wrote it last. */
export const sourcesOf = (layers: ReadonlyArray<LayerSource>): Readonly<Record<string, string>> =>
  Object.fromEntries(
    leaves(merged(layers.map((layer) => layer.value ?? {}))).map((path) => [
      path.join("."),
      [...layers].reverse().find((layer) => at(layer.value, path) !== undefined)?.name ?? "",
    ]),
  );

/** The name of the file a session's folder keeps `effectiveSettings` in. */
export const effectiveSettingsFile = "effective-settings.json";

/** Writes `effectiveSettings` to `folder` (made when missing) as `effective-settings.json`; the file's path. */
export const writeEffectiveSettings = (
  folder: string,
  layers: ReadonlyArray<LayerSource>,
  configuration: Configuration,
  host: Readonly<Record<string, Schema.Json>> = {},
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = `${folder}/${effectiveSettingsFile}`;
    yield* fs.makeDirectory(folder, { recursive: true });
    yield* fs.writeFileString(path, `${JSON.stringify(effectiveSettings(layers, configuration, host), null, 2)}\n`);
    return path;
  });

/** The configuration as resolved from `layers`, with what the host says (`host`). */
export const effectiveSettings = (layers: ReadonlyArray<LayerSource>, configuration: Configuration, host: Readonly<Record<string, Schema.Json>> = {}): Schema.Json => ({
  layers: layers.map((layer) => ({ name: layer.name, trusted: layer.trusted })),
  lists: Object.fromEntries(
    Object.entries(configuration.lists).map(([seam, entries]) => [seam, entries.map((entry) => ({ name: entry.name, use: entry.plugin.use, settings: entry.settings as Schema.Json }))]),
  ),
  ...(configuration.maxHolds === undefined ? {} : { maxHolds: configuration.maxHolds }),
  mcpServers: configuration.mcpServers.map((server) => ({
    name: server.name,
    command: server.command,
    args: [...redactedArgs(server.args)],
    env: Object.keys(server.env),
    ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
    required: server.required,
    ...(server.connectTimeout === undefined ? {} : { connectTimeout: String(server.connectTimeout) }),
  })),
  from: sourcesOf(layers),
  host,
});
