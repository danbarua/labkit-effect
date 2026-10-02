/**
 * The models the CLI can ask: the well-known models, each provider's key from the environment, and one model client that reaches every provider with a
 * key set and a local Chat Completions server at http://localhost:8000/v1.
 *
 * What is known of a `localhost` model is what the server says of it (`GET /v1/models`): its context
 * window, whether it takes images, and the reasoning efforts it lists. Requests are shaped to that,
 * so an effort above the server's highest is sent as its highest.
 */

import { AnthropicClient } from "@effect/ai-anthropic";
import { OpenAiClient } from "@effect/ai-openai";
import { OpenAiClient as OpenAiCompatClient } from "@effect/ai-openai-compat";
import { Effect, Layer, Redacted } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { ModelName, ProviderName } from "../../agent-machine/names.ts";
import type { ProviderRequest } from "../../agent-session/contracts.ts";
import { FallbackModelClient } from "../../agent-session/model-fallback.ts";
import { anthropicRequests } from "../../agent-session/providers/anthropic-client.ts";
import { openAiRequests } from "../../agent-session/providers/openai-client.ts";
import { openAiCompatRequests } from "../../agent-session/providers/openai-compat-client.ts";
import { xAiClient, xAiRequests } from "../../agent-session/providers/xai-client.ts";
import { type Capabilities, capabilitiesOf, KnownModels } from "../../agent-session/configuration/well-known-models.ts";
import { wellKnownModels } from "../../agent-session/configuration/well-known-models.gen.ts";
import { openAiCompatSettle } from "../../agent-session/providers/openai-compat-settings.ts";
import { Settling } from "../../agent-session/configuration/options.ts";
import { invalid } from "./invalid.ts";

const localUrl = "http://localhost:8000/v1";

/** The well-known models, by provider. */
export const known: Readonly<Record<string, Readonly<Record<string, unknown>>>> = wellKnownModels;

/** The environment variable that holds each provider's key; a local server needs none. */
export const keyVariables: Readonly<Record<string, string>> = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", xai: "XAI_API_KEY" };

export const keyOf = (provider: string): string | undefined => {
  const variable = keyVariables[provider];
  const key = variable === undefined ? undefined : process.env[variable];
  return key === undefined || key === "" ? undefined : key;
};

export interface Asked {
  readonly provider: ProviderName;
  readonly model: ModelName;
}

/**
 * The provider and model a name gives: `provider/model`, or a well-known model. A provider
 * whose key is not set cannot be asked, and the variable is named.
 */
export const targetOf = (model: string | undefined) =>
  Effect.gen(function* () {
    if (model === undefined) return yield* invalid("No model: pass --model (bun cli models lists them).");
    const slash = model.indexOf("/");
    const named = slash > 0 && (model.slice(0, slash) in known || model.slice(0, slash) === "localhost");
    const provider = named ? model.slice(0, slash) : Object.keys(known).find((each) => model in (known[each] ?? {}));
    if (provider === undefined) return yield* invalid(`No model ${model} among the well-known models; name it as provider/model.`);
    const target: Asked = { provider: ProviderName.make(provider), model: ModelName.make(named ? model.slice(slash + 1) : model) };
    const variable = keyVariables[provider];
    if (variable !== undefined && keyOf(provider) === undefined)
      return yield* invalid(`${variable} is not set, so ${target.provider}/${target.model} cannot be asked.`);
    return target;
  });

/** One model client reaching every provider with a key set, and the local server. The keys are read when the layer is built. */
export const Clients = Layer.unwrap(
  Effect.suspend(() => {
  const http = FetchHttpClient.layer;
  const requests: Array<Effect.Effect<readonly [ProviderName, ProviderRequest]>> = [];
  const anthropic = keyOf("anthropic");
  if (anthropic !== undefined)
    requests.push(
      anthropicRequests().pipe(
        Effect.map((request) => [ProviderName.make("anthropic"), request] as const),
        Effect.provide(AnthropicClient.layer({ apiKey: Redacted.make(anthropic) }).pipe(Layer.provide(http))),
      ),
    );
  const openai = keyOf("openai");
  if (openai !== undefined)
    requests.push(
      openAiRequests().pipe(
        Effect.map((request) => [ProviderName.make("openai"), request] as const),
        Effect.provide(OpenAiClient.layer({ apiKey: Redacted.make(openai) }).pipe(Layer.provide(http))),
      ),
    );
  const xai = keyOf("xai");
  if (xai !== undefined)
    requests.push(
      xAiRequests().pipe(
        Effect.map((request) => [ProviderName.make("xai"), request] as const),
        Effect.provide(xAiClient(Redacted.make(xai)).pipe(Layer.provide(http))),
      ),
    );
  requests.push(
    openAiCompatRequests().pipe(
      Effect.map((request) => [ProviderName.make("localhost"), request] as const),
      Effect.provide(OpenAiCompatClient.layer({ apiUrl: localUrl, apiKey: Redacted.make("none") }).pipe(Layer.provide(http))),
    ),
  );
  return Effect.all(requests).pipe(Effect.map((each) => FallbackModelClient({ requests: new Map(each), fallbacks: [] })));
  }),
);


const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const list = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : []);

/**
 * What the local server's model list says of each model it serves, by the model's name: its
 * `models` entries give the context window, the kinds of input and the reasoning levels.
 */
export function localCapabilities(listed: unknown): ReadonlyMap<string, Capabilities> {
  if (!isRecord(listed)) return new Map();
  return new Map(
    list(listed["models"]).flatMap((model) => {
      if (!isRecord(model) || typeof model["slug"] !== "string") return [];
      const efforts = list(model["supported_reasoning_levels"]).flatMap((level) => (isRecord(level) && typeof level["effort"] === "string" ? [level["effort"]] : []));
      const input = list(model["input_modalities"]).filter((kind): kind is string => typeof kind === "string");
      const capabilities: Capabilities = {
        ...(typeof model["context_window"] === "number" ? { context: model["context_window"] } : {}),
        input: input.length === 0 ? ["text"] : input,
        ...(efforts.length === 0 ? {} : { efforts }),
        price: { input: 0, output: 0 },
      };
      return [[model["slug"], capabilities] as const];
    }),
  );
}

/**
 * The models the local server serves, by the names it takes (`GET /v1/models`, `data[].id`), or
 * `undefined` when it does not answer within a second.
 */
export const localModels: Effect.Effect<ReadonlyArray<string> | undefined> = Effect.tryPromise(() =>
  fetch(`${localUrl}/models`, { signal: AbortSignal.timeout(1000) }).then((response) => response.json() as Promise<unknown>),
).pipe(
  Effect.map((listed) =>
    isRecord(listed) ? list(listed["data"]).flatMap((model) => (isRecord(model) && typeof model["id"] === "string" ? [model["id"]] : [])) : [],
  ),
  Effect.orElseSucceed(() => undefined),
);

/** Where the local server is, as `bun cli models` says it. */
export const localServer = localUrl;

/**
 * What is known of each model: for `localhost`, what the local server lists, asked once when first
 * needed; for the others, the well-known models. A server that does not answer leaves its models unknown,
 * and that is logged.
 */
export const KnownToCli = Layer.effect(
  KnownModels,
  Effect.gen(function* () {
    const local = yield* Effect.cached(
      Effect.tryPromise(() => fetch(`${localUrl}/models`).then((response) => response.json() as Promise<unknown>)).pipe(
        Effect.map(localCapabilities),
        Effect.catch((error) => Effect.logWarning("cli.local_models.not_listed", { url: `${localUrl}/models`, error: String(error) }).pipe(Effect.as(new Map<string, Capabilities>()))),
      ),
    );
    return (provider, model) => (provider === "localhost" ? Effect.map(local, (models) => models.get(model)) : Effect.succeed(capabilitiesOf(provider, model)));
  }),
);

/** The settings function for each provider the CLI reaches: the default ones, and for `localhost` the Chat Completions adapter's. */
export const SettlingForCli = Layer.effect(
  Settling,
  Effect.gen(function* () {
    const settling = yield* Settling;
    return (provider) => (provider === "localhost" ? openAiCompatSettle : settling(provider));
  }),
);
