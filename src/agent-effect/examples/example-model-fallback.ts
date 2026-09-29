/**
 * Example: a fallback chain from Anthropic to OpenAI, over stand-in providers that answer, or fail
 * with the `AiError` reason given. A real chain passes each adapter's requests instead
 * (`anthropicRequests`, `openAiRequests`). `tests/model-fallback.test.ts` runs it through the loop.
 */

import { Effect } from "effect";
import * as AiError from "effect/ai/AiError";
import { ModelName, ModelText, ProviderName, StopReason } from "../../agent-core/names.ts";
import type { ProviderRequest, Target } from "../contracts.ts";
import { FallbackModelClient } from "../model-fallback.ts";
import { receivedJson } from "../received.ts";

export const anthropic: Target = { provider: ProviderName.make("anthropic"), model: ModelName.make("claude-sonnet-5") };
export const openAi: Target = { provider: ProviderName.make("openai"), model: ModelName.make("gpt-5.6") };

/** A stand-in provider that answers every request with `text`. */
export const answers =
  (text: string): ProviderRequest =>
  (target, _context, turn) =>
    Effect.succeed({
      _tag: "ModelResponded",
      turn,
      provider: target.provider,
      model: target.model,
      parts: [{ _tag: "Text", text: ModelText.make(text) }],
      stop: StopReason.make("end_turn"),
      ending: { _tag: "Complete" },
      metadata: receivedJson({}),
    });

/** A stand-in provider whose every request fails for `reason`, as an adapter reports it after its retries. */
export const failsWith =
  (reason: AiError.AiErrorReason): ProviderRequest =>
  () =>
    Effect.fail(AiError.make({ module: "ExampleProvider", method: "respond", reason }));

/** Requests go to Anthropic first, and to OpenAI when Anthropic cannot serve them. */
export const anthropicThenOpenAi = (requests: { readonly anthropic: ProviderRequest; readonly openAi: ProviderRequest }) =>
  FallbackModelClient({
    requests: new Map([
      [anthropic.provider, requests.anthropic],
      [openAi.provider, requests.openAi],
    ]),
    fallbacks: [openAi],
  });
