/**
 * A tool's input from one Schema: the JSON Schema the model is offered (`ToolSpec.input`), closed to
 * properties the Schema does not have, and the decoder its runner reads a call's input with, which
 * refuses such properties when strict and otherwise leaves them out and names them.
 */

import { Effect, Schema } from "effect";

/** The JSON Schema of `schema`'s input, closed to other properties; its definitions, if any, as `$defs`. */
export const jsonSchemaOf = (schema: Schema.Top): Schema.Json => {
  const document = Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" });
  const json = document.schema as Readonly<Record<string, Schema.Json>>;
  return Object.keys(document.definitions).length === 0 ? json : { ...json, $defs: document.definitions as Readonly<Record<string, Schema.Json>> };
};

/** A call's input as decoded, and the properties of it its tool does not take, which were left out. */
export interface Decoded<A> {
  readonly value: A;
  readonly ignored: ReadonlyArray<string>;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The paths of `input`'s properties that `kept` (the input as accepted, encoded back) does not have. */
const excessIn = (input: unknown, kept: unknown, at: string): ReadonlyArray<string> => {
  if (Array.isArray(input) && Array.isArray(kept)) return input.flatMap((each, index) => excessIn(each, kept[index], `${at}[${index}]`));
  if (!isRecord(input) || !isRecord(kept)) return [];
  return Object.keys(input).flatMap((key) => {
    const path = at === "" ? key : `${at}.${key}`;
    return key in kept ? excessIn(input[key], kept[key], path) : [path];
  });
};

/**
 * Decodes a call's input with `schema`. With `strict`, an input with properties the Schema does not
 * have is refused, as `jsonSchemaOf` says; without, it is accepted without them, and they are named
 * (`ignored`) so the call's result can say so.
 */
export const decoderOf =
  <S extends Schema.Top & { readonly DecodingServices: never; readonly EncodingServices: never }>(schema: S, strict: boolean) =>
  (input: unknown): Effect.Effect<Decoded<S["Type"]>, Schema.SchemaError> =>
    strict
      ? Effect.map(Schema.decodeUnknownEffect(schema)(input, { onExcessProperty: "error" }), (value) => ({ value, ignored: [] }))
      : Effect.gen(function* () {
          const value = yield* Schema.decodeUnknownEffect(schema)(input);
          const kept = yield* Schema.encodeUnknownEffect(schema)(value);
          return { value, ignored: excessIn(input, kept, "") };
        });

/** What a call's result says of the properties of its input that were ignored, if any. */
export const ignoredNote = (tool: string, ignored: ReadonlyArray<string>): string =>
  ignored.length === 0 ? "" : `\n[Not inputs of ${tool}, so ignored: ${ignored.join(", ")}.]`;
