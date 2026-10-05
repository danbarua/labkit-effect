/**
 * What every provider adapter needs to shape a context into its wire format: what each tool call
 * was, a tool's input as the JSON object the wire formats require, and a tool outcome as the text
 * the model is sent. Where an adapter supplies or replaces something the context does not say, it
 * records it as `Supplied`, and logs it.
 */

import { Effect, Ref, type Schema } from "effect";
import type { BlobId, BlobRef } from "../agent-machine/blob.ts";
import { type CallId, TokenCount, type ToolName, type TurnId } from "../agent-machine/names.ts";
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

/** Where a provider's own part came from, for the log: the model and turn of a response, or the window of a compaction. */
const sourceOf = (part: Extract<ContextPart, { _tag: "Thinking" | "Unrecognised" }>): Record<string, unknown> => {
  switch (part.from._tag) {
    case "Response":
      return { from: `${part.provider}/${part.from.model}`, turn: part.from.turn };
    case "Compaction":
      return { from: `${part.provider} compaction`, window: part.from.window };
    default:
      return part.from satisfies never;
  }
};

/**
 * What a part left out of a request held, for the log: its kind, and for a part of a response the
 * provider that produced it; the fields of a JSON part; its length in characters; and its first 120
 * characters.
 */
function describedPart(part: ContextPart): Record<string, unknown> {
  const text = (() => {
    switch (part._tag) {
      case "Text":
      case "Commentary":
        return part.text;
      case "Thinking":
        return part.text === "" ? asText(part.received) : part.text;
      case "Unrecognised":
        return asText(part.received);
      case "ToolCall":
      case "ToolResult":
      case "File":
        return JSON.stringify(part);
      default:
        return part satisfies never;
    }
  })();
  const parsed = part._tag === "Unrecognised" ? parseJson(part.received) : undefined;
  const fields = parsed !== undefined && "value" in parsed && isObject(parsed.value) ? Object.keys(parsed.value) : undefined;
  return {
    part: part._tag,
    ...("provider" in part ? sourceOf(part) : {}),
    ...(fields === undefined ? {} : { fields }),
    chars: text.length,
    start: text.slice(0, 120),
    digest: Bun.hash(JSON.stringify(part)).toString(16),
  };
}

/**
 * The parts left out that have been logged: for each, the part (its digest), the model it was left
 * out of a request to, and why. A part is logged the first time it is left out of a request to a
 * model for a reason; it is left out of every later request to that model, until compaction takes
 * it out of the conversation, and is not logged again. Asking another model, or a reason that
 * changed, logs it again.
 */
export type LeftOutLogged = ReadonlySet<string>;

/** Which of the parts left out of a request to `target` are logged for the first time, and the parts logged after it. */
export function firstLeftOut(
  logged: LeftOutLogged,
  target: Target,
  left: ReadonlyArray<Supplied>,
): { readonly logged: LeftOutLogged; readonly first: ReadonlyArray<Supplied> } {
  const keyOf = (entry: Supplied) => JSON.stringify([target.provider, target.model, entry.details["digest"], entry.details["reason"]]);
  const first = left.filter((entry, at) => !logged.has(keyOf(entry)) && left.findIndex((other) => keyOf(other) === keyOf(entry)) === at);
  return { logged: new Set([...logged, ...first.map(keyOf)]), first };
}

/** A part of an earlier response that is not sent, and why. */
export function leftOut(part: ContextPart, reason: string): Shaped {
  return {
    json: [],
    supplied: [{ level: "info", event: logKeys.provider.partLeftOut, details: { ...describedPart(part), reason } }],
  };
}

/** Where an earlier response's part may go back as it was received: to its provider, or to its provider's same model. */
export type SentBackTo = "Provider" | "Model";

/**
 * The JSON an earlier response's thinking or other part is sent back as. To where it came from
 * (its provider, or with `"Model"` its provider's same model): what was received, unchanged.
 * Anywhere else, thinking with text goes as that text, in the adapter's form (`asText`); anything
 * else is left out, as only where it came from reads it.
 */
/** Why a part produced by `provider`'s `model` does not go back to `target` as it was received, if it does not. */
const elsewhereOf = (provider: string, model: string | undefined, target: Target, to: SentBackTo): string | undefined => {
  if (provider !== target.provider) return `produced by ${provider}, not ${target.provider}`;
  if (to === "Model" && model !== undefined && model !== target.model) return `produced by ${provider}/${model}, not ${target.provider}/${target.model}`;
  return undefined;
};

export function sentBack(
  part: Extract<ContextPart, { _tag: "Thinking" | "Unrecognised" }>,
  target: Target,
  to: SentBackTo,
  asText: (text: string) => Shaped,
): Shaped {
  const model = part.from._tag === "Response" ? part.from.model : undefined;
  const elsewhere = elsewhereOf(part.provider, model, target, to);
  if (elsewhere !== undefined) return part._tag === "Thinking" && part.text.length > 0 ? asText(part.text) : leftOut(part, elsewhere);
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
  /** The output's bytes, when they are in the blob store; `text` is then their pointer. */
  readonly file?: BlobRef;
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
    case "Succeeded": {
      const body = outcome.output.body;
      if (body._tag !== "Stored") return { text: asText(outcome.output), isError: false };
      const file: BlobRef = { id: body.id, mediaType: outcome.output.mediaType, size: body.size };
      return { text: notShown(file), isError: false, file };
    }
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

/**
 * Logs what an adapter supplied to make a request to `target`, in `turn`. The parts left out are
 * logged in one line, each described with the model and turn it came from, and only those left out
 * for the first time (`firstLeftOut`, with what `logged` holds of the requests before).
 */
export const logSupplied = (supplied: ReadonlyArray<Supplied>, target: Target, turn: TurnId | undefined, logged: Ref.Ref<LeftOutLogged>): Effect.Effect<void> =>
  Effect.gen(function* () {
    const left = supplied.filter((entry) => entry.event === logKeys.provider.partLeftOut);
    const rest = supplied.filter((entry) => entry.event !== logKeys.provider.partLeftOut);
    const first = yield* Ref.modify(logged, (before) => {
      const step = firstLeftOut(before, target, left);
      return [step.first, step.logged];
    });
    const leftOutLine: ReadonlyArray<Supplied> =
      first.length === 0
        ? []
        : [
            {
              level: "info",
              event: logKeys.provider.partLeftOut,
              details: {
                ...(turn === undefined ? {} : { turn }),
                to: `${target.provider}/${target.model}`,
                count: first.length,
                parts: first.map((entry) => entry.details),
                until: "left out of every request to this model until compaction takes them out; not logged again",
              },
            },
          ];
    yield* Effect.forEach(
      [...rest, ...leftOutLine],
      (entry) => (entry.level === "warning" ? Effect.logWarning(entry.event, entry.details) : Effect.logInfo(entry.event, entry.details)),
      { discard: true },
    );
  });

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

/** The blobs a part refers to: a file's, or the output a tool's result holds in the store. */
const blobsOf = (part: ContextPart): ReadonlyArray<BlobId> => {
  if (part._tag === "File") return [part.blob.id];
  if (part._tag === "ToolResult" && part.outcome._tag === "Succeeded" && part.outcome.output.body._tag === "Stored") return [part.outcome.output.body.id];
  return [];
};

/** The bytes of every file `context` carries, read from the blob store; a file it does not hold is absent. */
export const filesIn = (context: ModelContext): Effect.Effect<ReadonlyMap<BlobId, Uint8Array>> =>
  Effect.gen(function* () {
    const blobs = yield* Blobs;
    const ids = [
      ...new Set(
        context.messages.flatMap((message) =>
          message.parts.flatMap(blobsOf),
        ),
      ),
    ];
    const read = yield* Effect.forEach(ids, (id) => blobs.read(id).pipe(Effect.map((bytes) => [id, bytes] as const)));
    return new Map(read.flatMap(([id, bytes]) => (bytes === undefined ? [] : [[id, bytes] as const])));
  });

/** A number of bytes as a pointer says it: in bytes under a KiB, in whole KiB under a MiB, else in MiB to one decimal. */
const sizeOf = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
};

/** A file as pointer text the model can quote or follow with a tool: `[image/png, 68 KiB, a.png: blob://<id>]`. */
export function blobPointer(blob: BlobRef): string {
  return `[${blob.mediaType}, ${sizeOf(blob.size)}${blob.name === undefined ? "" : `, ${blob.name}`}: blob://${blob.id}]`;
}

/** A file the model is not sent, as its pointer, saying so: `[not shown to you: image/png, 68 KiB, a.png: blob://<id>]`. */
export const notShown = (blob: BlobRef): string => `[not shown to you: ${blobPointer(blob).slice(1)}`;

/**
 * How a file goes to the model: its bytes, when the model takes its kind (`accepts`) and the store
 * holds them; a text file's text, after its pointer; otherwise its pointer saying it is not shown
 * (`notShown`), and why is logged.
 */
export type FileAs =
  | { readonly _tag: "Bytes"; readonly blob: BlobRef; readonly base64: string; readonly dataUrl: string }
  | { readonly _tag: "Text"; readonly text: string; readonly supplied: ReadonlyArray<Supplied> };

export function fileAs(blob: BlobRef, files: ReadonlyMap<BlobId, Uint8Array>, accepts: (mediaType: string) => boolean): FileAs {
  const bytes = files.get(blob.id);
  const pointer = (reason: string): FileAs => ({
    _tag: "Text",
    text: notShown(blob),
    supplied: [{ level: "warning", event: logKeys.provider.fileAsPointer, details: { blob: blob.id, mediaType: blob.mediaType, reason } }],
  });
  if (bytes === undefined) return pointer("the blob store does not hold the file's bytes");
  if (blob.mediaType.startsWith("text/")) return { _tag: "Text", text: `${blobPointer(blob)}\n${new TextDecoder().decode(bytes)}`, supplied: [] };
  if (!accepts(blob.mediaType)) return pointer("the model is not known to take files of this type");
  const base64 = Buffer.from(bytes).toString("base64");
  return { _tag: "Bytes", blob, base64, dataUrl: `data:${blob.mediaType};base64,${base64}` };
}
