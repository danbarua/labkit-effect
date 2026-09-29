/**
 * A model client for the OpenAI Responses API, sent through Effect's `OpenAiClient`.
 *
 * Out: the system text is `instructions`; the context's messages become input items: text as
 * `input_text` or `output_text` messages, a tool call as a `function_call` item, a tool outcome as
 * a `function_call_output` item carrying the text the model is sent. The catalog is sent as
 * `function` tools.
 *
 * In: the response's `output` items become the observation's parts in order: each `output_text` of
 * a `message` is `Text`; a `function_call` is `ToolCall` (whatever the tool's name), its arguments
 * kept as the text received; every other item or content part is `Unrecognised`. The stop is the
 * response's `status` (with the reason when it is `incomplete`); everything else in the response is
 * `metadata`. A request that fails, after retries, is observed as `ModelFailed`.
 */

import { OpenAiClient } from "@effect/ai-openai";
import { Effect, Layer } from "effect";
import type * as AiError from "effect/ai/AiError";
import type * as HttpClient from "effect/http/HttpClient";
import { CallId, ModelText, StopReason, ToolName, type TurnId } from "../agent-core/names.ts";
import type { ModelPart, Observation } from "../agent-core/observation.ts";
import { type ContextMessage, type ModelContext, ModelClient, type Target } from "./contracts.ts";
import { defaultRetries, failedAs, invalidOutput, postJson, type Retries, withRetries } from "./provider-call.ts";
import { receivedJson, receivedJsonText } from "./received.ts";
import {
  type Called,
  callsIn,
  endingOf,
  isObject,
  type Json,
  logSupplied,
  renderToolResult,
  type Shaped,
  toolInputObject,
} from "./shaping.ts";

type Responded = Extract<Observation, { _tag: "ModelResponded" }>;

const caller = { module: "OpenAiResponsesModelClient", method: "respond" };

/** The input items one message becomes, in order. */
function items(message: ContextMessage, calls: ReadonlyMap<CallId, Called>, context: ModelContext): Shaped {
  const shaped = message.parts.map((part): Shaped => {
    switch (part._tag) {
      case "Text":
        return {
          json: {
            role: message.role,
            content: [{ type: message.role === "user" ? "input_text" : "output_text", text: part.text }],
          },
          supplied: [],
        };
      case "ToolCall": {
        const input = toolInputObject(part.call, part.input);
        return {
          json: { type: "function_call", call_id: part.call, name: part.tool, arguments: JSON.stringify(input.json) },
          supplied: input.supplied,
        };
      }
      case "ToolResult":
        return {
          json: {
            type: "function_call_output",
            call_id: part.call,
            output: renderToolResult(part.outcome, calls.get(part.call), context.tools).text,
          },
          supplied: [],
        };
      default:
        return part satisfies never;
    }
  });
  return { json: shaped.map((item) => item.json), supplied: shaped.flatMap((item) => item.supplied) };
}

function body(target: Target, context: ModelContext): Shaped {
  const calls = callsIn(context);
  const input = context.messages.map((message) => items(message, calls, context));
  return {
    json: {
      model: target.model,
      ...(context.system === undefined ? {} : { instructions: context.system }),
      ...(context.tools.length === 0
        ? {}
        : {
            tools: context.tools.map((tool) => ({
              type: "function",
              name: tool.name,
              description: tool.description,
              parameters: tool.input,
            })),
          }),
      input: input.flatMap((message) => message.json as ReadonlyArray<Json>),
    },
    supplied: input.flatMap((message) => message.supplied),
  };
}

/** The parts one output item becomes. */
function parts(item: Json): ReadonlyArray<ModelPart> {
  if (!isObject(item)) return [{ _tag: "Unrecognised", received: receivedJson(item) }];
  const { type } = item;
  if (type === "message" && Array.isArray(item["content"]))
    return (item["content"] as ReadonlyArray<Json>).map((content): ModelPart =>
      isObject(content) && content["type"] === "output_text" && typeof content["text"] === "string"
        ? { _tag: "Text", text: ModelText.make(content["text"]) }
        : { _tag: "Unrecognised", received: receivedJson(content) },
    );
  const { call_id, name, arguments: args } = item;
  if (type === "function_call" && typeof call_id === "string" && typeof name === "string" && typeof args === "string")
    return [{ _tag: "ToolCall", call: CallId.make(call_id), tool: ToolName.make(name), input: receivedJsonText(args) }];
  return [{ _tag: "Unrecognised", received: receivedJson(item) }];
}

function stopOf(status: Json | undefined, incomplete: Json | undefined): StopReason {
  const reason = isObject(incomplete ?? null) ? (incomplete as { reason?: Json }).reason : undefined;
  const text = typeof status === "string" ? status : JSON.stringify(status ?? null);
  return StopReason.make(typeof reason === "string" ? `${text}: ${reason}` : text);
}

/** A response's `status`, and for an incomplete one the reason in `incomplete_details`. */
const endings = new Map([
  ["completed", "Complete"],
  ["incomplete: max_output_tokens", "CutShort"],
  ["incomplete: content_filter", "Refused"],
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
    const response = yield* postJson(http, caller, "/responses", sent.json);
    if (!isObject(response) || !Array.isArray(response["output"]))
      return yield* invalidOutput(caller, `The response has no output items: ${JSON.stringify(response)}`);
    const { output, status, incomplete_details, ...metadata } = response;
    return {
      _tag: "ModelResponded" as const,
      turn,
      provider: target.provider,
      model: target.model,
      parts: (output as ReadonlyArray<Json>).flatMap(parts),
      stop: stopOf(status, incomplete_details),
      ending: endingOf(endings, stopOf(status, incomplete_details)),
      metadata: receivedJson(metadata),
    };
  });

export const openAiModelClient = (retries: Retries = defaultRetries) =>
  Layer.effect(
    ModelClient,
    Effect.gen(function* () {
      const http = (yield* OpenAiClient.OpenAiClient).client;
      return ModelClient.of({
        respond: (target, context, turn) =>
          respondOnce(http, target, context, turn).pipe(withRetries(retries), Effect.catch(failedAs(turn))),
      });
    }),
  );

export const OpenAiModelClient = openAiModelClient();
