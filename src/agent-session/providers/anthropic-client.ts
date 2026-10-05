/**
 * A model client for the Anthropic Messages API, sent through Effect's `AnthropicClient`. It shapes the core's types into
 * the wire format and back.
 *
 * Out: the context's messages, tools, and tool outcomes become Anthropic blocks. A failed tool call
 * becomes an error `tool_result` whose content tells the model what to do next: for a tool that
 * does not exist, the tools that do; for input that does not fit, the tool's input schema and what
 * was given. Where the wire format needs something the context does not say, the client supplies
 * it and logs that it did. Thinking, and blocks it did not recognise, go back to the provider that
 * produced them unchanged and in their place, as the API requires for thinking to stay valid; for
 * any other provider they are left out, and that is logged. The session's settings go in as
 * `anthropic-settings.ts` puts them for the model; what it adjusted is recorded before the request.
 *
 * In: the response streams, and is assembled from its events (`anthropic-stream.ts`); each event
 * and each completed part is passed on as it arrives. The `content` blocks that were completed
 * become the observation's parts in order: a `text` block is
 * `Text`, a `thinking` block is `Thinking` (its text, and the block as received), a `tool_use` block is `ToolCall`
 * (whatever the tool's name), any other block is `Unrecognised` holding the block as received. Everything else in the response is `metadata`. A failure is observed as `ModelFailed`;
 * what was received with it is logged here. The loop annotates these logs with the turn.
 */

import type { BlobId } from "../../agent-machine/blob.ts";
import { knownOf, takesFile } from "../configuration/well-known-models.ts";
import { AnthropicClient } from "@effect/ai-anthropic";
import { Effect, Layer, Ref, Stream } from "effect";
import * as AiError from "effect/ai/AiError";
import type * as HttpClient from "effect/http/HttpClient";
import {
  CallId,
  ModelText,
  StopReason,
  ThinkingText,
  ToolName,
  type TurnId,
} from "../../agent-machine/names.ts";
import type { ModelPart, Observation } from "../../agent-machine/observation.ts";
import {
  type ContextMessage,
  type ContextPart,
  type ModelContext,
  ModelClient,
  type ProviderRequest,
  type Target,
} from "../contracts.ts";
import { logKeys } from "../log-keys.ts";
import { ModelStream, type Streamed } from "../model-stream.ts";
import { defaultRetries, failedPosting, invalidOutput, modelClientOf, type Post, postEvents, type Retries, withRetries } from "../provider-call.ts";
import { reportAdjusted } from "../configuration/settings.ts";
import { anthropicSettle } from "./anthropic-settings.ts";
import { assemble, assembled, cut, nothingYet } from "./anthropic-stream.ts";
import { receivedJson, receivedText } from "../received.ts";
import {
  type Called,
  callsIn,
  endingOf,
  isObject,
  type Json,
  type LeftOutLogged,
  logSupplied,
  type RenderedResult,
  renderToolResult,
  type Shaped,
  sentBack,
  numberAt,
  toolInputObject,
  usageOf,
  fileAs,
  filesIn,
} from "../shaping.ts";

type Outcome = Extract<Observation, { _tag: "ModelResponded" | "ModelFailed" }>;

/**
 * The output limit sent when the session's settings give none, because the Messages API requires
 * one: the model's most output when it is a well-known model, otherwise 128,000.
 */
const defaultMaxTokens = (target: Target): number => knownOf(target)?.output ?? 128_000;

function resultContent(result: RenderedResult): { content: string; is_error?: true } {
  return result.isError ? { content: result.text, is_error: true } : { content: result.text };
}

/** The blocks one part becomes: one, or none when it is left out. */
function blocks(
  part: ContextPart,
  target: Target,
  context: ModelContext,
  calls: ReadonlyMap<CallId, Called>,
  files: ReadonlyMap<BlobId, Uint8Array>,
): Shaped {
  switch (part._tag) {
    case "Text":
    case "Commentary":
      return { json: [{ type: "text", text: part.text }], supplied: [] };
    case "ToolCall": {
      const input = toolInputObject(part.call, part.input);
      return {
        json: [{ type: "tool_use", id: part.call, name: part.tool, input: input.json }],
        supplied: input.supplied,
      };
    }
    case "ToolResult": {
      // A tool's image or PDF goes in the result as an image or document block; anything else as text.
      const rendered = renderToolResult(part.outcome, calls.get(part.call), context.tools);
      const file = rendered.file === undefined ? undefined : fileAs(rendered.file, files, (mediaType) => takesFile(knownOf(target), mediaType));
      if (file?._tag !== "Bytes")
        return {
          json: [{ type: "tool_result", tool_use_id: part.call, ...resultContent(rendered) }],
          supplied: file?.supplied ?? [],
        };
      const source = { type: "base64", media_type: file.blob.mediaType, data: file.base64 };
      return {
        json: [{ type: "tool_result", tool_use_id: part.call, content: [{ type: file.blob.mediaType === "application/pdf" ? "document" : "image", source }] }],
        supplied: [],
      };
    }
    case "Thinking":
    case "Unrecognised":
      // Anthropic reads its own thinking from any of its models, and drops what a model cannot read.
      return sentBack(part, target, "Provider", (text) => ({ json: [{ type: "text", text }], supplied: [] }));
    case "File": {
      // An image goes as an `image` block, a PDF as a `document` block, both in base64.
      const file = fileAs(part.blob, files, (mediaType) => takesFile(knownOf(target), mediaType));
      if (file._tag === "Text") return { json: [{ type: "text", text: file.text }], supplied: file.supplied };
      const source = { type: "base64", media_type: file.blob.mediaType, data: file.base64 };
      return { json: [{ type: file.blob.mediaType === "application/pdf" ? "document" : "image", source }], supplied: [] };
    }
    default:
      return part satisfies never;
  }
}

/**
 * The Messages API role for a message. An instruction is a mid-conversation `system` message, which
 * not every model accepts; a model that does not fails the request with the provider's error. The
 * API rejects one as the first message, so instructions before the first user or assistant
 * message are sent in the top-level `system` instead (`body`).
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

/**
 * The top-level `system`: the system prompt, then the text of the instructions that open the
 * conversation, each a text block; the prompt alone as a string when no instruction opens it.
 */
function systemOf(context: ModelContext, opening: ReadonlyArray<ContextMessage>): Json | undefined {
  const texts = [
    ...(context.system === undefined ? [] : [context.system]),
    ...opening.flatMap((message) => message.parts.flatMap((part) => (part._tag === "Text" ? [part.text] : []))),
  ];
  if (opening.length === 0) return context.system;
  return texts.length === 0 ? undefined : texts.map((text) => ({ type: "text", text }));
}

export function body(target: Target, context: ModelContext, files: ReadonlyMap<BlobId, Uint8Array> = new Map()): Shaped {
  const calls = callsIn(context);
  const first = context.messages.findIndex((message) => message.role !== "instruction");
  const opening = context.messages.slice(0, first === -1 ? context.messages.length : first);
  const system = systemOf(context, opening);
  const messages = context.messages.slice(opening.length).flatMap((message) => {
    const shaped = message.parts.map((part) => blocks(part, target, context, calls, files));
    const content = shaped.flatMap((each) => each.json as ReadonlyArray<Json>);
    const supplied = shaped.flatMap((each) => each.supplied);
    // A message whose every part was left out is not sent: the API rejects empty content.
    return content.length === 0 ? [{ json: [], supplied }] : [{ json: [{ role: role(message), content }], supplied }];
  });
  return {
    json: {
      model: target.model,
      max_tokens: target.settings?.maxOutputTokens ?? defaultMaxTokens(target),
      ...(system === undefined ? {} : { system }),
      ...(context.tools.length === 0
        ? {}
        : {
            tools: context.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.input,
            })),
          }),
      messages: messages.flatMap((message) => message.json as ReadonlyArray<Json>),
    },
    supplied: [
      ...(target.settings?.maxOutputTokens === undefined
        ? [
            {
              level: "info" as const,
              event: logKeys.anthropic.maxTokensSupplied,
              details: { message: `no max_tokens parameter supplied, defaulting to ${defaultMaxTokens(target)}` },
            },
          ]
        : []),
      ...messages.flatMap((message) => message.supplied),
    ],
  };
}

/** The text an event adds to a text or thinking block, as it arrives. */
function deltaIn(event: Json): Streamed | undefined {
  if (!isObject(event) || event["type"] !== "content_block_delta") return undefined;
  const delta = event["delta"];
  if (!isObject(delta ?? null)) return undefined;
  const { type, text, thinking } = delta as { readonly type?: Json; readonly text?: Json; readonly thinking?: Json };
  if (type === "text_delta" && typeof text === "string") return { _tag: "Delta", kind: "Text", text };
  if (type === "thinking_delta" && typeof thinking === "string") return { _tag: "Delta", kind: "Thinking", text: thinking };
  return undefined;
}

function part(received: Json): ModelPart {
  if (isObject(received)) {
    const { type, text, id, name, input } = received;
    if (type === "text" && typeof text === "string") return { _tag: "Text", text: ModelText.make(text) };
    const { thinking } = received;
    if (type === "thinking" && typeof thinking === "string")
      return { _tag: "Thinking", text: ThinkingText.make(thinking), received: receivedJson(received) };
    if (type === "tool_use" && typeof id === "string" && typeof name === "string" && input !== undefined)
      return {
        _tag: "ToolCall",
        call: CallId.make(id),
        tool: ToolName.make(name),
        // An input that is not an object is the text a stream gave that was not JSON (`anthropic-stream.ts` `unparsed`).
        input: typeof input === "string" ? receivedText(input) : receivedJson(input),
      };
  }
  return { _tag: "Unrecognised", received: receivedJson(received) };
}

const caller = { module: "AnthropicModelClient", method: "respond" };

/**
 * The response's usage in the core's terms. The Messages API counts the input it did not read from
 * or write to the cache as `input_tokens`, so the input carried is the three together.
 */
const usageIn = (reported: Json | undefined) => {
  const uncached = numberAt(reported, "input_tokens");
  const cacheRead = numberAt(reported, "cache_read_input_tokens");
  const cacheWrite = numberAt(reported, "cache_creation_input_tokens");
  const usage = usageOf({
    input: uncached === undefined ? undefined : uncached + (cacheRead ?? 0) + (cacheWrite ?? 0),
    output: numberAt(reported, "output_tokens"),
    thinking: numberAt(reported, "output_tokens_details", "thinking_tokens"),
    cacheRead,
    cacheWrite,
    cacheWrite1h: numberAt(reported, "cache_creation", "ephemeral_1h_input_tokens"),
  });
  return usage === undefined ? {} : { usage };
};

/** Anthropic's `stop_reason` values. */
export const anthropicEndings = new Map([
  ["end_turn", "Complete"],
  ["tool_use", "Complete"],
  ["max_tokens", "CutShort"],
  ["stop_sequence", "Complete"],
  ["pause_turn", "Unfinished"],
  ["model_context_window_exceeded", "CutShort"],
  ["refusal", "Refused"],
] as const);

/** The HTTP status that goes with each error type the API reports, in a stream as in a response. */
const statusOf = new Map([
  ["invalid_request_error", 400],
  ["authentication_error", 401],
  ["permission_error", 403],
  ["not_found_error", 404],
  ["request_too_large", 413],
  ["rate_limit_error", 429],
  ["api_error", 500],
  ["overloaded_error", 529],
]);

/** An error the stream reported after it started, as the `AiError` its type's HTTP status gives. */
const failedInStream = (failed: { readonly type: string; readonly message: string }): AiError.AiError => {
  const status = statusOf.get(failed.type);
  const description = `The stream reported ${failed.type}: ${failed.message}`;
  return AiError.make({
    ...caller,
    reason:
      status === undefined
        ? new AiError.UnknownError({ description })
        : AiError.reasonFromHttpStatus({ status, body: JSON.stringify(failed), description }),
  });
};

/**
 * One request: the observation it produced, or the `AiError` it failed with. The response streams:
 * each event is passed on as it arrives and each part as it is completed (`ModelStream`), and the
 * observation is the message assembled when the stream ends, with the parts that were completed.
 */
const respondOnce = (
  http: HttpClient.HttpClient,
  post: Post,
  target: Target,
  turn: TurnId,
): Effect.Effect<Extract<Outcome, { _tag: "ModelResponded" }>, AiError.AiError> =>
  Effect.gen(function* () {
    const passOn = yield* ModelStream;
    const arrived = yield* postEvents(http, caller, post).pipe(
      Stream.runFoldEffect(
        () => nothingYet,
        (state, event) =>
          Effect.gen(function* () {
            yield* passOn({ _tag: "Chunk", chunk: receivedJson(event) });
            const added = deltaIn(event);
            if (added !== undefined) yield* passOn(added);
            const next = assemble(state, event);
            if (next.failed !== undefined) return yield* failedInStream(next.failed);
            if (next.notApplied !== undefined)
              yield* Effect.logWarning(logKeys.anthropic.deltaNotApplied, { delta: next.notApplied });
            if (next.unparsed !== undefined)
              yield* Effect.logWarning(logKeys.anthropic.toolInputUnparsed, {
                call: next.unparsed.id,
                tool: next.unparsed.name,
                input: next.unparsed.input,
                used: "the input as text, which the tool rejects",
              });
            if (next.completed !== undefined) yield* passOn({ _tag: "Part", part: part(next.completed) });
            return next.state;
          }),
      ),
    );
    const response = assembled(arrived);
    if (response === undefined) return yield* invalidOutput(caller, "The stream ended before a message started");
    if (!arrived.stopped) return yield* invalidOutput(caller, "The stream ended without message_stop: the message did not arrive whole");
    const notRecorded = cut(arrived);
    if (notRecorded.length > 0) yield* Effect.logInfo(logKeys.provider.partCut, { parts: notRecorded });
    const { content, stop_reason, ...metadata } = response;
    return {
      _tag: "ModelResponded" as const,
      turn,
      provider: target.provider,
      model: target.model,
      parts: (content as ReadonlyArray<Json>).map(part),
      stop: StopReason.make(typeof stop_reason === "string" ? stop_reason : JSON.stringify(stop_reason ?? null)),
      ending: endingOf(anthropicEndings, stop_reason),
      ...usageIn(metadata["usage"]),
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
    const leftOutLogged = yield* Ref.make<LeftOutLogged>(new Set());
    return (target, context, turn) => {
      const settled = anthropicSettle(target);
      return filesIn(context).pipe(
        Effect.flatMap((files) => {
        const sent = body(target, context, files);
        const post: Post = {
          path: "/v1/messages",
          headers: settled.headers,
          body: { ...(sent.json as Record<string, Json>), ...settled.fields, stream: true },
        };
        return reportAdjusted(turn, target, settled).pipe(
          Effect.andThen(logSupplied(sent.supplied, target, turn, leftOutLogged)),
          Effect.andThen(respondOnce(http, post, target, turn).pipe(withRetries(retries), failedPosting(post))),
        );
        }),
      );
    };
  });

export const anthropicModelClient = (retries: Retries = defaultRetries) =>
  Layer.effect(ModelClient, anthropicRequests(retries).pipe(Effect.map(modelClientOf)));

export const AnthropicModelClient = anthropicModelClient();
