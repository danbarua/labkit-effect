/** One model client that reaches every provider whose key the environment holds, and the local server. */

import { AnthropicClient } from "@effect/ai-anthropic";
import { OpenAiClient } from "@effect/ai-openai";
import { OpenAiClient as OpenAiCompatClient } from "@effect/ai-openai-compat";
import { Effect, Layer, Redacted } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { ProviderName } from "../agent-machine/names.ts";
import type { ProviderRequest } from "../agent-session/contracts.ts";
import { FallbackModelClient } from "../agent-session/model-fallback.ts";
import { anthropicRequests } from "../agent-session/providers/anthropic-client.ts";
import { openAiRequests } from "../agent-session/providers/openai-client.ts";
import { openAiCompatRequests } from "../agent-session/providers/openai-compat-client.ts";
import { xAiClient, xAiRequests } from "../agent-session/providers/xai-client.ts";
import { keyOf } from "./catalog.ts";
import { localServer } from "./local-server.ts";

const http = FetchHttpClient.layer;

/** The providers reached with a key: each one's request, made with the key it is given. */
const keyed: ReadonlyArray<{ readonly provider: string; readonly requestsWith: (key: Redacted.Redacted) => Effect.Effect<ProviderRequest> }> = [
  { provider: "anthropic", requestsWith: (key) => anthropicRequests().pipe(Effect.provide(AnthropicClient.layer({ apiKey: key }).pipe(Layer.provide(http)))) },
  { provider: "openai", requestsWith: (key) => openAiRequests().pipe(Effect.provide(OpenAiClient.layer({ apiKey: key }).pipe(Layer.provide(http)))) },
  { provider: "xai", requestsWith: (key) => xAiRequests().pipe(Effect.provide(xAiClient(key).pipe(Layer.provide(http)))) },
];

/** The local server's request: it needs no key. */
const local = openAiCompatRequests().pipe(Effect.provide(OpenAiCompatClient.layer({ apiUrl: localServer, apiKey: Redacted.make("none") }).pipe(Layer.provide(http))));

/** One model client reaching every provider with a key set, and the local server. The keys are read when the layer is built. */
export const Clients = Layer.unwrap(
  Effect.suspend(() => {
    const requests: ReadonlyArray<Effect.Effect<readonly [ProviderName, ProviderRequest]>> = [
      ...keyed.flatMap(({ provider, requestsWith }) => {
        const key = keyOf(provider);
        return key === undefined ? [] : [Effect.map(requestsWith(key), (request) => [ProviderName.make(provider), request] as const)];
      }),
      Effect.map(local, (request) => [ProviderName.make("localhost"), request] as const),
    ];
    return Effect.all(requests).pipe(Effect.map((each) => FallbackModelClient({ requests: new Map(each), fallbacks: [] })));
  }),
);
