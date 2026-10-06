/** Live models use the same adapter as the rest of the harness. */
import { AnthropicClient } from "@effect/ai-anthropic";
import { Layer, type Redacted } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { ModelName, ProviderName, TokenCount } from "../../agent-machine/names.ts";
import { AnthropicModelClient } from "../../agent-session/providers/anthropic-client.ts";
import type { Player, Setup } from "./scenario.ts";

export const anthropicSetup = (
  apiKey: Redacted.Redacted<string>,
  engineModel = "claude-sonnet-4-5",
  adventurerModel = "claude-haiku-4-5",
): Setup => {
  const client = AnthropicModelClient.pipe(
    Layer.provide(AnthropicClient.layer({ apiKey }).pipe(Layer.provide(FetchHttpClient.layer))),
  );
  const player = (model: string): Player => ({
    target: {
      provider: ProviderName.make("anthropic"),
      model: ModelName.make(model),
      settings: { thinking: "disabled", maxOutputTokens: TokenCount.make(1024) },
    },
    client,
  });
  return { engine: player(engineModel), adventurer: player(adventurerModel) };
};
