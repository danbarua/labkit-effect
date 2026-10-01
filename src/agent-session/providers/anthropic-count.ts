/**
 * How many input tokens a request would take, counted by Anthropic before it is sent
 * (`POST /v1/messages/count_tokens`): the request's body as the adapter shapes it, files included,
 * without the output limit, which the endpoint does not take. Counted with the provider's
 * tokenizer, so it is the provider's figure.
 */

import { AnthropicClient } from "@effect/ai-anthropic";
import { Effect } from "effect";
import type * as AiError from "effect/ai/AiError";
import type { ModelContext, Target } from "../contracts.ts";
import { defaultRetries, invalidOutput, type Post, postJson, type Retries, withRetries } from "../provider-call.ts";
import { filesIn, type Json, numberAt } from "../shaping.ts";
import { body } from "./anthropic-client.ts";

const caller = { module: "AnthropicModelClient", method: "countTokens" };

export const anthropicInputTokens = (
  retries: Retries = defaultRetries,
): Effect.Effect<(target: Target, context: ModelContext) => Effect.Effect<number, AiError.AiError>, never, AnthropicClient.AnthropicClient> =>
  Effect.gen(function* () {
    const http = (yield* AnthropicClient.AnthropicClient).client.httpClient;
    return (target, context) =>
      filesIn(context).pipe(
        Effect.flatMap((files) => {
          const { max_tokens: _limit, ...shaped } = body(target, context, files).json as Record<string, Json>;
          const post: Post = { path: "/v1/messages/count_tokens", headers: {}, body: shaped };
          return postJson(http, caller, post).pipe(
            Effect.flatMap((response) => {
              const counted = numberAt(response, "input_tokens");
              return counted === undefined
                ? Effect.fail(invalidOutput(caller, `The count has no input_tokens: ${JSON.stringify(response)}`))
                : Effect.succeed(counted);
            }),
            withRetries(retries),
          );
        }),
      );
  });
