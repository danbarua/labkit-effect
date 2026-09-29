/**
 * A model client for the OpenAI Responses API, sent through Effect's `OpenAiClient`.
 *
 * Out: the system text is `instructions`; the context's messages become input items: text as
 * `input_text` or `output_text` messages, a tool call as a `function_call` item, a tool outcome as
 * a `function_call_output` item carrying the text the model is sent. The catalog is sent as
 * `function` tools. An item it did not recognise (a `reasoning` item, say) goes back to the provider
 * that produced it unchanged and in its place; for any other provider it is left out, as is
 * another provider's thinking, and that is logged.
 *
 * In: the response's `output` items become the observation's parts in order: a `message` whose
 * content is all `output_text` is a `Text` for each; a `function_call` is `ToolCall` (whatever the
 * tool's name), its arguments kept as the text received; every other item, a `message` with any
 * other content included, is `Unrecognised`, whole, so that it can be sent back as it came. The stop is the
 * response's `status` (with the reason when it is `incomplete`); everything else in the response is
 * `metadata`. A request that fails, after retries, is observed as `ModelFailed`.
 */

import { OpenAiClient } from "@effect/ai-openai";
import { Effect, Layer } from "effect";
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
  sentBack,
  toolInputObject,
} from "../shaping.ts";

type Responded = Extract<Observation, { _tag: "ModelResponded" }>;

const caller = { module: "OpenAiResponsesModelClient", method: "respond" };

/** The Responses role for a message, and the type of its text: an instruction is a `developer` message. */
function textAs(message: ContextMessage): { readonly role: string; readonly type: string } {
  switch (message.role) {
    case "user":
      return { role: "user", type: "input_text" };
    case "assistant":
      return { role: "assistant", type: "output_text" };
    case "instruction":
      return { role: "developer", type: "input_text" };
    default:
      return message.role satisfies never;
  }
}

/** The input items one message becomes, in order. */
function items(message: ContextMessage, target: Target, calls: ReadonlyMap<CallId, Called>, context: ModelContext): Shaped {
  const shaped = message.parts.map((part): Shaped => {
    switch (part._tag) {
      case "Text": {
        const { role, type } = textAs(message);
        return { json: [{ role, content: [{ type, text: part.text }] }], supplied: [] };
      }
      case "Thinking":
        return leftOut(part, "the Responses API has no thinking block");
      case "ToolCall": {
        const input = toolInputObject(part.call, part.input);
        return {
          json: [{ type: "function_call", call_id: part.call, name: part.tool, arguments: JSON.stringify(input.json) }],
          supplied: input.supplied,
        };
      }
      case "ToolResult":
        return {
          json: [
            {
              type: "function_call_output",
              call_id: part.call,
              output: renderToolResult(part.outcome, calls.get(part.call), context.tools).text,
            },
          ],
          supplied: [],
        };
      case "Unrecognised":
        return sentBack(part, target);
      default:
        return part satisfies never;
    }
  });
  return {
    json: shaped.flatMap((item) => item.json as ReadonlyArray<Json>),
    supplied: shaped.flatMap((item) => item.supplied),
  };
}

function body(target: Target, context: ModelContext): Shaped {
  const calls = callsIn(context);
  const input = context.messages.map((message) => items(message, target, calls, context));
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

function isOutputText(content: Json): content is { readonly type: "output_text"; readonly text: string } {
  return isObject(content) && content["type"] === "output_text" && typeof content["text"] === "string";
}

/** The parts one output item becomes. */
function parts(item: Json): ReadonlyArray<ModelPart> {
  if (!isObject(item)) return [{ _tag: "Unrecognised", received: receivedJson(item) }];
  const { type } = item;
  const content = item["content"];
  if (type === "message" && Array.isArray(content) && content.every(isOutputText))
    return content.map((each): ModelPart => ({ _tag: "Text", text: ModelText.make(each.text) }));
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

/** Requests through the configured `OpenAiClient`, retried while retryable; a failure is the `AiError`. */
export const openAiRequests = (
  retries: Retries = defaultRetries,
): Effect.Effect<ProviderRequest, never, OpenAiClient.OpenAiClient> =>
  Effect.gen(function* () {
    const http = (yield* OpenAiClient.OpenAiClient).client;
    return (target, context, turn) => respondOnce(http, target, context, turn).pipe(withRetries(retries));
  });

export const openAiModelClient = (retries: Retries = defaultRetries) =>
  Layer.effect(ModelClient, openAiRequests(retries).pipe(Effect.map(modelClientOf)));

export const OpenAiModelClient = openAiModelClient();
