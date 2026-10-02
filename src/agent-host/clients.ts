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
        Effect.provide(OpenAiCompatClient.layer({ apiUrl: localServer, apiKey: Redacted.make("none") }).pipe(Layer.provide(http))),
      ),
    );
    return Effect.all(requests).pipe(Effect.map((each) => FallbackModelClient({ requests: new Map(each), fallbacks: [] })));
  }),
);
