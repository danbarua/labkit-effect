/**
 * A tool's input from one Schema: the JSON Schema the model is offered (`ToolSpec.input`), and the
 * decoder its runner reads a call's input with. Both refuse properties the Schema does not have,
 * so what the model is told and what is accepted are the same.
 */

import { type Effect, Schema } from "effect";

/** The JSON Schema of `schema`'s input, closed to other properties; its definitions, if any, as `$defs`. */
export const jsonSchemaOf = (schema: Schema.Top): Schema.Json => {
  const document = Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" });
  const json = document.schema as Readonly<Record<string, Schema.Json>>;
  return Object.keys(document.definitions).length === 0 ? json : { ...json, $defs: document.definitions as Readonly<Record<string, Schema.Json>> };
};

/** Decodes a call's input with `schema`, refusing properties it does not have, as `jsonSchemaOf` says. */
export const decoderOf =
  <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
  (input: unknown): Effect.Effect<S["Type"], Schema.SchemaError> =>
    Schema.decodeUnknownEffect(schema)(input, { onExcessProperty: "error" });
