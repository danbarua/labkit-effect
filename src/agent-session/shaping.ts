/**
 * What every provider adapter needs to shape a context into its wire format: each tool call's tool
 * and input, a tool's input as the JSON object that the wire formats require, and a tool outcome as
 * the text that the model is sent. Where an adapter supplies or replaces something that the context
 * does not contain, it records it as `Supplied` and logs it.
 */

import { Effect, Ref, type Schema } from "effect";
import type { BlobId, BlobRef } from "../agent-machine/blob.ts";
import { type CallId, TokenCount, type ToolName, type TurnId } from "../agent-machine/names.ts";
import type { ResponseEnding, ToolOutcome, Usage } from "../agent-machine/observation.ts";
import type { Received } from "../agent-machine/received.ts";
import type { ContextPart, ModelContext, Target, ToolSpec } from "./contracts.ts";
import { Blobs, blobUriOf, extensionOf } from "./blobs.ts";
import { logKeys } from "./log-keys.ts";
import { asText, parseJson } from "./received.ts";

export type Json = Schema.Json;

/** Something that an adapter supplied or changed to fit its wire format, the log event, and the details. */
export interface Supplied {
  readonly level: "info" | "warning";
  readonly event: string;
  readonly details: Record<string, unknown>;
}

/** Wire-format JSON, and what was supplied to produce it. */
export interface Shaped {
  readonly json: Json;
  readonly supplied: ReadonlyArray<Supplied>;
}

/** A tool call's tool and input, as the model gave them. */
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

/** Returns the source of a provider's own part, for the log: the model and turn of a response, or the window of a compaction. */
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
 * Returns a description of a part omitted from a request, for the log: its kind; for a part of a
 * response, the provider that produced it; the fields of a JSON part; its length in characters; and
 * its first 120 characters.
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
 * The omitted parts that have been logged: for each, the part (its digest), the model whose request
 * omitted it, and the reason. A part is logged the first time it is omitted from a request to a
 * model for a reason. It is omitted from every later request to that model, until compaction removes
 * it from the conversation, and is not logged again. A request to another model, or a changed
 * reason, logs it again.
 */
export type OmittedLogged = ReadonlySet<string>;

/** Returns the parts omitted from a request to `target` that are logged for the first time, and the updated set of logged parts. */
export function firstOmitted(
  logged: OmittedLogged,
  target: Target,
  left: ReadonlyArray<Supplied>,
): { readonly logged: OmittedLogged; readonly first: ReadonlyArray<Supplied> } {
  const keyOf = (entry: Supplied) => JSON.stringify([target.provider, target.model, entry.details["digest"], entry.details["reason"]]);
  const first = left.filter((entry, at) => !logged.has(keyOf(entry)) && left.findIndex((other) => keyOf(other) === keyOf(entry)) === at);
  return { logged: new Set([...logged, ...first.map(keyOf)]), first };
}

/**
 * Returns a warning for each field of `context` that an adapter which does not translate it leaves
 * out of the request: the context's `toolChoice`, and its tools that are `constrained`.
 */
export function untranslated(context: ModelContext): ReadonlyArray<Supplied> {
  const constrained = context.tools.filter((tool) => tool.constrained === true).map((tool) => tool.name);
  return [
    ...(context.toolChoice === undefined
      ? []
      : [{ level: "warning" as const, event: logKeys.provider.notTranslated, details: { field: "toolChoice", value: context.toolChoice, without: "the model chooses whether to call a tool" } }]),
    ...(constrained.length === 0
      ? []
      : [{ level: "warning" as const, event: logKeys.provider.notTranslated, details: { field: "constrained", tools: constrained, without: "the model's tool input is checked only when the tool runs" } }]),
  ];
}

/** Returns a part of an earlier response that is not sent, with the reason, as an info-level `Supplied` entry. */
export function omittedPart(part: ContextPart, reason: string): Shaped {
  return {
    json: [],
    supplied: [{ level: "info", event: logKeys.provider.partsOmitted, details: { ...describedPart(part), reason } }],
  };
}

/** Where an earlier response's part may be sent back as received: to its provider, or only to its provider's same model. */
export type SentBackTo = "Provider" | "Model";

/** Returns why a part produced by `provider`'s `model` is not sent back to `target` as received, or undefined when it is. */
const elsewhereOf = (provider: string, model: string | undefined, target: Target, to: SentBackTo): string | undefined => {
  if (provider !== target.provider) return `produced by ${provider}, not ${target.provider}`;
  if (to === "Model" && model !== undefined && model !== target.model) return `produced by ${provider}/${model}, not ${target.provider}/${target.model}`;
  return undefined;
};

/**
 * Returns the JSON that an earlier response's thinking or other part is sent back as.
 * - To its source (its provider, or with `"Model"` its provider's same model): what was received,
 *   unchanged.
 * - To anyone else: thinking with text is sent as that text, in the adapter's form (`asText`); any
 *   other part is omitted, because only its source can read it.
 */
export function sentBack(
  part: Extract<ContextPart, { _tag: "Thinking" | "Unrecognised" }>,
  target: Target,
  to: SentBackTo,
  asText: (text: string) => Shaped,
): Shaped {
  const model = part.from._tag === "Response" ? part.from.model : undefined;
  const elsewhere = elsewhereOf(part.provider, model, target, to);
  if (elsewhere !== undefined) return part._tag === "Thinking" && part.text.length > 0 ? asText(part.text) : omittedPart(part, elsewhere);
  const parsed = parseJson(part.received);
  return "value" in parsed ? { json: [parsed.value], supplied: [] } : omittedPart(part, parsed.reason);
}

/** Returns each call in `context`, by call id: the tool's name and the input that the model gave. */
export function callsIn(context: ModelContext): ReadonlyMap<CallId, Called> {
  return new Map(
    context.messages.flatMap((message) =>
      message.parts.flatMap((part) =>
        part._tag === "ToolCall" ? [[part.call, { tool: part.tool, input: part.input }] as const] : [],
      ),
    ),
  );
}

/** Returns the input as a JSON object, or `{}` in its place, with the replacement recorded and logged as a warning. */
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

/** Returns the input as JSON when it parses, and as text otherwise. */
function parsedOrText(input: Received): Json {
  const parsed = parseJson(input);
  return "value" in parsed ? parsed.value : asText(input);
}

/** A tool outcome as the text that the model is sent, and whether it reports a failure. */
export interface RenderedResult {
  readonly text: string;
  readonly isError: boolean;
  /** The output's bytes, when they are in the blob store; `text` is then the bytes' pointer. */
  readonly file?: BlobRef;
}

/**
 * Returns a tool outcome as the model is sent it. A failure tells the model what to do next: for a
 * tool that does not exist, it lists the tools that do; for input that does not fit, it gives the
 * tool's input schema and the input given.
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
              given: called === undefined ? undefined : parsedOrText(called.input),
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
 * Logs what an adapter supplied to make a request to `target`, in `turn`. The omitted parts are
 * logged in one line, each with the model and turn it came from, and only those omitted for the
 * first time (`firstOmitted`, given what `logged` holds of earlier requests).
 */
export const logSupplied = (supplied: ReadonlyArray<Supplied>, target: Target, turn: TurnId | undefined, logged: Ref.Ref<OmittedLogged>): Effect.Effect<void> =>
  Effect.gen(function* () {
    const left = supplied.filter((entry) => entry.event === logKeys.provider.partsOmitted);
    const rest = supplied.filter((entry) => entry.event !== logKeys.provider.partsOmitted);
    const first = yield* Ref.modify(logged, (before) => {
      const step = firstOmitted(before, target, left);
      return [step.first, step.logged];
    });
    const omittedLine: ReadonlyArray<Supplied> =
      first.length === 0
        ? []
        : [
            {
              level: "info",
              event: logKeys.provider.partsOmitted,
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
      [...rest, ...omittedLine],
      (entry) => (entry.level === "warning" ? Effect.logWarning(entry.event, entry.details) : Effect.logInfo(entry.event, entry.details)),
      { discard: true },
    );
  });

/** Returns the number at `path` in `json`, or undefined when there is none. */
export function numberAt(json: Json | undefined, ...path: ReadonlyArray<string>): number | undefined {
  const found = path.reduce<Json | undefined>((at, key) => (at !== undefined && isObject(at) ? at[key] : undefined), json);
  return typeof found === "number" ? found : undefined;
}

/** Returns a usage figure from the counts that a provider reported, or undefined when either input or output is missing. */
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

/** Returns the blobs that a part refers to, by id and the extension of their media type: a file, or a tool output held in the store. */
const blobsOf = (part: ContextPart): ReadonlyArray<readonly [BlobId, string]> => {
  if (part._tag === "File") return [[part.blob.id, extensionOf(part.blob.mediaType)]];
  if (part._tag === "ToolResult" && part.outcome._tag === "Succeeded" && part.outcome.output.body._tag === "Stored") return [[part.outcome.output.body.id, extensionOf(part.outcome.output.mediaType)]];
  return [];
};

/** Returns the bytes of every file that `context` carries, read from the blob store; a file that the store does not hold is absent. */
export const filesIn = (context: ModelContext): Effect.Effect<ReadonlyMap<BlobId, Uint8Array>> =>
  Effect.gen(function* () {
    const blobs = yield* Blobs;
    const named = context.messages.flatMap((message) => message.parts.flatMap(blobsOf));
    // One read for each blob, by id; the same bytes under two media types are one blob in memory.
    const ids = named.filter(([id], at) => named.findIndex(([other]) => other === id) === at);
    const read = yield* Effect.forEach(ids, ([id, extension]) => blobs.read(id, extension).pipe(Effect.map((bytes) => [id, bytes] as const)));
    return new Map(read.flatMap(([id, bytes]) => (bytes === undefined ? [] : [[id, bytes] as const])));
  });

/** Formats a number of bytes for a pointer: in bytes under 1 KiB, in whole KiB under 1 MiB, else in MiB to one decimal place. */
const sizeOf = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
};

/** Returns a file as pointer text that the model can quote, or read with `read_file` when it is text: `[image/png, 68 KiB, a.png: blob://<id>.png]`. */
export function blobPointer(blob: BlobRef): string {
  return `[${blob.mediaType}, ${sizeOf(blob.size)}${blob.name === undefined ? "" : `, ${blob.name}`}: ${blobUriOf(blob.id, blob.mediaType)}]`;
}

/** Returns the pointer for a file that the model is not sent, marked as not shown: `[not shown to you: image/png, 68 KiB, a.png: blob://<id>.png]`. */
export const notShown = (blob: BlobRef): string => `[not shown to you: ${blobPointer(blob).slice(1)}`;

/**
 * Returns how a file is sent to the model:
 * - its bytes, when the model accepts its kind (`accepts`) and the store holds them;
 * - for a text file, its text, after its pointer;
 * - otherwise its pointer, marked as not shown (`notShown`), with the reason logged.
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
