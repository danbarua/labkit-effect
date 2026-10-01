/**
 * How many input tokens a request would take, counted by OpenAI before it is sent
 * (`POST /responses/input_tokens`): the request's input as the Responses adapter shapes it, files
 * included. Counted with the provider's tokenizer, so it is the provider's figure. xAI has no such
 * endpoint (it answers 405).
 */

import { OpenAiClient } from "@effect/ai-openai";
import { Effect } from "effect";
import type * as AiError from "effect/ai/AiError";
import type { ModelContext, Target } from "../contracts.ts";
import { defaultRetries, invalidOutput, type Post, postJson, type Retries, withRetries } from "../provider-call.ts";
import { filesIn, type Json, numberAt } from "../shaping.ts";
import { body } from "./openai-client.ts";

const caller = { module: "OpenAiResponsesModelClient", method: "countTokens" };

export const openAiInputTokens = (
  retries: Retries = defaultRetries,
): Effect.Effect<(target: Target, context: ModelContext) => Effect.Effect<number, AiError.AiError>, never, OpenAiClient.OpenAiClient> =>
  Effect.gen(function* () {
    const http = (yield* OpenAiClient.OpenAiClient).client;
    return (target, context) =>
      filesIn(context).pipe(
        Effect.flatMap((files) => {
          const post: Post = { path: "/responses/input_tokens", headers: {}, body: body(target, context, files).json as Record<string, Json> };
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
