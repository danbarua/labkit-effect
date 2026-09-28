/**
 * A model client over HTTP, in the Anthropic Messages wire format. A response's `content` blocks
 * become the observation's parts in order: a `text` block is `Text`, any other block is
 * `Unrecognised` holding the block as received. Everything else in the response is `metadata`.
 * A failure is observed as `ModelFailed`; what was received with it is logged here.
 */

import { Effect, Layer, type Schema } from "effect";
import { FailureText, ModelText, StopReason } from "../agent-core/names.ts";
import type { ModelPart, Observation } from "../agent-core/observation.ts";
import { type ModelContext, ModelClient, type Target } from "./contracts.ts";
import type { TurnId } from "../agent-core/names.ts";

type Json = Schema.Json;

function isObject(value: Json): value is Schema.JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
type Outcome = Extract<Observation, { _tag: "ModelResponded" | "ModelFailed" }>;

function body(target: Target, context: ModelContext): Json {
  return {
    model: target.model,
    max_tokens: 1024,
    ...(context.system === undefined ? {} : { system: context.system }),
    messages: context.messages.map((message) => ({ role: message.role, content: message.text })),
  };
}

function part(block: Json): ModelPart {
  const text = isObject(block) && block["type"] === "text" ? block["text"] : undefined;
  return typeof text === "string"
    ? { _tag: "Text", text: ModelText.make(text) }
    : { _tag: "Unrecognised", received: block };
}

const failed = (turn: TurnId, failure: string, details: Record<string, unknown>): Effect.Effect<Outcome> =>
  Effect.logError("model.request.failed", { turn, failure, ...details }).pipe(
    Effect.as({ _tag: "ModelFailed" as const, turn, failure: FailureText.make(failure) }),
  );

export const HttpModelClient = Layer.succeed(ModelClient, {
  respond: (target, context, turn) =>
    Effect.gen(function* () {
      const sent = body(target, context);
      const received = yield* Effect.tryPromise(async () => {
        const response = await fetch(target.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(sent),
        });
        return { status: response.status, text: await response.text() };
      }).pipe(Effect.result);
      if (received._tag === "Failure")
        return yield* failed(turn, "the request did not complete", {
          endpoint: target.endpoint.href,
          cause: String(received.failure),
        });
      const { status, text } = received.success;
      if (status < 200 || status > 299)
        return yield* failed(turn, `the provider answered HTTP ${status}`, {
          endpoint: target.endpoint.href,
          status,
          body: text,
        });
      const parsed = yield* Effect.try(() => JSON.parse(text) as Json).pipe(Effect.result);
      if (parsed._tag === "Failure")
        return yield* failed(turn, "the response is not JSON", { endpoint: target.endpoint.href, status, body: text });
      const response = parsed.success;
      if (!isObject(response) || !Array.isArray(response["content"]))
        return yield* failed(turn, "the response has no content blocks", { endpoint: target.endpoint.href, status, body: text });
      const { content, stop_reason, ...metadata } = response;
      const outcome: Outcome = {
        _tag: "ModelResponded",
        turn,
        provider: target.provider,
        model: target.model,
        parts: (content as ReadonlyArray<Json>).map(part),
        stop: StopReason.make(typeof stop_reason === "string" ? stop_reason : String(stop_reason)),
        metadata,
      };
      return outcome;
    }),
});
