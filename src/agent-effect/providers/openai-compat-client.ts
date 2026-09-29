/**
 * A model client for OpenAI-compatible Chat Completions APIs, sent through Effect's
 * `OpenAiClient` from `@effect/ai-openai-compat`. The provider is whichever the client's `apiUrl`
 * points at.
 *
 * Out: the system text is a `system` message; the context's messages become chat messages: text
 * as `text` content parts, the model's tool calls as an assistant message's `tool_calls`, each tool
 * outcome as a `tool` message carrying the text the model is sent. The catalog is sent as
 * `function` tools. An earlier response's other fields (`reasoning_content`, ...) are not sent back
 * yet; each one left out is logged.
 *
 * In: the first choice's message becomes the observation's parts in order: its `content` is
 * `Text`, each of its `tool_calls` is `ToolCall` (whatever the tool's name), its arguments kept as
 * the text received; any other field of the message (`reasoning_content`, `refusal`, ...) is
 * `Unrecognised`, holding that field. The stop is the choice's `finish_reason`; everything else in
 * the response is `metadata`. A request that fails, after retries, is observed as `ModelFailed`.
 */

import { OpenAiClient } from "@effect/ai-openai-compat";
import { Effect, Layer, type Schema } from "effect";
import type * as AiError from "effect/ai/AiError";
import type * as HttpClient from "effect/http/HttpClient";
import { CallId, ModelText, StopReason, ToolName, type TurnId } from "../../agent-core/names.ts";
import type { ModelPart, Observation } from "../../agent-core/observation.ts";
import { type ContextMessage, type ModelContext, ModelClient, type ProviderRequest, type Target } from "../contracts.ts";
import { defaultRetries, invalidOutput, modelClientOf, postJson, type Retries, withRetries } from "../provider-call.ts";
import { receivedJson, receivedJsonText } from "../received.ts";
import {
  type Called,
  callsIn,
  endingOf,
  isObject,
  type Json,
  leftOut,
  logSupplied,
  renderToolResult,
  type Shaped,
  toolInputObject,
} from "../shaping.ts";

type Responded = Extract<Observation, { _tag: "ModelResponded" }>;

const caller = { module: "OpenAiCompatModelClient", method: "respond" };

/** The chat role for a message: an instruction is a `system` message in the conversation. */
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

/** The chat messages one context message becomes: tool outcomes each become their own message. */
function chatMessages(message: ContextMessage, calls: ReadonlyMap<CallId, Called>, context: ModelContext): Shaped {
  const notSent = message.parts.flatMap((part) =>
    part._tag === "Thinking" || part._tag === "Unrecognised"
      ? leftOut(part, "this adapter does not send an earlier response's other fields back").supplied
      : [],
  );
  const text = message.parts.flatMap((part) => (part._tag === "Text" ? [{ type: "text", text: part.text }] : []));
  const toolCalls = message.parts.flatMap((part) =>
    part._tag === "ToolCall" ? [{ call: part.call, tool: part.tool, input: toolInputObject(part.call, part.input) }] : [],
  );
  const results = message.parts.flatMap((part) =>
    part._tag === "ToolResult"
      ? [
          {
            role: "tool",
            tool_call_id: part.call,
            content: renderToolResult(part.outcome, calls.get(part.call), context.tools).text,
          },
        ]
      : [],
  );
  const own =
    text.length === 0 && toolCalls.length === 0
      ? []
      : [
          {
            role: role(message),
            content: text.length === 0 ? null : text,
            ...(toolCalls.length === 0
              ? {}
              : {
                  tool_calls: toolCalls.map((call) => ({
                    id: call.call,
                    type: "function",
                    function: { name: call.tool, arguments: JSON.stringify(call.input.json) },
                  })),
                }),
          },
        ];
  return { json: [...results, ...own], supplied: [...toolCalls.flatMap((call) => call.input.supplied), ...notSent] };
}

function body(target: Target, context: ModelContext): Shaped {
  const calls = callsIn(context);
  const messages = context.messages.map((message) => chatMessages(message, calls, context));
  return {
    json: {
      model: target.model,
      messages: [
        ...(context.system === undefined ? [] : [{ role: "system", content: context.system }]),
        ...messages.flatMap((message) => message.json as ReadonlyArray<Json>),
      ],
      ...(context.tools.length === 0
        ? {}
        : {
            tools: context.tools.map((tool) => ({
              type: "function",
              function: { name: tool.name, description: tool.description, parameters: tool.input },
            })),
          }),
    },
    supplied: messages.flatMap((message) => message.supplied),
  };
}

function toolCall(call: Json): ModelPart {
  if (isObject(call) && typeof call["id"] === "string" && isObject(call["function"] ?? null)) {
    const fn = call["function"] as { readonly name?: Json; readonly arguments?: Json };
    if (typeof fn.name === "string" && typeof fn.arguments === "string")
      return {
        _tag: "ToolCall",
        call: CallId.make(call["id"]),
        tool: ToolName.make(fn.name),
        input: receivedJsonText(fn.arguments),
      };
  }
  return { _tag: "Unrecognised", received: receivedJson(call) };
}

/**
 * The parts the choice's message becomes. Any other field of the message is kept as `Unrecognised`,
 * unless it holds nothing: `null`, or an empty array (OpenAI sends `refusal: null` and
 * `annotations: []` with every message).
 */
function parts(message: Schema.JsonObject): ReadonlyArray<ModelPart> {
  const { role: _role, content, tool_calls, ...rest } = message;
  return [
    ...(typeof content === "string" && content.length > 0 ? [{ _tag: "Text" as const, text: ModelText.make(content) }] : []),
    ...Object.entries(rest)
      .filter(([, value]) => value !== null && value !== undefined && !(Array.isArray(value) && value.length === 0))
      .map(([field, value]): ModelPart => ({ _tag: "Unrecognised", received: receivedJson({ [field]: value as Json }) })),
    ...(Array.isArray(tool_calls) ? (tool_calls as ReadonlyArray<Json>).map(toolCall) : []),
  ];
}

/** A choice's `finish_reason` values. */
const endings = new Map([
  ["stop", "Complete"],
  ["tool_calls", "Complete"],
  ["function_call", "Complete"],
  ["length", "CutShort"],
  ["content_filter", "Refused"],
] as const);

const respondOnce = (
  http: HttpClient.HttpClient,
  target: Target,
  context: ModelContext,
  turn: TurnId,
): Effect.Effect<Responded, AiError.AiError> =>
  Effect.gen(function* () {
    const sent = body(target, context);
    yield* logSupplied(sent.supplied);
    const response = yield* postJson(http, caller, "/chat/completions", sent.json);
    const choices = isObject(response) ? response["choices"] : undefined;
    const choice = Array.isArray(choices) ? (choices as ReadonlyArray<Json>)[0] : undefined;
    const message = choice !== undefined && isObject(choice) ? choice["message"] : undefined;
    if (!isObject(response) || choice === undefined || !isObject(choice) || message === undefined || !isObject(message))
      return yield* invalidOutput(caller, `The response has no choice with a message: ${JSON.stringify(response)}`);
    const { choices: _choices, ...metadata } = response;
    const { message: _message, finish_reason, ...choiceRest } = choice;
    return {
      _tag: "ModelResponded" as const,
      turn,
      provider: target.provider,
      model: target.model,
      parts: parts(message),
      stop: StopReason.make(typeof finish_reason === "string" ? finish_reason : JSON.stringify(finish_reason ?? null)),
      ending: endingOf(endings, finish_reason),
      metadata: receivedJson({ ...metadata, choice: choiceRest }),
    };
  });

/** Requests through the configured compatible client, retried while retryable; a failure is the `AiError`. */
export const openAiCompatRequests = (
  retries: Retries = defaultRetries,
): Effect.Effect<ProviderRequest, never, OpenAiClient.OpenAiClient> =>
  Effect.gen(function* () {
    const http = (yield* OpenAiClient.OpenAiClient).client;
    return (target, context, turn) => respondOnce(http, target, context, turn).pipe(withRetries(retries));
  });

export const openAiCompatModelClient = (retries: Retries = defaultRetries) =>
  Layer.effect(ModelClient, openAiCompatRequests(retries).pipe(Effect.map(modelClientOf)));

export const OpenAiCompatModelClient = openAiCompatModelClient();
