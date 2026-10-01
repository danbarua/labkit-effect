/**
 * What every provider adapter needs to shape a context into its wire format: what each tool call
 * was, a tool's input as the JSON object the wire formats require, and a tool outcome as the text
 * the model is sent. Where an adapter supplies or replaces something the context does not say, it
 * records it as `Supplied`, and logs it.
 */

import { Effect, type Schema } from "effect";
import type { BlobId, BlobRef } from "../agent-machine/blob.ts";
import { type CallId, TokenCount, type ToolName } from "../agent-machine/names.ts";
import type { ResponseEnding, ToolOutcome, Usage } from "../agent-machine/observation.ts";
import type { Received } from "../agent-machine/received.ts";
import type { ContextPart, ModelContext, Target, ToolSpec } from "./contracts.ts";
import { Blobs } from "./blobs.ts";
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

/** The number at `path` in `json`, when there is one. */
export function numberAt(json: Json | undefined, ...path: ReadonlyArray<string>): number | undefined {
  const found = path.reduce<Json | undefined>((at, key) => (at !== undefined && isObject(at) ? at[key] : undefined), json);
  return typeof found === "number" ? found : undefined;
}

/** A usage figure from the counts a provider reported; none without both input and output. */
export function usageOf(counts: {
  readonly input: number | undefined;
  readonly output: number | undefined;
  readonly thinking?: number | undefined;
  readonly cacheRead?: number | undefined;
  readonly cacheWrite?: number | undefined;
  readonly cacheWrite1h?: number | undefined;
}): Usage | undefined {
  if (counts.input === undefined || counts.output === undefined) return undefined;
  const optional = (key: "thinking" | "cacheRead" | "cacheWrite" | "cacheWrite1h") => {
    const value = counts[key];
    return value === undefined ? {} : { [key]: TokenCount.make(value) };
  };
  return {
    input: TokenCount.make(counts.input),
    output: TokenCount.make(counts.output),
    ...optional("thinking"),
    ...optional("cacheRead"),
    ...optional("cacheWrite"),
    ...optional("cacheWrite1h"),
  };
}

/** The bytes of every file `context` carries, read from the blob store; a file it does not hold is absent. */
export const filesIn = (context: ModelContext): Effect.Effect<ReadonlyMap<BlobId, Uint8Array>> =>
  Effect.gen(function* () {
    const blobs = yield* Blobs;
    const ids = [...new Set(context.messages.flatMap((message) => message.parts.flatMap((part) => (part._tag === "File" ? [part.blob.id] : []))))];
    const read = yield* Effect.forEach(ids, (id) => blobs.read(id).pipe(Effect.map((bytes) => [id, bytes] as const)));
    return new Map(read.flatMap(([id, bytes]) => (bytes === undefined ? [] : [[id, bytes] as const])));
  });

/** A file as pointer text the model can quote or follow with a tool: `[image/png, 68 KiB, a.png: blob://<id>]`. */
export function blobPointer(blob: BlobRef): string {
  const size = blob.size < 1024 ? `${blob.size} B` : blob.size < 1024 * 1024 ? `${Math.round(blob.size / 1024)} KiB` : `${(blob.size / 1024 / 1024).toFixed(1)} MiB`;
  return `[${blob.mediaType}, ${size}${blob.name === undefined ? "" : `, ${blob.name}`}: blob://${blob.id}]`;
}

/**
 * How a file goes to the model: its bytes, when the model takes its kind (`accepts`) and the store
 * holds them; a text file's text, after its pointer; otherwise its pointer, and why is logged.
 */
export type FileAs =
  | { readonly _tag: "Bytes"; readonly blob: BlobRef; readonly base64: string; readonly dataUrl: string }
  | { readonly _tag: "Text"; readonly text: string; readonly supplied: ReadonlyArray<Supplied> };

export function fileAs(blob: BlobRef, files: ReadonlyMap<BlobId, Uint8Array>, accepts: (mediaType: string) => boolean): FileAs {
  const bytes = files.get(blob.id);
  const pointer = (reason: string): FileAs => ({
    _tag: "Text",
    text: blobPointer(blob),
    supplied: [{ level: "warning", event: logKeys.provider.fileAsPointer, details: { blob: blob.id, mediaType: blob.mediaType, reason } }],
  });
  if (bytes === undefined) return pointer("the blob store does not hold the file's bytes");
  if (blob.mediaType.startsWith("text/")) return { _tag: "Text", text: `${blobPointer(blob)}\n${new TextDecoder().decode(bytes)}`, supplied: [] };
  if (!accepts(blob.mediaType)) return pointer("the model is not known to take files of this type");
  const base64 = Buffer.from(bytes).toString("base64");
  return { _tag: "Bytes", blob, base64, dataUrl: `data:${blob.mediaType};base64,${base64}` };
}
