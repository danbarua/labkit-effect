/**
 * A model client for the Anthropic Messages API, sent through Effect's `AnthropicClient`. It shapes the core's types into
 * the wire format and back.
 *
 * Out: the context's messages, tools, and tool outcomes become Anthropic blocks. A failed tool call
 * becomes an error `tool_result` whose content tells the model what to do next: for a tool that
 * does not exist, the tools that do; for input that does not fit, the tool's input schema and what
 * was given. Where the wire format needs something the context does not say, the client supplies
 * it and logs that it did.
 *
 * In: a response's `content` blocks become the observation's parts in order: a `text` block is
 * `Text`, a `thinking` block with its signature is `Thinking`, a `tool_use` block is `ToolCall`
 * (whatever the tool's name), any other block is `Unrecognised` holding the block as received. Everything else in the response is `metadata`. A failure is observed as `ModelFailed`;
 * what was received with it is logged here. The loop annotates these logs with the turn.
 */

import { AnthropicClient } from "@effect/ai-anthropic";
import { Effect, Layer } from "effect";
import type * as AiError from "effect/ai/AiError";
import type * as HttpClient from "effect/http/HttpClient";
import {
  CallId,
  ModelText,
  StopReason,
  ThinkingSignature,
  ThinkingText,
  ToolName,
  type TurnId,
} from "../../agent-core/names.ts";
import type { ModelPart, Observation } from "../../agent-core/observation.ts";
import {
  type ContextMessage,
  type ContextPart,
  type ModelContext,
  ModelClient,
  type ProviderRequest,
  type Target,
} from "../contracts.ts";
import { logKeys } from "../log-keys.ts";
import { defaultRetries, invalidOutput, modelClientOf, postJson, type Retries, withRetries } from "../provider-call.ts";
import { receivedJson } from "../received.ts";
import {
  type Called,
  callsIn,
  endingOf,
  isObject,
  type Json,
  logSupplied,
  type RenderedResult,
  renderToolResult,
  type Shaped,
  toolInputObject,
} from "../shaping.ts";

type Outcome = Extract<Observation, { _tag: "ModelResponded" | "ModelFailed" }>;

/** The output limit sent when the context sets none; the Messages API requires one. */
const defaultMaxTokens = 1024;

function resultContent(result: RenderedResult): { content: string; is_error?: true } {
  return result.isError ? { content: result.text, is_error: true } : { content: result.text };
}

function block(part: ContextPart, context: ModelContext, calls: ReadonlyMap<CallId, Called>): Shaped {
  switch (part._tag) {
    case "Text":
      return { json: { type: "text", text: part.text }, supplied: [] };
    case "ToolCall": {
      const input = toolInputObject(part.call, part.input);
      return {
        json: { type: "tool_use", id: part.call, name: part.tool, input: input.json },
        supplied: input.supplied,
      };
    }
    case "ToolResult":
      return {
        json: {
          type: "tool_result",
          tool_use_id: part.call,
          ...resultContent(renderToolResult(part.outcome, calls.get(part.call), context.tools)),
        },
        supplied: [],
      };
    default:
      return part satisfies never;
  }
}

/**
 * The Messages API role for a message. An instruction is a mid-conversation `system` message, which
 * not every model accepts; a model that does not fails the request with the provider's error.
 */
function role(message: ContextMessage): string {
  switch (message.role) {
    case "user":
    case "assistant":
      return message.role;
    case "instruction":
      return "system";
    default:
      return message.role satisfies never;
  }
}

function body(target: Target, context: ModelContext): Shaped {
  const calls = callsIn(context);
  const messages = context.messages.map((message) => {
    const blocks = message.parts.map((part) => block(part, context, calls));
    return {
      json: { role: role(message), content: blocks.map((shaped) => shaped.json) },
      supplied: blocks.flatMap((shaped) => shaped.supplied),
    };
  });
  return {
    json: {
      model: target.model,
      max_tokens: defaultMaxTokens,
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
      messages: messages.map((message) => message.json),
    },
    supplied: [
      {
        level: "info",
        event: logKeys.anthropic.maxTokensSupplied,
        details: {
          max_tokens: defaultMaxTokens,
          reason: "the Messages API requires max_tokens and the context sets no output limit",
        },
      },
      ...messages.flatMap((message) => message.supplied),
    ],
  };
}

function part(received: Json): ModelPart {
  if (isObject(received)) {
    const { type, text, id, name, input } = received;
    if (type === "text" && typeof text === "string") return { _tag: "Text", text: ModelText.make(text) };
    const { thinking, signature } = received;
    if (type === "thinking" && typeof thinking === "string" && typeof signature === "string")
      return { _tag: "Thinking", text: ThinkingText.make(thinking), signature: ThinkingSignature.make(signature) };
    if (type === "tool_use" && typeof id === "string" && typeof name === "string" && input !== undefined)
      return {
        _tag: "ToolCall",
        call: CallId.make(id),
        tool: ToolName.make(name),
        input: receivedJson(input),
      };
  }
  return { _tag: "Unrecognised", received: receivedJson(received) };
}

const caller = { module: "AnthropicModelClient", method: "respond" };

/** Anthropic's `stop_reason` values. */
export const anthropicEndings = new Map([
  ["end_turn", "Complete"],
  ["tool_use", "Complete"],
  ["max_tokens", "CutShort"],
  ["stop_sequence", "CutShort"],
  ["pause_turn", "CutShort"],
  ["model_context_window_exceeded", "CutShort"],
  ["refusal", "Refused"],
] as const);

/** One request: the observation it produced, or the `AiError` it failed with. */
const respondOnce = (
  http: HttpClient.HttpClient,
  target: Target,
  context: ModelContext,
  turn: TurnId,
): Effect.Effect<Extract<Outcome, { _tag: "ModelResponded" }>, AiError.AiError> =>
  Effect.gen(function* () {
    const sent = body(target, context);
    yield* logSupplied(sent.supplied);
    const response = yield* postJson(http, caller, "/v1/messages", sent.json);
    if (!isObject(response) || !Array.isArray(response["content"]))
      return yield* invalidOutput(caller, `The response has no content blocks: ${JSON.stringify(response)}`);
    const { content, stop_reason, ...metadata } = response;
    return {
      _tag: "ModelResponded" as const,
      turn,
      provider: target.provider,
      model: target.model,
      parts: (content as ReadonlyArray<Json>).map(part),
      stop: StopReason.make(typeof stop_reason === "string" ? stop_reason : JSON.stringify(stop_reason ?? null)),
      ending: endingOf(anthropicEndings, stop_reason),
      metadata: receivedJson(metadata),
    };
  });

/**
 * Requests go through the configured `AnthropicClient` (its address, key and API version); its
 * typed response decoding is not used, so a block type it does not know is kept as `Unrecognised`
 * rather than failing the response. A failure is an `AiError`; retryable ones are retried.
 */
export const anthropicRequests = (
  retries: Retries = defaultRetries,
): Effect.Effect<ProviderRequest, never, AnthropicClient.AnthropicClient> =>
  Effect.gen(function* () {
    const http = (yield* AnthropicClient.AnthropicClient).client.httpClient;
    return (target, context, turn) => respondOnce(http, target, context, turn).pipe(withRetries(retries));
  });

export const anthropicModelClient = (retries: Retries = defaultRetries) =>
  Layer.effect(ModelClient, anthropicRequests(retries).pipe(Effect.map(modelClientOf)));

export const AnthropicModelClient = anthropicModelClient();
