/**
 * The JSON Schema of a policies file, made from the Schemas of the plug-ins registered, so that an
 * editor checks a file as it is typed (a `# yaml-language-server: $schema=<path>` comment at its
 * top): `plugins` takes, under a plug-in's own name, that plug-in's settings, and under any other
 * name `use` and the settings of the plug-in it names, and no other property; each seam's list
 * takes names; `mcpServers` takes servers.
 */

import { Schema } from "effect";
import { jsonSchemaOf } from "../agent-session/tool-input.ts";
import { builtins } from "./builtins.ts";
import { McpServerSchema } from "./file.ts";
import { type AnyPlugin, seams } from "./plugin.ts";


/**
 * The JSON Schema of a file whose plug-ins are `registry`'s (the built-ins when not given).
 * `plugins` is written out here: its plug-ins' own names as `properties` and any other name as
 * `additionalProperties`, side by side, so that the one does not apply to the other.
 */
export const policiesJsonSchema = (registry: ReadonlyArray<AnyPlugin> = builtins): Schema.Json => {
  const rest = jsonSchemaOf(
    Schema.Struct({
      extensions: Schema.optionalKey(Schema.Array(Schema.String)),
      maxHolds: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
      mcpServers: Schema.optionalKey(Schema.Record(Schema.String, McpServerSchema)),
      ...Object.fromEntries(seams.map((seam) => [seam, Schema.optionalKey(Schema.Array(Schema.String))])),
    }),
  ) as { readonly properties: Readonly<Record<string, Schema.Json>> };
  const plugins: Schema.Json = {
    type: "object",
    properties: Object.fromEntries(registry.map((plugin) => [plugin.use, jsonSchemaOf(Schema.Struct(plugin.settings.fields))])),
    additionalProperties: { anyOf: registry.map((plugin) => jsonSchemaOf(Schema.Struct({ use: Schema.Literal(plugin.use), ...plugin.settings.fields }))) },
  };
  return { ...rest, properties: { plugins, ...rest.properties } } as Schema.Json;
};
