/**
 * A model client over HTTP, in the Anthropic Messages wire format. A response's `content` blocks
 * become the observation's parts in order: a `text` block is `Text`, a `tool_use` block is
 * `ToolCall`, any other block is `Unrecognised` holding the block as received. Everything else in
 * the response is `metadata`.
 * A failure is observed as `ModelFailed`; what was received with it is logged here.
 */

import { Effect, Layer, type Schema } from "effect";
import { CallId, FailureText, ModelText, StopReason, ToolName } from "../agent-core/names.ts";
import type { ModelPart, Observation, ToolOutcome } from "../agent-core/observation.ts";
import { type ContextPart, type ModelContext, ModelClient, type Target } from "./contracts.ts";
import { asText, parseJson, receivedJson } from "./received.ts";
import type { TurnId } from "../agent-core/names.ts";

type Json = Schema.Json;

function isObject(value: Json): value is Schema.JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
type Outcome = Extract<Observation, { _tag: "ModelResponded" | "ModelFailed" }>;

function resultContent(outcome: ToolOutcome): { content: string; is_error?: true } {
  switch (outcome._tag) {
    case "Succeeded":
      return { content: asText(outcome.output) };
    case "Failed":
      return { content: asText(outcome.error), is_error: true };
    case "Vetoed":
      return { content: `The call was not run: ${asText(outcome.reason)}`, is_error: true };
    default:
      return outcome satisfies never;
  }
}

function block(part: ContextPart): Json {
  switch (part._tag) {
    case "Text":
      return { type: "text", text: part.text };
    case "ToolCall": {
      // The provider requires the input it sent back as an object; it sent it as JSON.
      const parsed = parseJson(part.input);
      return { type: "tool_use", id: part.call, name: part.tool, input: "value" in parsed ? parsed.value : {} };
    }
    case "ToolResult":
      return { type: "tool_result", tool_use_id: part.call, ...resultContent(part.outcome) };
    default:
      return part satisfies never;
  }
}

function body(target: Target, context: ModelContext): Json {
  return {
    model: target.model,
    max_tokens: 1024,
    ...(context.system === undefined ? {} : { system: context.system }),
    ...(context.tools.length === 0
      ? {}
      : {
          tools: context.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.input,
          })),
        }),
    messages: context.messages.map((message) => ({ role: message.role, content: message.parts.map(block) })),
  };
}

function part(received: Json): ModelPart {
  if (isObject(received)) {
    const { type, text, id, name, input } = received;
    if (type === "text" && typeof text === "string") return { _tag: "Text", text: ModelText.make(text) };
    if (type === "tool_use" && typeof id === "string" && typeof name === "string" && input !== undefined)
      return { _tag: "ToolCall", call: CallId.make(id), tool: ToolName.make(name), input: receivedJson(input) };
  }
  return { _tag: "Unrecognised", received: receivedJson(received) };
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
        metadata: receivedJson(metadata),
      };
      return outcome;
    }),
});
