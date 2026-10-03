/**
 * The JSON Schema of a policies file, made from the Schemas of the plug-ins registered, so that an
 * editor checks a file as it is typed (a `# yaml-language-server: $schema=<path>` comment at its
 * top): each seam's entries name a plug-in registered on it and take that plug-in's settings and
 * no other property.
 */

import { Schema } from "effect";
import { jsonSchemaOf } from "../agent-session/tool-input.ts";
import { builtins } from "./builtins.ts";
import { type AnyPlugin, seams } from "./plugin.ts";

/** The Schema of a file whose entries are `registry`'s plug-ins. */
export const fileSchemaOf = (registry: ReadonlyArray<AnyPlugin>) => {
  const entryOf = (plugin: AnyPlugin) => Schema.Struct({ use: Schema.Literal(plugin.use), ...plugin.settings.fields });
  const listOf = (on: ReadonlyArray<AnyPlugin>) => {
    const [first, ...rest] = on.map(entryOf);
    return Schema.optionalKey(Schema.Array(first === undefined ? Schema.Never : rest.length === 0 ? first : Schema.Union([first, ...rest])));
  };
  return Schema.Struct({
    extensions: Schema.optionalKey(Schema.Array(Schema.String)),
    maxHolds: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    ...Object.fromEntries(seams.map((seam) => [seam, listOf(registry.filter((plugin) => plugin.on.includes(seam)))])),
  });
};

/** The JSON Schema of a file whose entries are `registry`'s plug-ins (the built-ins when not given). */
export const policiesJsonSchema = (registry: ReadonlyArray<AnyPlugin> = builtins): Schema.Json => jsonSchemaOf(fileSchemaOf(registry));
