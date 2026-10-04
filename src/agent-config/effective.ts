/**
 * What a session's configuration resolved to, for a person finding out why a session did what it
 * did (`effective-settings.json`): the layers, in order; each seam's entries, by name, with their
 * plug-in and every setting as resolved, defaults included; `maxHolds`; the MCP servers; for every
 * value the layers wrote, the layer that wrote it last (`from`); and what the host says beside the
 * layers (`host`). An MCP server's environment is given by its variables' names, never their values.
 */

import type { Schema } from "effect";
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
    args: [...server.args],
    env: Object.keys(server.env),
    ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
    required: server.required,
    ...(server.connectTimeout === undefined ? {} : { connectTimeout: String(server.connectTimeout) }),
  })),
  from: sourcesOf(layers),
  host,
});
