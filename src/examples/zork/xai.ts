/** Live Grok models, through the same adapter as the rest of the harness. */
import { Layer, type Redacted } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { ModelName, ProviderName, TokenCount } from "../../agent-machine/names.ts";
import { xAiClient, XAiModelClient } from "../../agent-session/providers/xai-client.ts";
import type { Player } from "./scenario.ts";

/**
 * Returns a player that asks the Grok `model` with `apiKey`, with short responses. Grok's models
 * cannot turn their reasoning off, so no thinking setting is given; xAI does not count the reasoning
 * against the output limit.
 */
export const xaiPlayer =
  (apiKey: Redacted.Redacted<string>) =>
  (model: string): Player => ({
    target: { provider: ProviderName.make("xai"), model: ModelName.make(model), settings: { maxOutputTokens: TokenCount.make(1024) } },
    client: XAiModelClient.pipe(Layer.provide(xAiClient(apiKey).pipe(Layer.provide(FetchHttpClient.layer)))),
  });
