/**
 * A local Chat Completions server at http://localhost:8000/v1, asked as the provider `localhost`.
 *
 * What is known of a `localhost` model is what the server's model list says of it (`GET /v1/models`):
 * its context window, the kinds of input it accepts, and the reasoning efforts it lists. Requests are
 * shaped to that, so an effort above the server's highest is sent as its highest.
 */

import { Effect, Layer, Option, Schema } from "effect";
import { type Capabilities, KnownEffort, KnownModels, type ModelKnowledge, ModelOverrides, catalogued, withOverrides } from "../agent-session/configuration/well-known-models.ts";
import { Settling, type SettlingSource, wellKnownSettling } from "../agent-session/configuration/options.ts";
import { openAiCompatSettle } from "../agent-session/providers/openai-compat-settings.ts";
import { logKeys } from "./log-keys.ts";

/** The local server's address. */
export const localServer = "http://localhost:8000/v1";

/**
 * Returns the items of `value` that `schema` decodes, in order; none when `value` is not a list.
 * Each item is decoded on its own, so an entry that the server writes in another form drops only
 * itself.
 */
const itemsOf = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) => {
  const items = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown));
  const item = Schema.decodeUnknownOption(schema);
  return (value: unknown): ReadonlyArray<S["Type"]> => Option.match(items(value), { onNone: () => [], onSome: (each) => each.flatMap((one) => Option.toArray(item(one))) });
};

/** A model list as the server writes it: `data` for the model names it accepts, `models` for what it reports of each. */
const ModelList = Schema.decodeUnknownOption(Schema.Struct({ data: Schema.optionalKey(Schema.Unknown), models: Schema.optionalKey(Schema.Unknown) }));
const listedNames = itemsOf(Schema.Struct({ id: Schema.String }));
const listedModels = itemsOf(
  Schema.Struct({
    slug: Schema.String,
    context_window: Schema.optionalKey(Schema.Unknown),
    input_modalities: Schema.optionalKey(Schema.Unknown),
    supported_reasoning_levels: Schema.optionalKey(Schema.Unknown),
  }),
);
const levels = itemsOf(Schema.Struct({ effort: Schema.String }));
const strings = itemsOf(Schema.String);

const isKnownEffort = Schema.is(KnownEffort);

/**
 * Returns the reasoning levels that the local server's model list names and the core does not
 * (`KnownEffort`), by model: `localCapabilities` leaves them out, and the host logs them.
 */
export function unnamedLevels(listed: unknown): ReadonlyArray<{ readonly model: string; readonly level: string }> {
  return Option.match(ModelList(listed), { onNone: () => [], onSome: (each) => listedModels(each.models) }).flatMap((model) =>
    levels(model.supported_reasoning_levels).flatMap((level) => (isKnownEffort(level.effort) ? [] : [{ model: model.slug, level: level.effort }])),
  );
}

/**
 * Returns what the local server's model list says of each model it serves, by the model's name:
 * the `models` entries give the context window, the kinds of input and the reasoning levels that the
 * core names (`unnamedLevels` returns the others).
 */
export function localCapabilities(listed: unknown): ReadonlyMap<string, Capabilities> {
  return new Map(
    Option.match(ModelList(listed), { onNone: () => [], onSome: (each) => listedModels(each.models) }).map((model) => {
      const efforts = levels(model.supported_reasoning_levels).flatMap((level) => (isKnownEffort(level.effort) ? [level.effort] : []));
      const input = strings(model.input_modalities);
      const capabilities: Capabilities = {
        ...(typeof model.context_window === "number" ? { context: model.context_window } : {}),
        input: input.length === 0 ? ["text"] : input,
        ...(efforts.length === 0 ? {} : { efforts }),
        price: { input: 0, output: 0 },
      };
      return [model.slug, capabilities] as const;
    }),
  );
}

/**
 * The models that the local server serves, by the names it accepts (`GET /v1/models`, `data[].id`),
 * or `undefined` when it does not answer within one second.
 */
export const localModels: Effect.Effect<ReadonlyArray<string> | undefined> = Effect.tryPromise((signal) =>
  fetch(`${localServer}/models`, { signal }).then((response) => response.json() as Promise<unknown>),
).pipe(
  // Effect's timer, which a test clock can move: the timeout interrupts the request, which aborts the fetch.
  Effect.timeout("1 second"),
  Effect.map((listed) => Option.match(ModelList(listed), { onNone: () => [], onSome: (each) => listedNames(each.data).map((model) => model.id) })),
  Effect.orElseSucceed(() => undefined),
);

/**
 * What is known of each model: for `localhost`, what the local server lists, asked once when first
 * needed; for other providers, the well-known models; and over either, the user's overrides
 * (`ModelOverrides`) of the model. When the server does not answer, its models stay unknown, and a
 * warning is logged.
 */
export const KnownWithLocalServer = Layer.effect(
  KnownModels,
  Effect.gen(function* () {
    const local = yield* Effect.cached(
      Effect.tryPromise(() => fetch(`${localServer}/models`).then((response) => response.json() as Promise<unknown>)).pipe(
        Effect.tap((listed) =>
          Effect.forEach(unnamedLevels(listed), ({ model, level }) => Effect.logWarning(logKeys.localServer.levelNotNamed, { model, level, known: KnownEffort.literals.join(", ") }), { discard: true }),
        ),
        Effect.map(localCapabilities),
        Effect.catch((error) =>
          Effect.logWarning(logKeys.localServer.modelsNotListed, { url: `${localServer}/models`, error: String(error) }).pipe(Effect.as(new Map<string, Capabilities>())),
        ),
      ),
    );
    const localModels: ModelKnowledge = (provider, model) => (provider === "localhost" ? Effect.map(local, (models) => models.get(model)) : Effect.undefined);
    return withOverrides(yield* ModelOverrides, [localModels, catalogued]);
  }),
);

/** For `localhost`, the Chat Completions adapter's settings function. */
const localSettling: SettlingSource = (provider) => (provider === "localhost" ? openAiCompatSettle : undefined);

/** The settings function for each provider: for `localhost` the Chat Completions adapter's, and the default ones. */
export const SettlingWithLocalServer = Layer.succeed(Settling, [localSettling, wellKnownSettling]);
