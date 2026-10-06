/**
 * The JSON Schema of a configuration file, made from the registered plug-ins' Schemas, so that an editor
 * checks a file as it is typed (a `# yaml-language-server: $schema=<path>` comment at its top). The
 * schema accepts, in `plugins`:
 *
 * - under a plug-in's own name, that plug-in's settings without `use`, or `null` (its defaults);
 * - under any other name, `use` and the settings of the plug-in it names;
 *
 * and no other property. Each seam's list accepts names. `mcpServers` accepts servers, or `null`.
 */

import { Schema } from "effect";
import { jsonSchemaOf } from "../agent-session/tool-input.ts";
import { builtins } from "./builtins.ts";
import { McpServerSchema, View } from "./file.ts";
import { type AnyPlugin, seams } from "./plugin.ts";
import { ModelOverride } from "../agent-session/configuration/well-known-models.ts";


/**
 * Returns the JSON Schema of a file whose plug-ins are `registry`'s (the built-ins when not given).
 * `plugins` is written out here: the plug-ins' own names as `properties` and any other name as
 * `additionalProperties`, side by side, so that neither applies to the other's names.
 */
export const configJsonSchema = (registry: ReadonlyArray<AnyPlugin> = builtins): Schema.Json => {
  const rest = jsonSchemaOf(
    Schema.Struct({
      extensions: Schema.optionalKey(Schema.Array(Schema.String)),
      maxHolds: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
      // `null` removes the servers of the layers before it.
      mcpServers: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, McpServerSchema))),
      ...Object.fromEntries(seams.map((seam) => [seam, Schema.optionalKey(Schema.Array(Schema.String))])),
      // The model that sessions start with, as provider/model.
      model: Schema.optionalKey(Schema.NonEmptyString),
      // What is known of models, by provider/model, over the catalog; `null` removes the overrides of the layers before it.
      models: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.NullOr(ModelOverride)))),
      // What the CLI shows the user: thinking on or off.
      view: Schema.optionalKey(Schema.NullOr(View)),
    }),
  ) as { readonly properties: Readonly<Record<string, Schema.Json>> };
  const plugins: Schema.Json = {
    type: "object",
    // `null` under a plug-in's own name is the plug-in with its defaults, as the merge treats it.
    properties: Object.fromEntries(registry.map((plugin) => [plugin.use, jsonSchemaOf(Schema.NullOr(Schema.Struct(plugin.settings.fields)))])),
    additionalProperties: { anyOf: registry.map((plugin) => jsonSchemaOf(Schema.Struct({ use: Schema.Literal(plugin.use), ...plugin.settings.fields }))) },
  };
  return { ...rest, properties: { plugins, ...rest.properties } } as Schema.Json;
};
