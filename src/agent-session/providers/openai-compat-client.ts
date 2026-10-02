/**
 * A model client for OpenAI-compatible Chat Completions APIs, sent through Effect's
 * `OpenAiClient` from `@effect/ai-openai-compat`. The provider is whichever the client's `apiUrl`
 * points at.
 *
 * Out: the system text is a `system` message; the context's messages become chat messages: text
 * as `text` content parts, the model's tool calls as an assistant message's `tool_calls`, each tool
 * outcome as a `tool` message carrying the text the model is sent. The catalog is sent as
 * `function` tools. What an earlier response from this provider held besides its text and calls
 * goes back as it came: its other fields (`reasoning_content`, ...) on its message, and a call's
 * other fields on the call; another provider's are left out, and logged. Of the session's settings
 * the reasoning effort is sent, as
 * `reasoning_effort` (`openai-compat-settings.ts`); each other one asked for is recorded as adjusted.
 *
 * In: the response streams, and its chunks build the first choice's message (`respondOnce`). The
 * message becomes the observation's parts in order: its thinking (`reasoning_content`, `reasoning`)
 * is `Thinking`, its `content` is `Text` (a list of chunks, Mistral's, is a part per chunk, its
 * thinking `Thinking`), each of its `tool_calls` is `ToolCall` (whatever the
 * tool's name), its arguments kept as the text received, and a call's other fields (Gemini's
 * `extra_content`) are `Unrecognised` holding the call; any other field of the message
 * (`refusal`, ...) is `Unrecognised`, holding that field. As the chunks arrive, the text each adds
 * to the thinking and to the answer is passed on. The stop is the choice's `finish_reason`; the
 * usage is the last a chunk held (`usageIn`); everything else the chunks held is `metadata`. A
 * request that fails, after retries, is observed as `ModelFailed`.
 */

import type { BlobId } from "../../agent-machine/blob.ts";
import { knownOf, takesFile } from "../configuration/well-known-models.ts";
import { OpenAiClient } from "@effect/ai-openai-compat";
import { Effect, Layer, Ref, type Schema, Stream } from "effect";
import type * as AiError from "effect/ai/AiError";
import type * as HttpClient from "effect/http/HttpClient";
import { CallId, ModelText, StopReason, ThinkingText, ToolName, type TurnId } from "../../agent-machine/names.ts";
import type { ModelPart, Observation } from "../../agent-machine/observation.ts";
import { type ContextMessage, type ModelContext, ModelClient, type ProviderRequest, type Target } from "../contracts.ts";
import { defaultRetries, failedPosting, invalidOutput, modelClientOf, type Post, postEventsOrWhole, type Retries, withRetries } from "../provider-call.ts";
import { ModelStream, type Streamed } from "../model-stream.ts";
import { reportAdjusted } from "../configuration/settings.ts";
import { openAiCompatSettle } from "./openai-compat-settings.ts";
import { receivedJson, receivedJsonText } from "../received.ts";
import {
  type Called,
  callsIn,
  endingOf,
  isObject,
  type Json,
  leftOut,
  type LeftOutLogged,
  logSupplied,
  renderToolResult,
  sentBack,
  type Shaped,
  numberAt,
  toolInputObject,
  usageOf,
  fileAs,
  filesIn,
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
function chatMessages(
  message: ContextMessage,
  target: Target,
  calls: ReadonlyMap<CallId, Called>,
  context: ModelContext,
  files: ReadonlyMap<BlobId, Uint8Array>,
): Shaped {
  // A file goes in the message's content: an image as `image_url` with a data URL; anything else as its pointer.
  const filed = message.parts.flatMap((part) =>
    part._tag === "File" ? [fileAs(part.blob, files, (mediaType) => mediaType.startsWith("image/") && takesFile(knownOf(target), mediaType))] : [],
  );
  const toolCalls = message.parts.flatMap((part) =>
    part._tag === "ToolCall" ? [{ call: part.call, tool: part.tool, input: toolInputObject(part.call, part.input) }] : [],
  );
  const kept = keptFields(
    message,
    target,
    toolCalls.map((call) => ({ id: call.call, type: "function", function: { name: call.tool, arguments: JSON.stringify(call.input.json) } })),
  );
  // The content in the order of the parts: text, and the chunks kept from the response (Mistral's thinking).
  const text = [
    ...message.parts.flatMap((part, at) => (part._tag === "Text" || part._tag === "Commentary" ? [{ type: "text", text: part.text }] : (kept.content.get(at) ?? []))),
    ...filed.map((file) => (file._tag === "Text" ? { type: "text", text: file.text } : { type: "image_url", image_url: { url: file.dataUrl } })),
  ];
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
    text.length === 0 && kept.calls.length === 0 && Object.keys(kept.fields).length === 0
      ? []
      : [
          {
            role: role(message),
            content: text.length === 0 ? null : text,
            ...kept.fields,
            ...(kept.calls.length === 0 ? {} : { tool_calls: kept.calls }),
          },
        ];
  return {
    json: [...results, ...own],
    supplied: [...toolCalls.flatMap((call) => call.input.supplied), ...kept.supplied, ...filed.flatMap((file) => (file._tag === "Text" ? file.supplied : []))],
  };
}

/**
 * What an earlier response held besides its text and its calls, put back as it came
 * (`sentBack`): each of the message's other fields (`reasoning_content`, ...); the chunks of its
 * content that are not text (Mistral's thinking), by the part that holds them; and each call's
 * other fields (Gemini's `extra_content`) on the call with its id.
 */
function keptFields(
  message: ContextMessage,
  target: Target,
  calls: ReadonlyArray<Readonly<Record<string, Json>>>,
): {
  readonly fields: Readonly<Record<string, Json>>;
  readonly content: ReadonlyMap<number, ReadonlyArray<Json>>;
  readonly calls: ReadonlyArray<Readonly<Record<string, Json>>>;
  readonly supplied: Shaped["supplied"];
} {
  const fields: Record<string, Json> = {};
  const content = new Map<number, ReadonlyArray<Json>>();
  const extras = new Map<string, Readonly<Record<string, Json>>>();
  const supplied = message.parts.flatMap((part, at) => {
    if (part._tag !== "Thinking" && part._tag !== "Unrecognised") return [];
    const back = sentBack(part, target);
    const [piece] = back.json as ReadonlyArray<Json>;
    if (piece === undefined) return back.supplied;
    if (!isObject(piece)) return leftOut(part, "it is not a message's fields").supplied;
    return Object.entries(piece).flatMap(([field, value]) => {
      if (field === "content" && Array.isArray(value)) {
        content.set(at, value);
        return [];
      }
      if (field !== "tool_calls" || !Array.isArray(value)) {
        fields[field] = value as Json;
        return [];
      }
      return (value as ReadonlyArray<Json>).flatMap((call) => {
        const id = isObject(call) ? call["id"] : undefined;
        if (typeof id !== "string" || !calls.some((own) => own["id"] === id)) return leftOut(part, "its call is not in the message").supplied;
        extras.set(id, call as Readonly<Record<string, Json>>);
        return [];
      });
    });
  });
  return { fields, content, calls: calls.map((own) => ({ ...extras.get(own["id"] as string), ...own })), supplied };
}

function body(target: Target, context: ModelContext, files: ReadonlyMap<BlobId, Uint8Array> = new Map()): Shaped {
  const calls = callsIn(context);
  const messages = context.messages.map((message) => chatMessages(message, target, calls, context, files));
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

/**
 * The parts one tool call becomes: `ToolCall`, and when the call holds other fields than its `id`,
 * `type` and `function` (Gemini's `extra_content`), `Unrecognised` holding the call as received, so
 * that they go back with it. A call with no id or name is `Unrecognised`.
 */
function callParts(call: Json): ReadonlyArray<ModelPart> {
  const received: ModelPart = { _tag: "Unrecognised", received: receivedJson({ tool_calls: [call] }) };
  if (isObject(call) && typeof call["id"] === "string" && isObject(call["function"] ?? null)) {
    const { id, type: _type, function: fn, ...other } = call;
    const { name, arguments: args } = fn as { readonly name?: Json; readonly arguments?: Json };
    if (typeof name === "string" && typeof args === "string")
      return [
        { _tag: "ToolCall", call: CallId.make(id as string), tool: ToolName.make(name), input: receivedJsonText(args) },
        ...(Object.keys(other).length === 0 ? [] : [received]),
      ];
  }
  return [received];
}

/** The message fields in which Chat Completions servers return readable thinking. */
const thinkingFields: ReadonlyArray<string> = ["reasoning_content", "reasoning"];

/**
 * The parts the choice's message becomes: its thinking (a text field in `thinkingFields`) as
 * `Thinking`, holding the field as received; its `content` as `Text`; any other field as
 * `Unrecognised`, unless it holds nothing (`null`, or an empty array: OpenAI sends `refusal: null`
 * and `annotations: []` with every message); its tool calls (`callParts`).
 */
function parts(message: Schema.JsonObject): ReadonlyArray<ModelPart> {
  const { tool_calls } = message;
  return [...fieldParts(message), ...(Array.isArray(tool_calls) ? (tool_calls as ReadonlyArray<Json>).flatMap(callParts) : [])];
}

/** The parts the message's fields other than its tool calls become. */
function fieldParts(message: Schema.JsonObject): ReadonlyArray<ModelPart> {
  const { role: _role, content, tool_calls: _calls, ...rest } = message;
  const filled = Object.entries(rest).filter(([, value]) => value !== null && value !== undefined && !(Array.isArray(value) && value.length === 0));
  const thinks = ([field, value]: readonly [string, Json | undefined]) => thinkingFields.includes(field) && typeof value === "string";
  return [
    ...filled.flatMap(([field, value]): ReadonlyArray<ModelPart> =>
      thinkingFields.includes(field) && typeof value === "string" ? [{ _tag: "Thinking", text: ThinkingText.make(value), received: receivedJson({ [field]: value }) }] : [],
    ),
    ...contentParts(content),
    ...filled
      .filter((entry) => !thinks(entry))
      .map(([field, value]): ModelPart => ({ _tag: "Unrecognised", received: receivedJson({ [field]: value as Json }) })),
  ];
}

/**
 * The parts the message's `content` becomes: text as `Text`. A list of chunks (Mistral's) becomes a
 * part per chunk, in order: a text chunk as `Text`; a thinking chunk as `Thinking`, its text the
 * text of its own chunks, holding the chunk; any other chunk as `Unrecognised`, holding it.
 */
function contentParts(content: Json | undefined): ReadonlyArray<ModelPart> {
  if (content === undefined || content === null) return [];
  if (typeof content === "string") return content.length === 0 ? [] : [{ _tag: "Text", text: ModelText.make(content) }];
  return asChunks(content).flatMap((chunk): ReadonlyArray<ModelPart> => {
    const kept = receivedJson({ content: [chunk] });
    if (!isObject(chunk)) return [{ _tag: "Unrecognised", received: kept }];
    if (chunk["type"] === "text" && typeof chunk["text"] === "string") return chunk["text"].length === 0 ? [] : [{ _tag: "Text", text: ModelText.make(chunk["text"]) }];
    if (chunk["type"] === "thinking") return [{ _tag: "Thinking", text: ThinkingText.make(thinkingOf(chunk)), received: kept }];
    return [{ _tag: "Unrecognised", received: kept }];
  });
}

/** The text of a thinking chunk: its own text chunks' text, joined. */
const thinkingOf = (chunk: Schema.JsonObject): string => {
  const thinking = chunk["thinking"];
  if (typeof thinking === "string") return thinking;
  return Array.isArray(thinking) ? thinking.flatMap((each) => (isObject(each) && typeof each["text"] === "string" ? [each["text"]] : [])).join("") : "";
};

/** The text a chunk's delta adds to the answer and to the thinking, as it arrives. */
const deltasIn = (delta: Schema.JsonObject): ReadonlyArray<Streamed> => [
  ...thinkingFields.flatMap((field): ReadonlyArray<Streamed> => {
    const text = delta[field];
    return typeof text === "string" ? [{ _tag: "Delta", kind: "Thinking", text }] : [];
  }),
  ...(delta["content"] === undefined || delta["content"] === null ? [] : asChunks(delta["content"])).flatMap((chunk): ReadonlyArray<Streamed> => {
    if (!isObject(chunk)) return [];
    if (chunk["type"] === "text" && typeof chunk["text"] === "string") return [{ _tag: "Delta", kind: "Text", text: chunk["text"] }];
    return chunk["type"] === "thinking" ? [{ _tag: "Delta", kind: "Thinking", text: thinkingOf(chunk) }] : [];
  }),
];

/** A choice's `finish_reason` values. */
const endings = new Map([
  ["stop", "Complete"],
  ["tool_calls", "Complete"],
  ["function_call", "Complete"],
  // xAI's
  ["end_turn", "Complete"],
  ["length", "CutShort"],
  // Mistral's: the model's context was full.
  ["model_length", "CutShort"],
  ["content_filter", "Refused"],
] as const);

/**
 * A Chat Completions usage in the core's terms: its `prompt_tokens` include those read from the
 * cache. The thinking and the cache read are where OpenAI puts them, or at the top of the usage
 * (SGLang's `reasoning_tokens`, some of Together's models' `cached_tokens`).
 */
const chatUsageIn = (reported: Json | undefined) => {
  const usage = usageOf({
    input: numberAt(reported, "prompt_tokens"),
    output: numberAt(reported, "completion_tokens"),
    thinking: numberAt(reported, "completion_tokens_details", "reasoning_tokens") ?? numberAt(reported, "reasoning_tokens"),
    cacheRead: numberAt(reported, "prompt_tokens_details", "cached_tokens") ?? numberAt(reported, "cached_tokens"),
    cacheWrite: numberAt(reported, "prompt_tokens_details", "cache_write_tokens"),
  });
  return usage === undefined ? {} : { usage };
};

/** The usage a chunk holds: as `usage`, in Groq's `x_groq`, or in its choice (Kimi's documentation shows it there). */
const usageIn = (chunk: Schema.JsonObject, choice: Json | undefined): Json | undefined => {
  const groq = chunk["x_groq"];
  return [chunk["usage"], isObject(groq ?? null) ? (groq as Schema.JsonObject)["usage"] : undefined, isObject(choice ?? null) ? (choice as Schema.JsonObject)["usage"] : undefined].find(
    (each) => each !== undefined && each !== null,
  );
};

/**
 * A message as its stream's deltas build it. A text field (`content`, `reasoning_content`, ...) is
 * its deltas joined in order; a list of chunks (Mistral's `content`), its deltas' chunks joined
 * (`chunksJoined`), text that follows a list being a text chunk; any other field, as its last delta
 * gave it. Tool calls are kept by their `index`, their `arguments` joined (an object as its JSON
 * text), their `id` as first given and their name as `nameOf` says; a call with no index is the one
 * its `id` names, or a new one.
 */
interface Building {
  readonly fields: Map<string, Json>;
  readonly calls: Map<number, { id?: string; name?: string; arguments: string; rest: Record<string, Json> }>;
}

const asChunks = (value: Json): ReadonlyArray<Json> => (typeof value === "string" ? [{ type: "text", text: value }] : Array.isArray(value) ? value : [value]);

const joined = (before: Json | undefined, delta: Json): Json =>
  typeof before === "string" && typeof delta === "string"
    ? before + delta
    : before !== undefined && (Array.isArray(before) || Array.isArray(delta)) && (typeof before === "string" || Array.isArray(before))
      ? chunksJoined(asChunks(before), asChunks(delta))
      : delta;

/**
 * `before`'s chunks with `more` after them: a text chunk after a text chunk adds its text to it, and
 * a thinking chunk after a thinking chunk adds its own chunks to it (its other fields, `closed` or a
 * `signature`, the later ones), as a stream sends one chunk in pieces.
 */
function chunksJoined(before: ReadonlyArray<Json>, more: ReadonlyArray<Json>): ReadonlyArray<Json> {
  return more.reduce<ReadonlyArray<Json>>((all, chunk) => {
    const last = all.at(-1);
    if (last === undefined || !isObject(last) || !isObject(chunk) || last["type"] !== chunk["type"]) return [...all, chunk];
    const [earlier, later] = [last as Record<string, Json>, chunk as Record<string, Json>];
    if (later["type"] === "text" && typeof earlier["text"] === "string" && typeof later["text"] === "string")
      return [...all.slice(0, -1), { ...earlier, ...later, text: earlier["text"] + later["text"] }];
    if (later["type"] === "thinking" && Array.isArray(earlier["thinking"]) && Array.isArray(later["thinking"]))
      return [...all.slice(0, -1), { ...earlier, ...later, thinking: chunksJoined(earlier["thinking"], later["thinking"]) }];
    return [...all, chunk];
  }, before);
}

function added(building: Building, delta: Schema.JsonObject): ReadonlyArray<number> {
  const { role: _role, tool_calls, ...rest } = delta;
  for (const [field, value] of Object.entries(rest)) if (value !== null && value !== undefined) building.fields.set(field, joined(building.fields.get(field), value));
  if (!Array.isArray(tool_calls)) return [];
  return (tool_calls as ReadonlyArray<Json>).flatMap((each) => {
    if (!isObject(each)) return [];
    const { index, id, function: fn, type: _type, ...extra } = each;
    const byId = typeof id === "string" ? [...building.calls].find(([, call]) => call.id === id)?.[0] : undefined;
    const at = typeof index === "number" ? index : (byId ?? building.calls.size);
    const call = building.calls.get(at) ?? { arguments: "", rest: {} };
    const named = isObject(fn ?? null) ? (fn as { readonly name?: Json; readonly arguments?: Json }) : {};
    building.calls.set(at, {
      ...(call.id === undefined && typeof id === "string" ? { id } : call.id === undefined ? {} : { id: call.id }),
      ...nameOf(call.name, named.name),
      arguments: call.arguments + (typeof named.arguments === "string" ? named.arguments : named.arguments === undefined || named.arguments === null ? "" : JSON.stringify(named.arguments)),
      rest: { ...call.rest, ...(extra as Record<string, Json>) },
    });
    return [at];
  });
}

/**
 * A call's name as its deltas give it: the first one given, or a later one that starts with it,
 * as llama.cpp sends the name whole again each time it grows.
 */
const nameOf = (before: string | undefined, given: Json | undefined): { readonly name?: string } =>
  typeof given === "string" && given.length > 0 && (before === undefined || given.startsWith(before))
    ? { name: given }
    : before === undefined
      ? {}
      : { name: before };

/** A tool call as the message holds it, from what its deltas built. */
const callOf = (call: { id?: string; name?: string; arguments: string; rest: Record<string, Json> }): Json => ({
  id: call.id ?? null,
  type: "function",
  function: { name: call.name ?? null, arguments: call.arguments },
  ...call.rest,
});

/** The message the deltas built. */
const messageOf = (building: Building): Schema.JsonObject => ({
  role: "assistant",
  ...Object.fromEntries(building.fields),
  ...(building.calls.size === 0 ? {} : { tool_calls: [...building.calls].sort(([a], [b]) => a - b).map(([, call]) => callOf(call)) }),
});

/**
 * One request. The response streams (`stream: true`, with its usage in the last chunk): each chunk
 * is passed on as it arrives, and a tool call once the next one begins (`ModelStream`); the
 * observation is made from the message the chunks built, as a whole response's message is. A
 * stream that ends with no `finish_reason` was cut short, and fails; a chunk that holds an `error`
 * (Groq's in `x_groq`) fails the request with it, and so does a `finish_reason` of `error`. A
 * server that answers with the whole response instead is read as one chunk holding the whole
 * message.
 */
const respondOnce = (
  http: HttpClient.HttpClient,
  post: Post,
  target: Target,
  turn: TurnId,
): Effect.Effect<Responded, AiError.AiError> =>
  Effect.gen(function* () {
    const passOn = yield* ModelStream;
    const building: Building = { fields: new Map(), calls: new Map() };
    const passed = new Set<number>();
    const end = yield* postEventsOrWhole(http, caller, post).pipe(
      Stream.runFoldEffect(
        (): { readonly finish: Json | undefined; readonly usage: Json | undefined; readonly metadata: Record<string, Json> } => ({ finish: undefined, usage: undefined, metadata: {} }),
        (so, chunk) =>
          Effect.gen(function* () {
            yield* passOn({ _tag: "Chunk", chunk: receivedJson(chunk) });
            if (!isObject(chunk)) return so;
            // Groq says why it stopped a stream early in `x_groq.error`.
            const reported = chunk["error"] ?? (isObject(chunk["x_groq"] ?? null) ? (chunk["x_groq"] as Schema.JsonObject)["error"] : undefined);
            if (reported !== undefined && reported !== null) return yield* invalidOutput(caller, `The stream reported an error: ${JSON.stringify(reported)}`);
            const { choices, usage: _usage, ...metadata } = chunk;
            const choice = Array.isArray(choices) ? (choices as ReadonlyArray<Json>)[0] : undefined;
            // A server that answers whole sends the message where a chunk sends its delta; what arrives
            // whole adds no text as it arrives.
            const streamedDelta = choice !== undefined && isObject(choice) ? choice["delta"] : undefined;
            const delta = choice !== undefined && isObject(choice) ? (streamedDelta ?? choice["message"]) : undefined;
            if (streamedDelta !== undefined && isObject(streamedDelta)) yield* Effect.forEach(deltasIn(streamedDelta), passOn, { discard: true });
            const touched = delta !== undefined && isObject(delta) ? added(building, delta) : [];
            // A call is whole once a later one begins.
            const later = Math.max(-1, ...touched);
            for (const [at, call] of building.calls)
              if (at < later && !passed.has(at)) {
                passed.add(at);
                yield* Effect.forEach(callParts(callOf(call)), (part) => passOn({ _tag: "Part", part }), { discard: true });
              }
            const finish = choice !== undefined && isObject(choice) && choice["finish_reason"] !== null && choice["finish_reason"] !== undefined ? choice["finish_reason"] : so.finish;
            return { finish, usage: usageIn(chunk, choice) ?? so.usage, metadata: { ...so.metadata, ...(metadata as Record<string, Json>) } };
          }),
      ),
    );
    if (end.finish === undefined) return yield* invalidOutput(caller, `The stream ended with no finish_reason: ${JSON.stringify(messageOf(building))}`);
    // Mistral and OpenRouter end a response that failed with `finish_reason: "error"`.
    if (end.finish === "error") return yield* invalidOutput(caller, `The response ended with finish_reason "error": ${JSON.stringify(messageOf(building))}`);
    const message = messageOf(building);
    const responded = parts(message);
    const unpassed = [...building.calls].filter(([at]) => !passed.has(at)).sort(([a], [b]) => a - b);
    yield* Effect.forEach(
      [...fieldParts(message), ...unpassed.flatMap(([, call]) => callParts(callOf(call)))],
      (part) => passOn({ _tag: "Part", part }),
      { discard: true },
    );
    return {
      _tag: "ModelResponded" as const,
      turn,
      provider: target.provider,
      model: target.model,
      parts: responded,
      stop: StopReason.make(typeof end.finish === "string" ? end.finish : JSON.stringify(end.finish)),
      ending: endingOf(endings, end.finish),
      ...chatUsageIn(end.usage),
      metadata: receivedJson({ ...end.metadata, ...(end.usage === undefined ? {} : { usage: end.usage }) }),
    };
  });

/** Requests through the configured compatible client, retried while retryable; a failure is the `AiError`. */
export const openAiCompatRequests = (
  retries: Retries = defaultRetries,
): Effect.Effect<ProviderRequest, never, OpenAiClient.OpenAiClient> =>
  Effect.gen(function* () {
    const http = (yield* OpenAiClient.OpenAiClient).client;
    const leftOutLogged = yield* Ref.make<LeftOutLogged>(new Set());
    return (target, context, turn) => {
      const settled = openAiCompatSettle(target);
      return filesIn(context).pipe(
        Effect.flatMap((files) => {
        const sent = body(target, context, files);
        const post: Post = {
          path: "/chat/completions",
          headers: settled.headers,
          body: { ...(sent.json as Record<string, Json>), ...settled.fields, stream: true, stream_options: { include_usage: true } },
        };
        return reportAdjusted(turn, target, settled).pipe(
          Effect.andThen(logSupplied(sent.supplied, target, turn, leftOutLogged)),
          Effect.andThen(respondOnce(http, post, target, turn).pipe(withRetries(retries), failedPosting(post))),
        );
        }),
      );
    };
  });

export const openAiCompatModelClient = (retries: Retries = defaultRetries) =>
  Layer.effect(ModelClient, openAiCompatRequests(retries).pipe(Effect.map(modelClientOf)));

export const OpenAiCompatModelClient = openAiCompatModelClient();
