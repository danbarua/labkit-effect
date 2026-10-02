import { expect, setDefaultTimeout } from "bun:test";
import { Effect, Exit, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";
import * as zodV1 from "../../../node_modules/@agentclientprotocol/sdk/dist/schema/zod.gen.js";
import * as zodV2 from "../../../node_modules/@agentclientprotocol/sdk/dist/v2/schema/zod.gen.js";
import { installed } from "../../../scripts/acp-schema.ts";
import { test } from "../../../tests/support/test.ts";
import * as v1 from "./v1.gen.ts";
import * as v2 from "./v2.gen.ts";

setDefaultTimeout(120_000);

const samples = 250;

const { documents } = installed(process.cwd());

/** The definitions named by an `x-method`: every request, response and notification of the version. */
function methodDefinitions(document: unknown): ReadonlyArray<string> {
  const { $defs } = Schema.decodeUnknownSync(Schema.Struct({ $defs: Schema.Record(Schema.String, Schema.Struct({ "x-method": Schema.optionalKey(Schema.String) })) }))(document);
  return Object.entries($defs)
    .filter(([, definition]) => definition["x-method"] !== undefined)
    .map(([name]) => name);
}

interface ZodLike {
  readonly safeParse: (input: unknown) => { readonly success: boolean; readonly data?: unknown; readonly error?: { readonly message: string } | undefined };
}

const isZod = (input: unknown): input is ZodLike => typeof input === "object" && input !== null && "safeParse" in input && typeof input.safeParse === "function";

/**
 * Samples every method definition of `schemas` and checks that each sample encodes to JSON the
 * SDK's zod schema of the same name accepts, and that what the SDK makes of it (with its defaults
 * filled in) decodes here. Returns the failures, and how many were checked.
 */
function conformance(document: unknown, schemas: object, zod: object) {
  const failures: Array<{ readonly definition: string; readonly json: unknown; readonly error: string }> = [];
  let checked = 0;
  const definitions = methodDefinitions(document);
  for (const definition of definitions) {
    const schema: unknown = Reflect.get(schemas, definition);
    const validator: unknown = Reflect.get(zod, `z${definition}`);
    if (!Schema.isSchema(schema) || !isZod(validator)) throw new Error(`${definition}: no schema or no zod validator`);
    const codec = schema as Schema.Codec<unknown, unknown>;
    const encode = Schema.encodeUnknownSync(codec);
    const values = Effect.runSync(Arbitrary.sampleEffect(Arbitrary.schema(codec), { count: samples }));
    for (const value of values) {
      checked += 1;
      const json: unknown = JSON.parse(JSON.stringify(encode(value)));
      const result = validator.safeParse(json);
      if (!result.success) failures.push({ definition, json, error: `the SDK refuses it: ${result.error?.message ?? ""}` });
      else {
        const parsed: unknown = JSON.parse(JSON.stringify(result.data));
        const decoded = Schema.decodeUnknownExit(codec)(parsed);
        if (Exit.isFailure(decoded)) failures.push({ definition, json: parsed, error: `what the SDK made of it does not decode: ${String(decoded.cause)}` });
      }
    }
  }
  return { definitions: definitions.length, checked, failures };
}

test("AS3: every v1 method definition's samples encode to JSON the SDK's zod schema accepts, and its output decodes back", () => {
  const result = conformance(documents.v1, v1, zodV1);
  console.log(`v1: ${result.definitions} definitions, ${result.checked} samples`);
  expect(result.failures.slice(0, 5)).toEqual([]);
  expect(result.checked).toBe(result.definitions * samples);
});

test("AS3: every v2 method definition's samples encode to JSON the SDK's zod schema accepts, and its output decodes back", () => {
  const result = conformance(documents.v2, v2, zodV2);
  console.log(`v2: ${result.definitions} definitions, ${result.checked} samples`);
  expect(result.failures.slice(0, 5)).toEqual([]);
  expect(result.checked).toBe(result.definitions * samples);
});
