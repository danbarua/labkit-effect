/**
 * What every provider adapter needs to shape a context into its wire format: what each tool call
 * was, a tool's input as the JSON object the wire formats require, and a tool outcome as the text
 * the model is sent. Where an adapter supplies or replaces something the context does not say, it
 * records it as `Supplied`, and logs it.
 */

import { Effect, type Schema } from "effect";
import type { CallId, ToolName } from "../agent-machine/names.ts";
import type { ResponseEnding, ToolOutcome } from "../agent-machine/observation.ts";
import type { Received } from "../agent-machine/received.ts";
import type { ContextPart, ModelContext, Target, ToolSpec } from "./contracts.ts";
import { logKeys } from "./log-keys.ts";
import { asText, parseJson } from "./received.ts";

export type Json = Schema.Json;

/** Something an adapter supplied or changed to fit its wire format, and why. */
export interface Supplied {
  readonly level: "info" | "warning";
  readonly event: string;
  readonly details: Record<string, unknown>;
}

/** Wire-format JSON, and what was supplied to make it. */
export interface Shaped {
  readonly json: Json;
  readonly supplied: ReadonlyArray<Supplied>;
}

/** A tool call, as the model made it. */
export interface Called {
  readonly tool: ToolName;
  readonly input: Received;
}

/** A provider's stop reason, classified by the adapter's table; a reason not in it is `Unclassified`. */
export function endingOf(table: ReadonlyMap<string, ResponseEnding["_tag"]>, reason: Json | undefined): ResponseEnding {
  return { _tag: (typeof reason === "string" ? table.get(reason) : undefined) ?? "Unclassified" };
}

export function isObject(value: Json): value is Schema.JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A part of an earlier response that is not sent, and why. */
export function leftOut(part: ContextPart, reason: string): Shaped {
  return {
    json: [],
    supplied: [{ level: "info", event: logKeys.provider.partLeftOut, details: { part: part._tag, reason } }],
  };
}

/**
 * The JSON a provider's own part is sent back as: what was received, unchanged. Another provider's
 * part is left out: only the provider that produced it reads it.
 */
export function sentBack(part: Extract<ContextPart, { _tag: "Thinking" | "Unrecognised" }>, target: Target): Shaped {
  if (part.provider !== target.provider) return leftOut(part, `produced by ${part.provider}, not ${target.provider}`);
  const parsed = parseJson(part.received);
  return "value" in parsed ? { json: [parsed.value], supplied: [] } : leftOut(part, parsed.reason);
}

/** What the model called, by call: the tool's name and the input it gave. */
export function callsIn(context: ModelContext): ReadonlyMap<CallId, Called> {
  return new Map(
    context.messages.flatMap((message) =>
      message.parts.flatMap((part) =>
        part._tag === "ToolCall" ? [[part.call, { tool: part.tool, input: part.input }] as const] : [],
      ),
    ),
  );
}

/** The input as a JSON object, or `{}` in its place, with the replacement recorded. */
export function toolInputObject(call: CallId, input: Received): Shaped {
  const parsed = parseJson(input);
  if ("value" in parsed && isObject(parsed.value)) return { json: parsed.value, supplied: [] };
  return {
    json: {},
    supplied: [
      {
        level: "warning",
        event: logKeys.provider.toolInputReplaced,
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

/** A tool outcome as the text the model is sent, and whether it reports a failure. */
export interface RenderedResult {
  readonly text: string;
  readonly isError: boolean;
}

/**
 * A tool outcome as the model is sent it. A failure says what to do next: for a tool that does not
 * exist, the tools that do; for input that does not fit, the tool's input schema and what was
 * given.
 */
export function renderToolResult(
  outcome: ToolOutcome,
  called: Called | undefined,
  catalog: ReadonlyArray<ToolSpec>,
): RenderedResult {
  switch (outcome._tag) {
    case "Succeeded":
      return { text: asText(outcome.output), isError: false };
    case "Failed": {
      const reason = outcome.reason;
      switch (reason._tag) {
        case "Reported":
          return { text: asText(reason.error), isError: true };
        case "NotFound":
          return {
            text: JSON.stringify({
              code: "tool_not_found",
              message: `No tool is named "${called?.tool ?? ""}".`,
              tools: catalog.map((tool) => ({ name: tool.name, input_schema: tool.input })),
            }),
            isError: true,
          };
        case "InputRejected":
          return {
            text: JSON.stringify({
              code: "invalid_input",
              message: reason.problem,
              tool: called?.tool,
              input_schema: catalog.find((tool) => tool.name === called?.tool)?.input,
              given: called === undefined ? undefined : given(called.input),
            }),
            isError: true,
          };
        case "Vetoed":
          return {
            text: JSON.stringify({ code: "vetoed", message: "The call was not run.", reason: asText(reason.reason) }),
            isError: true,
          };
        case "Indeterminate":
          return {
            text: JSON.stringify({
              code: "indeterminate",
              message: "The tool began to run and how it ended was not observed. It may have had effects: check before relying on them.",
            }),
            isError: true,
          };
        case "NotRun":
          return { text: JSON.stringify({ code: "not_run", message: "The call was not run." }), isError: true };
        default:
          return reason satisfies never;
      }
    }
    default:
      return outcome satisfies never;
  }
}

export const logSupplied = (supplied: ReadonlyArray<Supplied>): Effect.Effect<void> =>
  Effect.forEach(
    supplied,
    (entry) =>
      entry.level === "warning" ? Effect.logWarning(entry.event, entry.details) : Effect.logInfo(entry.event, entry.details),
    { discard: true },
  );
