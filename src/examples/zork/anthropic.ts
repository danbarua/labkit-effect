/** Live Claude models, through the same adapter as the rest of the harness. */
import { AnthropicClient } from "@effect/ai-anthropic";
import { Layer, type Redacted } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { ModelName, ProviderName, TokenCount } from "../../agent-machine/names.ts";
import { AnthropicModelClient } from "../../agent-session/providers/anthropic-client.ts";
import type { Player } from "./scenario.ts";

/** Returns a player that asks the Claude `model` with `apiKey`, with thinking off where the model can turn it off, and short responses. */
export const anthropicPlayer =
  (apiKey: Redacted.Redacted<string>) =>
  (model: string): Player => ({
    target: {
      provider: ProviderName.make("anthropic"),
      model: ModelName.make(model),
      settings: { thinking: "disabled", maxOutputTokens: TokenCount.make(1024) },
    },
    client: AnthropicModelClient.pipe(Layer.provide(AnthropicClient.layer({ apiKey }).pipe(Layer.provide(FetchHttpClient.layer)))),
  });
