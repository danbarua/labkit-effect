/**
 * A local Chat Completions server at http://localhost:8000/v1, asked as the provider `localhost`.
 *
 * What is known of a `localhost` model is what the server says of it (`GET /v1/models`): its context
 * window, whether it takes images, and the reasoning efforts it lists. Requests are shaped to that,
 * so an effort above the server's highest is sent as its highest.
 */

import { Effect, Layer, Option, Schema } from "effect";
import { type Capabilities, capabilitiesOf, KnownModels } from "../agent-session/configuration/well-known-models.ts";
import { Settling } from "../agent-session/configuration/options.ts";
import { openAiCompatSettle } from "../agent-session/providers/openai-compat-settings.ts";

/** Where the local server is. */
export const localServer = "http://localhost:8000/v1";

/**
 * The items of `value` that `schema` decodes, in order; none when `value` is not a list. Each item
 * is decoded alone, so an entry the server writes some other way drops only itself.
 */
const itemsOf = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) => {
  const items = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown));
  const item = Schema.decodeUnknownOption(schema);
  return (value: unknown): ReadonlyArray<S["Type"]> => Option.match(items(value), { onNone: () => [], onSome: (each) => each.flatMap((one) => Option.toArray(item(one))) });
};

/** A model list as the server writes it: `data` for the names it takes, `models` for what it says of each. */
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

/**
 * What the local server's model list says of each model it serves, by the model's name: its
 * `models` entries give the context window, the kinds of input and the reasoning levels.
 */
export function localCapabilities(listed: unknown): ReadonlyMap<string, Capabilities> {
  return new Map(
    Option.match(ModelList(listed), { onNone: () => [], onSome: (each) => listedModels(each.models) }).map((model) => {
      const efforts = levels(model.supported_reasoning_levels).map((level) => level.effort);
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
 * The models the local server serves, by the names it takes (`GET /v1/models`, `data[].id`), or
 * `undefined` when it does not answer within a second.
 */
export const localModels: Effect.Effect<ReadonlyArray<string> | undefined> = Effect.tryPromise(() =>
  fetch(`${localServer}/models`, { signal: AbortSignal.timeout(1000) }).then((response) => response.json() as Promise<unknown>),
).pipe(
  Effect.map((listed) => Option.match(ModelList(listed), { onNone: () => [], onSome: (each) => listedNames(each.data).map((model) => model.id) })),
  Effect.orElseSucceed(() => undefined),
);

/**
 * What is known of each model: for `localhost`, what the local server lists, asked once when first
 * needed; for the others, the well-known models. A server that does not answer leaves its models
 * unknown, and that is logged.
 */
export const KnownWithLocalServer = Layer.effect(
  KnownModels,
  Effect.gen(function* () {
    const local = yield* Effect.cached(
      Effect.tryPromise(() => fetch(`${localServer}/models`).then((response) => response.json() as Promise<unknown>)).pipe(
        Effect.map(localCapabilities),
        Effect.catch((error) =>
          Effect.logWarning("host.local_models.not_listed", { url: `${localServer}/models`, error: String(error) }).pipe(Effect.as(new Map<string, Capabilities>())),
        ),
      ),
    );
    return (provider, model) => (provider === "localhost" ? Effect.map(local, (models) => models.get(model)) : Effect.succeed(capabilitiesOf(provider, model)));
  }),
);

/** The settings function for each provider: the default ones, and for `localhost` the Chat Completions adapter's. */
export const SettlingWithLocalServer = Layer.effect(
  Settling,
  Effect.gen(function* () {
    const settling = yield* Settling;
    return (provider) => (provider === "localhost" ? openAiCompatSettle : settling(provider));
  }),
);
