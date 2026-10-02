/**
 * Generates the ACP schemas from the JSON Schemas the ACP SDK ships: every `$def` becomes an Effect
 * Schema in `src/acp/schema/v{1,2}.gen.ts`, and the methods become `RpcGroup`s in
 * `src/acp/schema/v{1,2}.rpcs.gen.ts`. `bun run acp:schema` writes them; `generate` returns them, so a
 * test can check the files on disk are what the installed SDK produces.
 *
 * The SDK's JSON Schemas use forms Effect's importer (`SchemaRepresentation.fromJsonSchemaMultiDocument`)
 * refuses, and extensions it does not read, so the definitions pass through three stages:
 *
 * 1. `normalize` rewrites the JSON Schema: an object with sibling `anyOf`/`oneOf` becomes a union of
 *    objects, an `allOf` that names a union is distributed over its members, and `not` (which only
 *    marks the catch-all variant of an extensible union) is removed. What the importer would drop is
 *    carried through it in a `contentSchema` annotation, which it keeps as plain JSON: the
 *    `x-deserialize-*` markers of a property, the tags a catch-all variant excludes, and whether an
 *    object keeps the properties it does not name.
 * 2. Effect imports the result and turns it into representations.
 * 3. `finish` reads the carried annotation back and rewrites the representations: lenient properties
 *    are wrapped in declarations whose code calls the `helpers` emitted into the module, catch-alls
 *    get a check, string formats the SDK validates get checks, plain-string definitions are branded,
 *    and objects that name properties and do not keep others lose the index signature the importer
 *    gives every object. It also prints numbers and unions in forms the linter accepts.
 *
 * Then Effect's `toCodeDocument` prints the representations, in an order where each declaration
 * follows those it uses. A recursive definition is refused: none exists, and `toCodeDocument`
 * would type it as a codec whose encoded side is its decoded side, which brands and lenient arrays
 * are not.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Predicate, Schema } from "effect";
import type * as JsonSchema from "effect/JsonSchema";
import * as SchemaRepresentation from "effect/SchemaRepresentation";

type JsonObject = { readonly [key: string]: unknown };

type Representation = SchemaRepresentation.Representation;

type Annotations = { readonly [key: string]: unknown };

/** What `normalize` carries through the importer for `finish`, under `contentSchema["x-acp"]`. */
interface Carried {
  /** The object keeps the properties it does not name (`additionalProperties: true`). */
  readonly open?: true;
  /** The object is a catch-all variant: `key` must not be one of `tags`. */
  readonly excludeTags?: { readonly key: string; readonly tags: ReadonlyArray<string> };
  /** The property is marked `x-deserialize-default-on-error`. */
  readonly defaultOnError?: true;
  /** The property is marked `x-deserialize-skip-invalid-items`. */
  readonly skipInvalidItems?: true;
}

const carriedKey = "x-acp";

const sdkRoot = "node_modules/@agentclientprotocol/sdk";

/** The two protocol versions, where their JSON Schemas are, and where their code goes. */
const versions = [
  { name: "v1", source: "schema/schema.json", protocolVersion: 1 },
  { name: "v2", source: "schema/v2/schema.unstable.json", protocolVersion: 2 },
] as const;

/** The upper and lower bounds the SDK enforces for the integer formats the schemas name. */
const integerBounds: { readonly [format: string]: { readonly minimum: number; readonly maximum: number } } = {
  uint8: { minimum: 0, maximum: 255 },
  uint16: { minimum: 0, maximum: 65535 },
  uint32: { minimum: 0, maximum: 4294967295 },
  int8: { minimum: -128, maximum: 127 },
  int16: { minimum: -32768, maximum: 32767 },
  int32: { minimum: -2147483648, maximum: 2147483647 },
};

/** Keywords that constrain a node besides its `anyOf`/`oneOf`, so the two have to be intersected. */
const constraining = ["type", "properties", "required", "allOf", "additionalProperties", "const", "enum", "items", "$ref"];

const isObject = (input: unknown): input is JsonObject => Predicate.isObject(input);

const objects = (input: unknown): ReadonlyArray<JsonObject> => (Array.isArray(input) ? input.filter(isObject) : []);

/** The tags a catch-all variant's `not` excludes: `not: { anyOf: [{ properties: { key: { const: tag } } }, …] }`. */
function excludedTags(not: unknown, at: string): { readonly key: string; readonly tags: ReadonlyArray<string> } {
  const members = isObject(not) ? objects(not["anyOf"]) : [];
  const pairs = members.map((member) => {
    const properties = member["properties"];
    const entries = isObject(properties) ? Object.entries(properties) : [];
    const [entry] = entries;
    const tag = entry !== undefined && isObject(entry[1]) ? entry[1]["const"] : undefined;
    if (entries.length !== 1 || entry === undefined || typeof tag !== "string") throw new Error(`${at}: unsupported "not": ${JSON.stringify(not)}`);
    return { key: entry[0], tag };
  });
  const key = pairs[0]?.key;
  if (key === undefined || pairs.some((pair) => pair.key !== key)) throw new Error(`${at}: unsupported "not": ${JSON.stringify(not)}`);
  return { key, tags: pairs.map((pair) => pair.tag) };
}

/** Rewrites every definition into forms Effect's importer takes; see the module comment. */
function normalize(definitions: JsonObject): JsonObject {
  const done = new Map<string, JsonObject>();
  const inProgress = new Set<string>();

  const definition = (name: string): JsonObject => {
    const cached = done.get(name);
    if (cached !== undefined) return cached;
    const source = definitions[name];
    if (!isObject(source)) throw new Error(`$defs/${name} is missing or not an object`);
    if (inProgress.has(name)) throw new Error(`$defs/${name} refers to itself through an intersection`);
    inProgress.add(name);
    const result = node(source, `$defs/${name}`, false);
    inProgress.delete(name);
    done.set(name, result);
    return result;
  };

  /** The members of a union that has no other constraint, looking through a `$ref`. */
  const unionMembers = (input: JsonObject): { readonly mode: "anyOf" | "oneOf"; readonly members: ReadonlyArray<JsonObject> } | undefined => {
    const name = typeof input["$ref"] === "string" && input["$ref"].startsWith("#/$defs/") ? input["$ref"].slice("#/$defs/".length) : undefined;
    const target = name === undefined ? input : definition(name);
    if (name !== undefined && Object.keys(input).some((key) => key !== "$ref" && key !== "description" && key !== "title")) return undefined;
    if (constraining.some((key) => key in target) || "contentSchema" in target) return undefined;
    if (Array.isArray(target["anyOf"])) return { mode: "anyOf", members: objects(target["anyOf"]) };
    if (Array.isArray(target["oneOf"])) return { mode: "oneOf", members: objects(target["oneOf"]) };
    return undefined;
  };

  /** What stays on a node when it is distributed: its documentation and its default. */
  const kept = ["description", "title", "default"];

  const documentation = (input: JsonObject): JsonObject => Object.fromEntries(Object.entries(input).filter(([key]) => kept.includes(key)));

  const node = (input: JsonObject, at: string, isProperty: boolean): JsonObject => {
    const output: { [key: string]: unknown } = {};
    const carried: { -readonly [K in "open" | "excludeTags"]?: Carried[K] } = {};
    const lenient: { -readonly [K in "defaultOnError" | "skipInvalidItems"]?: Carried[K] } = {};
    for (const [key, value] of Object.entries(input)) {
      switch (key) {
        case "x-deserialize-default-on-error":
        case "x-deserialize-skip-invalid-items":
          if (!isProperty) throw new Error(`${at}: ${key} outside a property`);
          if (value === true && key === "x-deserialize-default-on-error") lenient.defaultOnError = true;
          if (value === true && key === "x-deserialize-skip-invalid-items") lenient.skipInvalidItems = true;
          break;
        case "not":
          carried.excludeTags = excludedTags(value, at);
          break;
        case "unevaluatedProperties":
          if (value === true) carried.open = true;
          else throw new Error(`${at}: unsupported unevaluatedProperties ${JSON.stringify(value)}`);
          break;
        case "discriminator":
        case "x-method":
        case "x-side":
        case "x-docs-ignore":
          break;
        case "properties":
          output[key] = isObject(value)
            ? Object.fromEntries(Object.entries(value).map(([name, schema]) => [name, isObject(schema) ? node(schema, `${at}.${name}`, true) : schema]))
            : value;
          break;
        case "anyOf":
        case "oneOf":
        case "allOf":
        case "prefixItems":
          output[key] = Array.isArray(value) ? value.map((member, index) => (isObject(member) ? node(member, `${at}.${key}[${index}]`, false) : member)) : value;
          break;
        case "items":
          output[key] = isObject(value) ? node(value, `${at}.items`, false) : value;
          break;
        case "additionalProperties":
          if (value === true) carried.open = true;
          output[key] = isObject(value) ? node(value, `${at}.additionalProperties`, false) : value;
          break;
        default:
          if (key.startsWith("x-")) throw new Error(`${at}: unknown extension ${key}`);
          output[key] = value;
      }
    }
    if (carried.excludeTags !== undefined && carried.open !== true) throw new Error(`${at}: a catch-all variant that does not keep its other properties`);
    if (carried.open === true) output["additionalProperties"] = true;
    const format = typeof input["format"] === "string" ? integerBounds[input["format"]] : undefined;
    if (format !== undefined) {
      output["minimum"] = Math.max(format.minimum, typeof input["minimum"] === "number" ? input["minimum"] : format.minimum);
      output["maximum"] = Math.min(format.maximum, typeof input["maximum"] === "number" ? input["maximum"] : format.maximum);
    }
    if (Object.keys(carried).length > 0) output["contentSchema"] = { [carriedKey]: carried };
    const result = distribute(output, at);
    if (Object.keys(lenient).length === 0) return result;
    const content = result["contentSchema"];
    const already = isObject(content) && isObject(content[carriedKey]) ? content[carriedKey] : {};
    return { ...result, contentSchema: { [carriedKey]: { ...already, ...lenient } } };
  };

  /** An object constrained by a union, or by an `allOf` naming one, becomes a union of the intersections. */
  const distribute = (input: JsonObject, at: string): JsonObject => {
    const mode = Array.isArray(input["anyOf"]) ? "anyOf" : Array.isArray(input["oneOf"]) ? "oneOf" : undefined;
    if (mode !== undefined && constraining.some((key) => key in input)) {
      const { anyOf: _anyOf, oneOf: _oneOf, description: _description, title: _title, default: _default, ...rest } = input;
      const allOf = objects(rest["allOf"]);
      return {
        ...documentation(input),
        [mode]: objects(input[mode]).map((member, index) => distribute({ ...rest, allOf: [...allOf, member] }, `${at}.${mode}[${index}]`)),
      };
    }
    const allOf = objects(input["allOf"]);
    const others = Object.keys(input).filter((key) => key !== "allOf" && !kept.includes(key));
    if (allOf.length + others.length < 2) return input;
    const index = allOf.findIndex((member) => unionMembers(member) !== undefined);
    const union = allOf[index] === undefined ? undefined : unionMembers(allOf[index]);
    if (union === undefined) return input;
    const { description: _description, title: _title, default: _default, ...rest } = input;
    return {
      ...documentation(input),
      [union.mode]: union.members.map((member, position) =>
        distribute({ ...rest, allOf: allOf.map((other, at_) => (at_ === index ? member : other)) }, `${at}.allOf[${index}][${position}]`),
      ),
    };
  };

  return Object.fromEntries(Object.keys(definitions).map((name) => [name, definition(name)]));
}

const CarriedSchema = Schema.Struct({
  open: Schema.optionalKey(Schema.Literal(true)),
  excludeTags: Schema.optionalKey(Schema.Struct({ key: Schema.String, tags: Schema.Array(Schema.String) })),
  defaultOnError: Schema.optionalKey(Schema.Literal(true)),
  skipInvalidItems: Schema.optionalKey(Schema.Literal(true)),
});

const decodeCarried = Schema.decodeUnknownSync(CarriedSchema);

const carriedOf = (annotations: Annotations | undefined): Carried => {
  const content = annotations?.["contentSchema"];
  return isObject(content) && carriedKey in content ? decodeCarried(content[carriedKey]) : {};
};

/** The annotations without what `normalize` carried, or undefined when nothing is left. */
const clean = (annotations: Annotations | undefined, drop: ReadonlyArray<string> = []): Annotations | undefined => {
  if (annotations === undefined) return undefined;
  const kept = Object.entries(annotations).filter(([key]) => key !== "contentSchema" && !drop.includes(key));
  return kept.length === 0 ? undefined : Object.fromEntries(kept);
};

/** Marks the declarations `finish` makes for a finite or integer number, so a union can tell them apart. */
const numberId = "acp/number";

/** The helpers a generated module may call, each emitted only when used. */
const helpers = {
  defaultOnError: {
    imports: ["Effect", "Option"],
    code: `/**
 * Decodes as \`schema\`, except that a value that is present and fails to decode becomes \`fallback\`,
 * or is left out when there is no fallback. A required key that is missing still fails. Encoding is
 * unchanged.
 */
const defaultOnError = <S extends Schema.Top>(schema: S, ...fallback: readonly [] | readonly [S["Type"]]) =>
  schema.pipe(
    Schema.catchDecoding((issue) =>
      issue._tag === "MissingKey" ? Effect.fail(issue) : Effect.succeed(fallback.length === 0 ? Option.none() : Option.some(fallback[0])),
    ),
  );`,
  },
  skipInvalidItems: {
    imports: ["Option", "SchemaGetter"],
    code: `/** An array that decodes by dropping the items that fail to decode as \`item\`. Encoding refuses an invalid item. */
const skipInvalidItems = <S extends Schema.Top & Schema.ConstraintDecoder<unknown>>(item: S) => {
  const decode = Schema.decodeUnknownOption(item);
  return Schema.Array(Schema.Unknown).pipe(
    Schema.decodeTo(Schema.Array(item), {
      decode: SchemaGetter.transform((items) => items.filter((value): value is S["Encoded"] => Option.isSome(decode(value)))),
      encode: SchemaGetter.passthroughSubtype(),
    }),
  );
};`,
  },
  excludeTags: {
    imports: [],
    code: `/** Refuses an object whose \`key\` is one of \`tags\`: those belong to the union's known variants. */
const excludeTags = (key: string, tags: ReadonlyArray<string>) =>
  Schema.makeFilter<{ readonly [key: string]: unknown }>(
    (value) => {
      const tag = value[key];
      return typeof tag !== "string" || !tags.includes(tag);
    },
    { expected: \`an object whose "\${key}" is none of \${tags.join(", ")}\` },
  );`,
  },
  isUri: {
    imports: [],
    code: `/** A string \`URL\` parses once trimmed, which is what the SDK checks a \`uri\` against. */
const isUri = () =>
  Schema.makeFilter<string>((value) => URL.canParse(value.trim()), {
    expected: "a URI",
    arbitraryConstraint: { patterns: [{ source: "^https://example\\\\.com/[a-z0-9]{0,12}$", flags: "" }] },
  });`,
  },
  isDateTime: {
    imports: [],
    code: `/** An RFC 3339 date-time with seconds and a \`Z\` or an offset: the pattern the SDK checks a \`date-time\` against. */
const isDateTime = () =>
  Schema.isPattern(
    /^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$/,
    { expected: "an RFC 3339 date-time" },
  );`,
  },
} as const;

type Helper = keyof typeof helpers;

const declaration = (
  typeParameters: ReadonlyArray<Representation>,
  generate: (codes: ReadonlyArray<SchemaRepresentation.Code>) => SchemaRepresentation.Code,
  from?: { readonly annotations?: Annotations | undefined; readonly checks: ReadonlyArray<SchemaRepresentation.Check> },
): SchemaRepresentation.Declaration => ({
  _tag: "Declaration",
  typeParameters,
  checks: from?.checks ?? [],
  annotations: {
    ...from?.annotations,
    toCode: ({ typeParameters: codes }: SchemaRepresentation.Generation.DeclarationInput): SchemaRepresentation.Generation.DeclarationOutput => generate(codes),
  },
});

const filter = (runtime: string): SchemaRepresentation.Filter => ({
  _tag: "Filter",
  aborted: false,
  annotations: { toCode: (): SchemaRepresentation.Generation.CheckOutput => ({ runtime }) },
});

const code = (codes: ReadonlyArray<SchemaRepresentation.Code>): SchemaRepresentation.Code => {
  const [first] = codes;
  if (first === undefined) throw new Error("a declaration without its type parameter");
  return first;
};

/** Rewrites the imported representations; see the module comment. Records the helpers it uses in `used`. */
function finish(references: SchemaRepresentation.References, brands: ReadonlySet<string>, used: Set<Helper>): SchemaRepresentation.References {
  const withFormat = (representation: Representation, format: unknown): Representation => {
    if (format !== "uri" && format !== "date-time") return representation;
    const helper = format === "uri" ? "isUri" : "isDateTime";
    if (representation._tag === "String") {
      used.add(helper);
      return { ...representation, checks: [...representation.checks, filter(`${helper}()`)] };
    }
    if (representation._tag === "Union") return { ...representation, types: representation.types.map((type) => withFormat(type, format)) };
    return representation;
  };

  const skipInvalid = (representation: Representation, at: string): Representation => {
    if (representation._tag === "Arrays" && representation.elements.length === 0 && representation.rest.length === 1) {
      used.add("skipInvalidItems");
      return declaration(representation.rest, (codes) => ({ runtime: `skipInvalidItems(${code(codes).runtime})`, Type: `ReadonlyArray<${code(codes).Type}>` }), representation);
    }
    if (representation._tag === "Union" && representation.types.some((type) => type._tag === "Arrays")) {
      return { ...representation, types: representation.types.map((type) => (type._tag === "Arrays" ? skipInvalid(type, at) : type)) };
    }
    throw new Error(`${at}: x-deserialize-skip-invalid-items on something that is not an array`);
  };

  const property = (signature: SchemaRepresentation.PropertySignature, at: string): SchemaRepresentation.PropertySignature => {
    const viaReference = signature.type._tag === "Suspend" && signature.type.thunk._tag === "Reference";
    const typeAnnotations = signature.type._tag === "Reference" ? undefined : signature.type.annotations;
    const carried = carriedOf(typeAnnotations);
    let type = representation(signature.type, at);
    const annotations = clean({ ...signature.annotations, ...(viaReference ? typeAnnotations : {}) });
    if (carried.skipInvalidItems === true) type = skipInvalid(type, at);
    if (carried.defaultOnError === true) {
      // A required property with no default is always an array here, and the SDK falls back to an empty one.
      const hasDefault = typeAnnotations !== undefined && "default" in typeAnnotations;
      if (!hasDefault && !signature.isOptional && type._tag !== "Declaration")
        throw new Error(`${at}: a required x-deserialize-default-on-error property with no default that is not a skip-invalid array`);
      const fallback = hasDefault ? [JSON.stringify(typeAnnotations["default"])] : signature.isOptional ? [] : ["[]"];
      used.add("defaultOnError");
      type = declaration([type], (codes) => ({ runtime: `defaultOnError(${[code(codes).runtime, ...fallback].join(", ")})`, Type: code(codes).Type }));
    }
    return { ...signature, type, annotations };
  };

  const representation = (input: Representation, at: string): Representation => {
    switch (input._tag) {
      case "Reference":
        return input;
      case "Suspend":
        return input.thunk._tag === "Reference" ? input.thunk : { ...input, annotations: clean(input.annotations), thunk: representation(input.thunk, at) };
      case "Objects": {
        const carried = carriedOf(input.annotations);
        if (carried.excludeTags !== undefined) used.add("excludeTags");
        const keepsOthers = carried.open === true || input.propertySignatures.length === 0;
        return {
          ...input,
          annotations: clean(input.annotations),
          propertySignatures: input.propertySignatures.map((signature) => property(signature, `${at}.${String(signature.name)}`)),
          indexSignatures: keepsOthers
            ? input.indexSignatures.map((signature) => ({ parameter: representation(signature.parameter, at), type: representation(signature.type, at) }))
            : [],
          checks: [
            ...input.checks,
            ...(carried.excludeTags === undefined
              ? []
              : [filter(`excludeTags(${JSON.stringify(carried.excludeTags.key)}, ${JSON.stringify(carried.excludeTags.tags)})`)]),
          ],
        };
      }
      case "Union":
        return withFormat({ ...input, annotations: clean(input.annotations, ["format"]), types: input.types.map((type) => representation(type, at)) }, input.annotations?.["format"]);
      case "Arrays":
        return {
          ...input,
          annotations: clean(input.annotations),
          elements: input.elements.map((element) => ({ ...element, type: representation(element.type, at) })),
          rest: input.rest.map((type) => representation(type, at)),
        };
      case "Declaration":
        return { ...input, annotations: clean(input.annotations), typeParameters: input.typeParameters.map((type) => representation(type, at)) };
      case "String":
        return withFormat({ ...input, annotations: clean(input.annotations, ["format"]) }, input.annotations?.["format"]);
      default:
        return { ...input, annotations: clean(input.annotations) };
    }
  };

  /** What a union member's TypeScript type is, when two members can have the same one. */
  const typeKey = (member: Representation): string | undefined => {
    if (member._tag === "Reference") {
      const target = references[member.$ref];
      return target?._tag === "Declaration" && target.representation?.id === "effect/schema/Json" ? "json" : undefined;
    }
    if (member._tag === "Number" || (member._tag === "Declaration" && member.representation?.id === numberId)) return "number";
    if (member._tag === "String" && member.checks.length === 0) return "string";
    return member._tag === "Boolean" || member._tag === "Null" ? member._tag : undefined;
  };

  /**
   * Rewrites what the code generator would print in a form the linter accepts: a finite or integer
   * number as `Schema.Finite` or `Schema.Int`, and a union whose type would repeat a member or name
   * a literal beside its primitive (an open enum) with each type once and the primitive as
   * `(string & {})`, which keeps the literals visible to an editor.
   */
  const present = (input: Representation): Representation => {
    switch (input._tag) {
      case "Number": {
        const ids = input.checks.map((check) => check.representation?.id);
        const base = ids.includes("effect/schema/isInt") ? "Schema.Int" : ids.includes("effect/schema/isFinite") ? "Schema.Finite" : undefined;
        if (base === undefined) return input;
        const checks = input.checks.filter((check) => check.representation?.id !== "effect/schema/isInt" && check.representation?.id !== "effect/schema/isFinite");
        return { ...declaration([], () => ({ runtime: base, Type: "number" }), { annotations: input.annotations, checks }), representation: { id: numberId, payload: null } };
      }
      case "Union": {
        const types = input.types.map(present);
        const keys = types.map(typeKey);
        const repeats = keys.some((key, index) => key !== undefined && keys.indexOf(key) !== index);
        const open = types.some((type) => type._tag === "Literal") && keys.some((key) => key === "string" || key === "number");
        if (!repeats && !open) return { ...input, types };
        const options = input.options === undefined ? "" : `, ${"mode" in input.options ? `{ mode: ${JSON.stringify(input.options.mode)} }` : "{}"}`;
        return declaration(
          types,
          (codes) => ({
            runtime: `Schema.Union([${codes.map((member) => member.runtime).join(", ")}]${options})`,
            Type: [
              ...new Set(
                codes.flatMap((member, index) => {
                  const key = keys[index];
                  if (key !== undefined && keys.indexOf(key) !== index) return [];
                  return [open && (key === "string" || key === "number") ? `(${member.Type} & {})` : member.Type];
                }),
              ),
            ].join(" | "),
          }),
          input,
        );
      }
      case "Objects":
        return {
          ...input,
          propertySignatures: input.propertySignatures.map((signature) => ({ ...signature, type: present(signature.type) })),
          indexSignatures: input.indexSignatures.map((signature) => ({ parameter: present(signature.parameter), type: present(signature.type) })),
        };
      case "Arrays":
        return { ...input, elements: input.elements.map((element) => ({ ...element, type: present(element.type) })), rest: input.rest.map(present) };
      case "Declaration":
        return { ...input, typeParameters: input.typeParameters.map(present) };
      case "Suspend":
        return { ...input, thunk: present(input.thunk) };
      default:
        return input;
    }
  };

  return Object.fromEntries(
    Object.entries(references).map(([name, input]) => {
      const output = representation(input, name);
      // The definition's description is the declaration's doc comment.
      const annotations = output._tag === "Reference" ? undefined : clean(output.annotations, ["description"]);
      const described: Representation = output._tag === "Reference" ? output : { ...output, annotations };
      if (!brands.has(name)) return [name, present(described)];
      if (described._tag !== "String" || described.checks.length > 0) throw new Error(`${name} was to be branded but is not a plain string`);
      return [name, { ...described, annotations: { ...annotations, brands: [`acp/${name}`] } }];
    }),
  );
}

/** A JSDoc comment from a description. */
function doc(description: unknown): string {
  if (typeof description !== "string" || description.trim() === "") return "";
  const lines = description.replaceAll("*/", "*\\/").split("\n");
  return `/**\n${lines.map((line) => (line === "" ? " *" : ` * ${line}`)).join("\n")}\n */\n`;
}

const Document = Schema.Struct({ $defs: Schema.Record(Schema.String, Schema.Unknown) });

interface Method {
  readonly method: string;
  readonly side: "agent" | "client" | "both";
  request?: string;
  response?: string;
  notification?: string;
  unstable: boolean;
}

/** The methods named by `x-method`/`x-side`, each with its request and response, or notification, definitions. */
function methods(definitions: JsonObject): ReadonlyArray<Method> {
  const byName = new Map<string, Method>();
  for (const [name, definition] of Object.entries(definitions)) {
    if (!isObject(definition)) continue;
    const method = definition["x-method"];
    const side = definition["x-side"];
    if (typeof method !== "string") continue;
    if (side === "protocol") continue;
    if (side !== "agent" && side !== "client" && side !== "both") throw new Error(`$defs/${name}: unknown x-side ${JSON.stringify(side)}`);
    const entry = byName.get(method) ?? { method, side, unstable: false };
    if (entry.side !== side) throw new Error(`${method}: defined on both the ${entry.side} and the ${side} side`);
    const kind = name.endsWith("Request") ? "request" : name.endsWith("Response") ? "response" : name.endsWith("Notification") ? "notification" : undefined;
    if (kind === undefined) throw new Error(`$defs/${name}: a method definition that is not a Request, Response or Notification`);
    if (entry[kind] !== undefined) throw new Error(`${method}: two ${kind} definitions, ${entry[kind]} and ${name}`);
    entry[kind] = name;
    entry.unstable ||= typeof definition["description"] === "string" && definition["description"].includes("**UNSTABLE**");
    byName.set(method, entry);
  }
  const all = [...byName.values()].sort((left, right) => (left.method < right.method ? -1 : left.method > right.method ? 1 : 0));
  for (const entry of all)
    if ((entry.request === undefined) !== (entry.response === undefined)) throw new Error(`${entry.method}: a request without a response, or a response without a request`);
  return all;
}

const header = (version: (typeof versions)[number], sdkVersion: string): string =>
  `// Generated by scripts/acp-schema.ts from @agentclientprotocol/sdk ${sdkVersion} ${version.source} (ACP protocol version ${version.protocolVersion}).\n// Do not edit: run \`bun run acp:schema\`.\n`;

function schemasModule(version: (typeof versions)[number], sdkVersion: string, input: unknown): string {
  const definitions = Schema.decodeUnknownSync(Document)(input).$defs;
  const names = Object.keys(definitions);
  const [first, ...rest] = names.map((name) => ({ $ref: `#/$defs/${name}` }));
  if (first === undefined) throw new Error(`${version.source} has no $defs`);
  const normalized = normalize(definitions);
  const imported = SchemaRepresentation.fromJsonSchemaMultiDocument(
    { dialect: "draft-2020-12", schemas: [first, ...rest], definitions: normalized as JsonSchema.Definitions },
    { patterns: "apply" },
  );
  const [ast, ...asts] = imported.map((schema) => schema.ast);
  if (ast === undefined) throw new Error("the importer returned nothing");
  const document = SchemaRepresentation.toRepresentations([ast, ...asts]);
  const missing = names.filter((name) => !(name in document.references));
  const extra = Object.keys(document.references).filter((name) => !names.includes(name));
  if (missing.length > 0 || extra.length > 0) throw new Error(`definitions and references differ: missing ${missing.join(", ")}; extra ${extra.join(", ")}`);
  const brands = new Set(
    names.filter((name) => {
      const definition = definitions[name];
      return isObject(definition) && definition["type"] === "string" && Object.keys(definition).every((key) => key === "type" || key === "description");
    }),
  );
  const used = new Set<Helper>();
  const references = finish(document.references, brands, used);
  const generated = SchemaRepresentation.toCodeDocument({ representations: document.representations, references });
  const recursive = Object.keys(generated.references.recursives);
  if (recursive.length > 0) throw new Error(`recursive definitions are not supported: ${recursive.join(", ")}`);

  const helperNames = (Object.keys(helpers) as ReadonlyArray<Helper>).filter((name) => used.has(name));
  const values = ["Schema", ...new Set(helperNames.flatMap((name) => helpers[name].imports))].sort();
  const imports = [
    `import { ${values.join(", ")} } from "effect";`,
    ...generated.artifacts.flatMap((artifact) => (artifact._tag === "Import" ? [artifact.importDeclaration.replace(/;?$/, ";")] : [])),
  ];
  if (generated.artifacts.some((artifact) => artifact._tag !== "Import")) throw new Error("the code generator emitted an artifact other than an import");
  const declarations = generated.references.nonRecursives.map(({ $ref, code: { runtime, Type } }) => {
    const comment = doc(definitions[$ref] !== undefined && isObject(definitions[$ref]) ? definitions[$ref]["description"] : undefined);
    return `${comment}export type ${$ref} = ${Type};\n${comment}export const ${$ref} = ${runtime};\n`;
  });
  return [header(version, sdkVersion), imports.join("\n"), "", ...helperNames.map((name) => `${helpers[name].code}\n`), ...declarations].join("\n");
}

function rpcsModule(version: (typeof versions)[number], sdkVersion: string, input: unknown): string {
  const all = methods(Schema.decodeUnknownSync(Document)(input).$defs);
  const serves = (side: "agent" | "client") => all.filter((entry) => entry.side === side || entry.side === "both");
  const requests = (side: "agent" | "client") =>
    serves(side).flatMap((entry) =>
      entry.request === undefined || entry.response === undefined
        ? []
        : [`  Rpc.make(${JSON.stringify(entry.method)}, { payload: Schemas.${entry.request}, success: Schemas.${entry.response}, error: JsonRpcError }),`],
    );
  const notifications = (side: "agent" | "client") =>
    serves(side).flatMap((entry) => (entry.notification === undefined ? [] : [`  Rpc.make(${JSON.stringify(entry.method)}, { payload: Schemas.${entry.notification} }),`]));
  const group = (comment: string, name: string, rpcs: ReadonlyArray<string>) => `/** ${comment} */\nexport const ${name} = RpcGroup.make(\n${rpcs.join("\n")}\n);\n`;
  const unstable = all.filter((entry) => entry.unstable).map((entry) => JSON.stringify(entry.method));
  return [
    header(version, sdkVersion),
    `import { Rpc, RpcGroup } from "effect/rpc";`,
    `import { JsonRpcError } from "../json-rpc.ts";`,
    `import * as Schemas from "./${version.name}.gen.ts";`,
    "",
    group("The requests the agent serves.", "AgentRequests", requests("agent")),
    group("The notifications the agent receives.", "AgentNotifications", notifications("agent")),
    group("The requests the client serves.", "ClientRequests", requests("client")),
    group("The notifications the client receives.", "ClientNotifications", notifications("client")),
    `/** The methods whose definitions are marked **UNSTABLE**: not part of the spec yet, and may change or go. */`,
    `export const unstable: ReadonlySet<string> = new Set([${unstable.join(", ")}]);`,
    "",
  ].join("\n");
}

/** Every generated file, by path from the repository root, from the SDK's version and JSON Schemas. */
export function generate(sdkVersion: string, documents: { readonly v1: unknown; readonly v2: unknown }): ReadonlyArray<{ readonly path: string; readonly content: string }> {
  return versions.flatMap((version) => [
    { path: `src/acp/schema/${version.name}.gen.ts`, content: schemasModule(version, sdkVersion, documents[version.name]) },
    { path: `src/acp/schema/${version.name}.rpcs.gen.ts`, content: rpcsModule(version, sdkVersion, documents[version.name]) },
  ]);
}

/** The installed SDK's version and JSON Schemas, read from `root`'s `node_modules`. */
export function installed(root: string): { readonly sdkVersion: string; readonly documents: { readonly v1: unknown; readonly v2: unknown } } {
  const read = (path: string): unknown => JSON.parse(readFileSync(join(root, sdkRoot, path), "utf8"));
  const sdkVersion = Schema.decodeUnknownSync(Schema.Struct({ version: Schema.String }))(read("package.json")).version;
  return { sdkVersion, documents: { v1: read(versions[0].source), v2: read(versions[1].source) } };
}

if (import.meta.main) {
  const root = process.cwd();
  const { sdkVersion, documents } = installed(root);
  for (const file of generate(sdkVersion, documents)) {
    mkdirSync(dirname(join(root, file.path)), { recursive: true });
    writeFileSync(join(root, file.path), file.content);
    console.log(`wrote ${file.path} (${file.content.length} bytes)`);
  }
}
