/**
 * A model client over HTTP, in the Anthropic Messages wire format. It shapes the core's types into
 * the wire format and back.
 *
 * Out: the context's messages, tools, and tool outcomes become Anthropic blocks. A failed tool call
 * becomes an error `tool_result` whose content tells the model what to do next: for a tool that
 * does not exist, the tools that do; for input that does not fit, the tool's input schema and what
 * was given. Where the wire format needs something the context does not say, the client supplies
 * it and logs that it did.
 *
 * In: a response's `content` blocks become the observation's parts in order: a `text` block is
 * `Text`, a `tool_use` block is `ToolCall`, any other block is `Unrecognised` holding the block as
 * received. Everything else in the response is `metadata`. A failure is observed as `ModelFailed`;
 * what was received with it is logged here.
 */

import { Effect, Layer, type Schema } from "effect";
import { CallId, FailureText, ModelText, StopReason, ToolName, type TurnId } from "../agent-core/names.ts";
import type { ModelPart, Observation, ToolOutcome } from "../agent-core/observation.ts";
import type { Received } from "../agent-core/received.ts";
import { type ContextPart, type ModelContext, ModelClient, type Target, type ToolSpec } from "./contracts.ts";
import { asText, parseJson, receivedJson } from "./received.ts";

type Json = Schema.Json;
type Outcome = Extract<Observation, { _tag: "ModelResponded" | "ModelFailed" }>;

/** The output limit sent when the context sets none; the Messages API requires one. */
const defaultMaxTokens = 1024;

/** Something the client supplied or changed to fit the wire format, and why. */
interface Supplied {
  readonly level: "info" | "warning";
  readonly event: string;
  readonly details: Record<string, unknown>;
}

interface Shaped {
  readonly json: Json;
  readonly supplied: ReadonlyArray<Supplied>;
}

interface Called {
  readonly tool: ToolName;
  readonly input: Received;
}

function isObject(value: Json): value is Schema.JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What the model called, by call: the tool's name and the input it gave. */
function callsIn(context: ModelContext): ReadonlyMap<CallId, Called> {
  return new Map(
    context.messages.flatMap((message) =>
      message.parts.flatMap((part) =>
        part._tag === "ToolCall" ? [[part.call, { tool: part.tool, input: part.input }] as const] : [],
      ),
    ),
  );
}

/** The input as the object the wire format requires, or `{}` in its place, logged. */
function toolInput(call: CallId, input: Received): Shaped {
  const parsed = parseJson(input);
  if ("value" in parsed && isObject(parsed.value)) return { json: parsed.value, supplied: [] };
  return {
    json: {},
    supplied: [
      {
        level: "warning",
        event: "model.request.tool_input_replaced",
        details: {
          call,
          reason: "value" in parsed ? "the input is not a JSON object" : parsed.reason,
          sent: {},
          received: asText(input),
        },
      },
    ],
  };
}

/** What was given, as JSON when it parses and as text otherwise. */
function given(input: Received): Json {
  const parsed = parseJson(input);
  return "value" in parsed ? parsed.value : asText(input);
}

function resultContent(
  outcome: ToolOutcome,
  called: Called | undefined,
  catalog: ReadonlyArray<ToolSpec>,
): { content: string; is_error?: true } {
  switch (outcome._tag) {
    case "Succeeded":
      return { content: asText(outcome.output) };
    case "Failed": {
      const reason = outcome.reason;
      switch (reason._tag) {
        case "Reported":
          return { content: asText(reason.error), is_error: true };
        case "NotFound":
          return {
            content: JSON.stringify({
              code: "tool_not_found",
              message: `No tool is named "${called?.tool ?? ""}".`,
              tools: catalog.map((tool) => ({ name: tool.name, input_schema: tool.input })),
            }),
            is_error: true,
          };
        case "InputRejected":
          return {
            content: JSON.stringify({
              code: "invalid_input",
              message: reason.problem,
              tool: called?.tool,
              input_schema: catalog.find((tool) => tool.name === called?.tool)?.input,
              given: called === undefined ? undefined : given(called.input),
            }),
            is_error: true,
          };
        case "Vetoed":
          return {
            content: JSON.stringify({
              code: "vetoed",
              message: "The call was not run.",
              reason: asText(reason.reason),
            }),
            is_error: true,
          };
        default:
          return reason satisfies never;
      }
    }
    default:
      return outcome satisfies never;
  }
}

function block(part: ContextPart, context: ModelContext, calls: ReadonlyMap<CallId, Called>): Shaped {
  switch (part._tag) {
    case "Text":
      return { json: { type: "text", text: part.text }, supplied: [] };
    case "ToolCall": {
      const input = toolInput(part.call, part.input);
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
          ...resultContent(part.outcome, calls.get(part.call), context.tools),
        },
        supplied: [],
      };
    default:
      return part satisfies never;
  }
}

function body(target: Target, context: ModelContext): Shaped {
  const calls = callsIn(context);
  const messages = context.messages.map((message) => {
    const blocks = message.parts.map((part) => block(part, context, calls));
    return {
      json: { role: message.role, content: blocks.map((shaped) => shaped.json) },
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
        event: "model.request.max_tokens_supplied",
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

const failed = (turn: TurnId, failure: string, details: Record<string, unknown>): Effect.Effect<Outcome> =>
  Effect.logError("model.request.failed", { turn, failure, ...details }).pipe(
    Effect.as({ _tag: "ModelFailed" as const, turn, failure: FailureText.make(failure) }),
  );

const logSupplied = (turn: TurnId, supplied: ReadonlyArray<Supplied>): Effect.Effect<void> =>
  Effect.forEach(
    supplied,
    (entry) =>
      entry.level === "warning"
        ? Effect.logWarning(entry.event, { turn, ...entry.details })
        : Effect.logInfo(entry.event, { turn, ...entry.details }),
    { discard: true },
  );

export const HttpModelClient = Layer.succeed(ModelClient, {
  respond: (target, context, turn) =>
    Effect.gen(function* () {
      const sent = body(target, context);
      yield* logSupplied(turn, sent.supplied);
      const received = yield* Effect.tryPromise(async () => {
        const response = await fetch(target.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(sent.json),
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
        return yield* failed(turn, "the response is not JSON", {
          endpoint: target.endpoint.href,
          status,
          body: text,
        });
      const response = parsed.success;
      if (!isObject(response) || !Array.isArray(response["content"]))
        return yield* failed(turn, "the response has no content blocks", {
          endpoint: target.endpoint.href,
          status,
          body: text,
        });
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
