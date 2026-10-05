/**
 * A model client for the OpenAI Responses API, sent through Effect's `OpenAiClient`. xAI accepts the
 * same requests (`xai-client.ts`).
 *
 * Request:
 * - The system text is `instructions`.
 * - The context's messages become input items: text as `input_text` or `output_text` messages, a
 *   tool call as a `function_call` item, and a tool outcome as a `function_call_output` item
 *   carrying the text that the model is sent.
 * - The catalog is sent as `function` tools.
 * - Thinking (a `reasoning` item) and an item that the client did not recognise go back to the
 *   provider that produced them, unchanged and in their place. They are omitted for any other
 *   provider, and the omission is logged.
 * - The session's settings go in as `reasoning` (`openai-settings.ts`); what that adjusted is
 *   recorded before the request.
 *
 * Response:
 * - The response streams. Each event, the text that it adds to an answer, commentary or reasoning
 *   summary, and each completed item are passed on as they arrive. The stream's last event carries
 *   the whole response.
 * - The completed `output` items become the observation's parts, in order:
 *   - a `message` whose content is all `output_text`: a `Text` for each, or a `Commentary` for each
 *     when its `phase` is `commentary` (sent back with that phase);
 *   - a `function_call`: a `ToolCall`, whatever the tool's name, with its arguments kept as the text
 *     received;
 *   - a `reasoning` item: `Thinking` (its summary as text, and the item as received);
 *   - any other item, including a `message` with other content: `Unrecognised`, whole, so that it
 *     can be sent back as it came.
 * - The stop is the response's `status`, with the reason when it is `incomplete`. Everything else in
 *   the response is `metadata`.
 * - A request that still fails after retries is observed as `ModelFailed`.
 */

import type { BlobId } from "../../agent-machine/blob.ts";
import { knownOf, takesFile } from "../configuration/well-known-models.ts";
import { OpenAiClient } from "@effect/ai-openai";
import { Effect, HashMap, Layer, Option, Ref, type Schema, Stream } from "effect";
import * as AiError from "effect/ai/AiError";
import type * as HttpClient from "effect/http/HttpClient";
import { CallId, ModelText, StopReason, ThinkingText, ToolName, type TurnId } from "../../agent-machine/names.ts";
import type { ModelPart, Observation } from "../../agent-machine/observation.ts";
import { type ContextMessage, type ModelContext, ModelClient, type ProviderRequest, type Target } from "../contracts.ts";
import {
  defaultRetries,
  failedPosting,
  invalidOutput,
  modelClientOf,
  type Post,
  postEvents,
  type Retries,
  withRetries,
} from "../provider-call.ts";
import { logKeys } from "../log-keys.ts";
import { ModelStream } from "../model-stream.ts";
import { reportAdjusted, type Settled } from "../configuration/settings.ts";
import { openAiSettle } from "./openai-settings.ts";
import { receivedJson, receivedJsonText } from "../received.ts";
import {
  type Called,
  callsIn,
  endingOf,
  isObject,
  type Json,
  type OmittedLogged,
  logSupplied,
  renderToolResult,
  type Shaped,
  sentBack,
  numberAt,
  toolInputObject,
  usageOf,
  fileAs,
  filesIn,
} from "../shaping.ts";

type Responded = Extract<Observation, { _tag: "ModelResponded" }>;

const caller = { module: "OpenAiResponsesModelClient", method: "respond" };

/** Returns the Responses role for a message and the type of its text. An instruction is a `developer` message. */
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

/** Returns the input items that one message becomes, in order. */
function items(
  message: ContextMessage,
  target: Target,
  calls: ReadonlyMap<CallId, Called>,
  context: ModelContext,
  files: ReadonlyMap<BlobId, Uint8Array>,
): Shaped {
  const shaped = message.parts.map((part): Shaped => {
    switch (part._tag) {
      case "Text": {
        const { role, type } = textAs(message);
        return { json: [{ role, content: [{ type, text: part.text }] }], supplied: [] };
      }
      case "Commentary":
        return {
          json: [{ role: "assistant", phase: "commentary", content: [{ type: "output_text", text: part.text }] }],
          supplied: [],
        };
      case "ToolCall": {
        const input = toolInputObject(part.call, part.input);
        return {
          json: [{ type: "function_call", call_id: part.call, name: part.tool, arguments: JSON.stringify(input.json) }],
          supplied: input.supplied,
        };
      }
      case "ToolResult": {
        // A tool's image or PDF goes in the output as an input_image or input_file; anything else as text.
        const rendered = renderToolResult(part.outcome, calls.get(part.call), context.tools);
        const file = rendered.file === undefined ? undefined : fileAs(rendered.file, files, (mediaType) => takesFile(knownOf(target), mediaType));
        const output =
          file?._tag === "Bytes"
            ? [
                file.blob.mediaType === "application/pdf"
                  ? { type: "input_file", filename: `${file.blob.id}.pdf`, file_data: file.dataUrl }
                  : { type: "input_image", image_url: file.dataUrl },
              ]
            : rendered.text;
        return { json: [{ type: "function_call_output", call_id: part.call, output }], supplied: file?._tag === "Text" ? file.supplied : [] };
      }
      case "Thinking":
      case "Unrecognised":
        return sentBack(part, target, "Provider", (text) => ({ json: [{ role: "assistant", content: [{ type: "output_text", text }] }], supplied: [] }));
      case "File": {
        // An image goes as `input_image`, a PDF as `input_file`, each as a data URL, in a message of its own.
        const { role, type } = textAs(message);
        const file = fileAs(part.blob, files, (mediaType) => takesFile(knownOf(target), mediaType));
        if (file._tag === "Text") return { json: [{ role, content: [{ type, text: file.text }] }], supplied: file.supplied };
        const content =
          file.blob.mediaType === "application/pdf"
            ? { type: "input_file", filename: file.blob.name ?? `${file.blob.id}.pdf`, file_data: file.dataUrl }
            : { type: "input_image", image_url: file.dataUrl };
        return { json: [{ role, content: [content] }], supplied: [] };
      }
      default:
        return part satisfies never;
    }
  });
  return {
    json: shaped.flatMap((item) => item.json as ReadonlyArray<Json>),
    supplied: shaped.flatMap((item) => item.supplied),
  };
}

/** Returns a request's body for `context`, without settings, and what was supplied or omitted in shaping it. */
export function body(target: Target, context: ModelContext, files: ReadonlyMap<BlobId, Uint8Array> = new Map()): Shaped {
  const calls = callsIn(context);
  const input = context.messages.map((message) => items(message, target, calls, context, files));
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

/** Returns the text of a reasoning item's summary: its parts separated by blank lines; empty when it has none. */
function summaryOf(item: Schema.JsonObject): ThinkingText {
  const summary = item["summary"];
  const texts = Array.isArray(summary)
    ? summary.flatMap((each) => (isObject(each) && typeof each["text"] === "string" ? [each["text"]] : []))
    : [];
  return ThinkingText.make(texts.join("\n\n"));
}

/** Returns the parts that one output item becomes. */
function parts(item: Json): ReadonlyArray<ModelPart> {
  if (!isObject(item)) return [{ _tag: "Unrecognised", received: receivedJson(item) }];
  const { type } = item;
  const content = item["content"];
  if (type === "message" && Array.isArray(content) && content.every(isOutputText))
    return content.map((each): ModelPart => ({
      _tag: item["phase"] === "commentary" ? "Commentary" : "Text",
      text: ModelText.make(each.text),
    }));
  const { call_id, name, arguments: args } = item;
  if (type === "function_call" && typeof call_id === "string" && typeof name === "string" && typeof args === "string")
    return [{ _tag: "ToolCall", call: CallId.make(call_id), tool: ToolName.make(name), input: receivedJsonText(args) }];
  if (type === "reasoning") return [{ _tag: "Thinking", text: summaryOf(item), received: receivedJson(item) }];
  return [{ _tag: "Unrecognised", received: receivedJson(item) }];
}

function stopOf(status: Json | undefined, incomplete: Json | undefined): StopReason {
  const reason = isObject(incomplete ?? null) ? (incomplete as { reason?: Json }).reason : undefined;
  const text = typeof status === "string" ? status : JSON.stringify(status ?? null);
  return StopReason.make(typeof reason === "string" ? `${text}: ${reason}` : text);
}

/** Returns a response's `status`, with the reason in `incomplete_details` when the response is incomplete. */
const endings = new Map([
  ["completed", "Complete"],
  ["incomplete: max_output_tokens", "CutShort"],
  ["incomplete: content_filter", "Refused"],
] as const);

/** Whether an output item was still arriving when its response ended. */
const stillArriving = (item: Json): boolean =>
  isObject(item) && (item["status"] === "incomplete" || item["status"] === "in_progress");

/** Returns the HTTP status that a stream's error code corresponds to, when it corresponds to one. */
const statusOfCode = (code: Json | undefined): number | undefined => {
  if (code === "rate_limit_exceeded") return 429;
  if (code === "server_error") return 500;
  return undefined;
};

/** Returns an error that the stream reported, in a `response.failed` event's response or in an `error` event. */
const failedInStream = (event: Schema.JsonObject): AiError.AiError => {
  const response = event["response"];
  const error = response !== undefined && isObject(response) ? response["error"] : event;
  const code = error !== undefined && error !== null && isObject(error) ? error["code"] : undefined;
  const description = `The stream reported a failure: ${JSON.stringify(error ?? event)}`;
  const status = statusOfCode(code);
  return AiError.make({
    ...caller,
    reason:
      status === undefined
        ? new AiError.UnknownError({ description })
        : AiError.reasonFromHttpStatus({ status, body: JSON.stringify(error ?? event), description }),
  });
};

/** Returns a Responses API usage in the core's terms. Its `input_tokens` include those read from the cache. */
export const responsesUsageIn = (reported: Json | undefined) => {
  const usage = usageOf({
    input: numberAt(reported, "input_tokens"),
    output: numberAt(reported, "output_tokens"),
    thinking: numberAt(reported, "output_tokens_details", "reasoning_tokens"),
    cacheRead: numberAt(reported, "input_tokens_details", "cached_tokens"),
  });
  return usage === undefined ? {} : { usage };
};

/**
 * What a response's stream has delivered so far: the response that its last event carried, the text
 * that each output item's deltas have built, and the last summary part that each reasoning item's
 * deltas were in.
 */
interface Reading {
  readonly response: Json | undefined;
  readonly kinds: HashMap.HashMap<number, "Text" | "Commentary">;
  readonly summaries: HashMap.HashMap<number, number>;
}

/**
 * Makes one request. The response streams: each event is passed on as it arrives, and each output
 * item's parts when the item is done (`ModelStream`). The observation is made from the response that
 * the stream's last event carries.
 */
const respondOnce = (
  http: HttpClient.HttpClient,
  post: Post,
  target: Target,
  turn: TurnId,
): Effect.Effect<Responded, AiError.AiError> =>
  Effect.gen(function* () {
    const passOn = yield* ModelStream;
    const ended = yield* postEvents(http, caller, post).pipe(
      Stream.runFoldEffect(
        (): Reading => ({ response: undefined, kinds: HashMap.empty(), summaries: HashMap.empty() }),
        (reading, event) =>
          Effect.gen(function* () {
            yield* passOn({ _tag: "Chunk", chunk: receivedJson(event) });
            if (!isObject(event)) return reading;
            const at = typeof event["output_index"] === "number" ? event["output_index"] : -1;
            switch (typeof event["type"] === "string" ? event["type"] : "") {
              case "response.output_item.added": {
                const item = event["item"];
                if (isObject(item ?? null) && (item as Schema.JsonObject)["type"] === "message")
                  return { ...reading, kinds: HashMap.set(reading.kinds, at, (item as Schema.JsonObject)["phase"] === "commentary" ? "Commentary" : "Text") };
                return reading;
              }
              case "response.output_text.delta":
                if (typeof event["delta"] === "string")
                  yield* passOn({ _tag: "Delta", kind: Option.getOrElse(HashMap.get(reading.kinds, at), () => "Text" as const), text: event["delta"] });
                return reading;
              case "response.reasoning_summary_text.delta": {
                if (typeof event["delta"] !== "string") return reading;
                // The summary's parts are joined by a blank line in the thinking's text, and so in its deltas.
                const index = typeof event["summary_index"] === "number" ? event["summary_index"] : 0;
                const last = HashMap.get(reading.summaries, at);
                if (Option.isSome(last) && index > last.value) yield* passOn({ _tag: "Delta", kind: "Thinking", text: "\n\n" });
                yield* passOn({ _tag: "Delta", kind: "Thinking", text: event["delta"] });
                return { ...reading, summaries: HashMap.set(reading.summaries, at, index) };
              }
              case "response.output_item.done": {
                const item = event["item"] ?? null;
                if (!stillArriving(item))
                  yield* Effect.forEach(parts(item), (part) => passOn({ _tag: "Part", part }), { discard: true });
                return reading;
              }
              case "response.completed":
              case "response.incomplete":
                return { ...reading, response: event["response"] };
              case "response.failed":
              case "error":
                return yield* failedInStream(event);
              default:
                return reading;
            }
          }),
      ),
      Effect.map((reading) => reading.response),
    );
    if (ended === undefined || !isObject(ended) || !Array.isArray(ended["output"]))
      return yield* invalidOutput(caller, `The stream ended without a response: ${JSON.stringify(ended ?? null)}`);
    const { output, status, incomplete_details, ...metadata } = ended;
    // An item still arriving when the response ended (it was cut short) is not included.
    const items = output as ReadonlyArray<Json>;
    const whole = items.filter((item) => !stillArriving(item));
    const cutItems = items.filter(stillArriving);
    if (cutItems.length > 0)
      yield* Effect.logInfo(logKeys.provider.partCut, { parts: cutItems.map((item) => (isObject(item) ? item["type"] : null)) });
    const responded = whole.flatMap(parts);
    const stop = stopOf(status, incomplete_details);
    return {
      _tag: "ModelResponded" as const,
      turn,
      provider: target.provider,
      model: target.model,
      parts: responded,
      stop,
      ending: endingOf(endings, stop),
      ...responsesUsageIn(metadata["usage"]),
      metadata: receivedJson(metadata),
    };
  });

/**
 * Makes requests through the configured `OpenAiClient`, retried while the failure is retryable; a
 * failure is the `AiError`. `settle` puts the session's settings for the target's model into the
 * request, because another provider that accepts Responses requests maps the settings differently
 * (`xai-settings.ts`).
 */
export const openAiRequests = (
  retries: Retries = defaultRetries,
  settle: (target: Target) => Settled = openAiSettle,
): Effect.Effect<ProviderRequest, never, OpenAiClient.OpenAiClient> =>
  Effect.gen(function* () {
    const http = (yield* OpenAiClient.OpenAiClient).client;
    const omittedLogged = yield* Ref.make<OmittedLogged>(new Set());
    return (target, context, turn) => {
      const settled = settle(target);
      return filesIn(context).pipe(
        Effect.flatMap((files) => {
        const sent = body(target, context, files);
        const post: Post = {
          path: "/responses",
          headers: settled.headers,
          body: { ...(sent.json as Record<string, Json>), ...settled.fields, stream: true },
        };
        return reportAdjusted(turn, target, settled).pipe(
          Effect.andThen(logSupplied(sent.supplied, target, turn, omittedLogged)),
          Effect.andThen(respondOnce(http, post, target, turn).pipe(withRetries(retries), failedPosting(post))),
        );
        }),
      );
    };
  });

export const openAiModelClient = (retries: Retries = defaultRetries) =>
  Layer.effect(ModelClient, openAiRequests(retries).pipe(Effect.map(modelClientOf)));

export const OpenAiModelClient = openAiModelClient();
