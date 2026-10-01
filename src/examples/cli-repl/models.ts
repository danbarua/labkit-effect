/**
 * The models the CLI can ask: those `models.json` lists (a link to the providers' `frontier.json`),
 * each provider's key from the environment, and one model client that reaches every provider with a
 * key set and a local Chat Completions server at http://localhost:8000/v1.
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
import { invalid } from "./invalid.ts";
import models from "./models.json" with { type: "json" };

/** The known models, by provider, as `models.json` lists them. */
export const known: Readonly<Record<string, Readonly<Record<string, unknown>>>> = models;

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
 * The provider and model a name gives: `provider/model`, or a model `models.json` lists. A provider
 * whose key is not set cannot be asked, and the variable is named.
 */
export const targetOf = (model: string | undefined) =>
  Effect.gen(function* () {
    if (model === undefined) return yield* invalid("No model: pass --model (bun cli models lists them).");
    const slash = model.indexOf("/");
    const named = slash > 0 && (model.slice(0, slash) in known || model.slice(0, slash) === "localhost");
    const provider = named ? model.slice(0, slash) : Object.keys(known).find((each) => model in (known[each] ?? {}));
    if (provider === undefined) return yield* invalid(`No model ${model} in models.json; name it as provider/model.`);
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
      Effect.provide(OpenAiCompatClient.layer({ apiUrl: "http://localhost:8000/v1", apiKey: Redacted.make("none") }).pipe(Layer.provide(http))),
    ),
  );
  return Effect.all(requests).pipe(Effect.map((each) => FallbackModelClient({ requests: new Map(each), fallbacks: [] })));
  }),
);
