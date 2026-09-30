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
 * `anthropic-settings.ts` puts them for the model; what it enforced is recorded before the request.
 *
 * In: the response streams, and is assembled from its events (`anthropic-stream.ts`); each event
 * and each completed part is passed on as it arrives. The `content` blocks that were completed
 * become the observation's parts in order: a `text` block is
 * `Text`, a `thinking` block is `Thinking` (its text, and the block as received), a `tool_use` block is `ToolCall`
 * (whatever the tool's name), any other block is `Unrecognised` holding the block as received. Everything else in the response is `metadata`. A failure is observed as `ModelFailed`;
 * what was received with it is logged here. The loop annotates these logs with the turn.
 */

import { AnthropicClient } from "@effect/ai-anthropic";
import { Effect, Layer, Stream } from "effect";
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
import { ModelStream } from "../model-stream.ts";
import { defaultRetries, failedPosting, invalidOutput, modelClientOf, type Post, postEvents, type Retries, withRetries } from "../provider-call.ts";
import { reportEnforced } from "../settings.ts";
import { anthropicSettings } from "./anthropic-settings.ts";
import { assemble, assembled, cut, nothingYet } from "./anthropic-stream.ts";
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
  sentBack,
  toolInputObject,
} from "../shaping.ts";

type Outcome = Extract<Observation, { _tag: "ModelResponded" | "ModelFailed" }>;

/** The output limit sent when the session's settings give none; the Messages API requires one. */
const defaultMaxTokens = 32_768;

function resultContent(result: RenderedResult): { content: string; is_error?: true } {
  return result.isError ? { content: result.text, is_error: true } : { content: result.text };
}

/** The blocks one part becomes: one, or none when it is left out. */
function blocks(part: ContextPart, target: Target, context: ModelContext, calls: ReadonlyMap<CallId, Called>): Shaped {
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
    case "ToolResult":
      return {
        json: [
          {
            type: "tool_result",
            tool_use_id: part.call,
            ...resultContent(renderToolResult(part.outcome, calls.get(part.call), context.tools)),
          },
        ],
        supplied: [],
      };
    case "Thinking":
    case "Unrecognised":
      return sentBack(part, target);
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
  const messages = context.messages.flatMap((message) => {
    const shaped = message.parts.map((part) => blocks(part, target, context, calls));
    const content = shaped.flatMap((each) => each.json as ReadonlyArray<Json>);
    const supplied = shaped.flatMap((each) => each.supplied);
    // A message whose every part was left out is not sent: the API rejects empty content.
    return content.length === 0 ? [{ json: [], supplied }] : [{ json: [{ role: role(message), content }], supplied }];
  });
  return {
    json: {
      model: target.model,
      max_tokens: target.settings?.maxOutputTokens ?? defaultMaxTokens,
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
      messages: messages.flatMap((message) => message.json as ReadonlyArray<Json>),
    },
    supplied: [
      ...(target.settings?.maxOutputTokens === undefined
        ? [
            {
              level: "info" as const,
              event: logKeys.anthropic.maxTokensSupplied,
              details: {
                max_tokens: defaultMaxTokens,
                reason: "the Messages API requires max_tokens and the session's settings give no output limit",
              },
            },
          ]
        : []),
      ...messages.flatMap((message) => message.supplied),
    ],
  };
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
            const next = assemble(state, event);
            if (next.failed !== undefined) return yield* failedInStream(next.failed);
            if (next.notApplied !== undefined)
              yield* Effect.logWarning(logKeys.anthropic.deltaNotApplied, { delta: next.notApplied });
            if (next.completed !== undefined) yield* passOn({ _tag: "Part", part: part(next.completed) });
            return next.state;
          }),
      ),
    );
    const response = assembled(arrived);
    if (response === undefined) return yield* invalidOutput(caller, "The stream ended before a message started");
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
    return (target, context, turn) => {
      const settled = anthropicSettings(target.model, target.settings);
      const sent = body(target, context);
      const post: Post = {
        path: "/v1/messages",
        headers: settled.headers,
        body: { ...(sent.json as Record<string, Json>), ...settled.fields, stream: true },
      };
      return reportEnforced(turn, target, settled).pipe(
        Effect.andThen(logSupplied(sent.supplied)),
        Effect.andThen(respondOnce(http, post, target, turn).pipe(withRetries(retries), failedPosting(post))),
      );
    };
  });

export const anthropicModelClient = (retries: Retries = defaultRetries) =>
  Layer.effect(ModelClient, anthropicRequests(retries).pipe(Effect.map(modelClientOf)));

export const AnthropicModelClient = anthropicModelClient();
