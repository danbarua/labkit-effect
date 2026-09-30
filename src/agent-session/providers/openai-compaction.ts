/**
 * The provider's own compaction, through the OpenAI Responses adapter's shaping. xAI takes the same
 * request (`xai-compaction.ts`).
 */

import { OpenAiClient } from "@effect/ai-openai";
import { Effect } from "effect";
import type * as AiError from "effect/ai/AiError";
import type { Received } from "../../agent-machine/received.ts";
import type { ModelContext, Target } from "../contracts.ts";
import { defaultRetries, invalidOutput, type Post, postJson, type Retries, withRetries } from "../provider-call.ts";
import { receivedJson } from "../received.ts";
import { isObject, type Json, logSupplied } from "../shaping.ts";
import { body } from "./openai-client.ts";

/**
 * What the provider's own compaction returned: `output`, the array of items that stand in for what
 * was compacted, as received; and the rest of the response.
 */
export interface Compacted {
  readonly output: Received;
  readonly metadata: Received;
}

const compactCaller = { module: "OpenAiResponsesModelClient", method: "compact" };

/**
 * The provider's own compaction of `context` (`POST /responses/compact`), through the configured
 * `OpenAiClient`, retried while retryable. The context is shaped as a request's is, without
 * settings; the response is not streamed. Its `output` items stand in for the input they were made
 * from, and are returned as received: each goes back unchanged, in order, at the head of the next
 * request's input, which is where the provider reads them (xAI returns one `compaction` item;
 * OpenAI returns the user's messages and a `compaction` item). `providerCompaction` makes them a
 * summary.
 */
export const openAiCompactions = (
  retries: Retries = defaultRetries,
): Effect.Effect<(target: Target, context: ModelContext) => Effect.Effect<Compacted, AiError.AiError>, never, OpenAiClient.OpenAiClient> =>
  Effect.gen(function* () {
    const http = (yield* OpenAiClient.OpenAiClient).client;
    return (target, context) => {
      const sent = body(target, context);
      const post: Post = { path: "/responses/compact", headers: {}, body: sent.json as Record<string, Json> };
      return logSupplied(sent.supplied).pipe(
        Effect.andThen(
          postJson(http, compactCaller, post).pipe(
            Effect.flatMap((response) => {
              if (!isObject(response) || !Array.isArray(response["output"]))
                return Effect.fail(invalidOutput(compactCaller, `The compaction has no output: ${JSON.stringify(response)}`));
              const { output, ...metadata } = response;
              return Effect.succeed({ output: receivedJson(output), metadata: receivedJson(metadata) });
            }),
            withRetries(retries),
          ),
        ),
      );
    };
  });

