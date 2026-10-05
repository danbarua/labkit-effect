/**
 * A digest of a span of the conversation, for a compaction's summary, made from the messages
 * alone, with no model. It has up to two sections, and omits a section that would be empty:
 *
 *   Attachments (removed to preserve context):
 *   [image/png, 1 KiB, halves.png: blob://1ec195…]
 *
 *   Tool Calls:
 *   `list_dir`:   21 files in /foo/bar/baz
 *   `read`    :   package.json
 *
 * - Attachments: every file that the span carried (a user's file, or a tool's output kept in the
 *   blob store), as its pointer, in order, each once.
 * - Tool calls: one line per call. A tool with its own `ToolDigest` describes its input and outcome.
 *   For any other tool, the line is the input as JSON with every long text replaced by its length
 *   (`{"path":"a.ts","content":"<12345 chars>"}`), followed by the failure reason when the call
 *   failed. A call with no result in the span is marked `(not ended)`.
 *
 * `DigestSummarizer(digests)` is a summarizer whose summary is the digest.
 */

import { Effect } from "effect";
import type { BlobRef } from "../agent-machine/blob.ts";
import type { ToolOutcome } from "../agent-machine/observation.ts";
import type { Received } from "../agent-machine/received.ts";
import type { ContextMessage } from "../agent-session/contracts.ts";
import { asText, parseJson, receivedText } from "../agent-session/received.ts";
import { blobPointer, isObject, type Json } from "../agent-session/shaping.ts";
import type { Summarizer } from "./compaction.ts";
import { SummarizerName } from "./forks.ts";

/** Returns one tool call's line in the digest: what the call did and its result, as the tool describes them. */
export type ToolDigest = (input: Received, outcome: ToolOutcome | undefined) => string;

/** Each tool's digest function, by tool name. A tool without an entry gets the default line. */
export type ToolDigests = ReadonlyMap<string, ToolDigest>;

/** Texts longer than this many characters are replaced by their length. */
const longText = 40;

/** Returns `value` with every long text replaced by its length. */
function sized(value: Json): Json {
  if (typeof value === "string") return value.length > longText ? `<${value.length} chars>` : value;
  if (Array.isArray(value)) return value.map(sized);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, each]) => [key, sized(each)]));
  return value;
}

/** Returns a call's input as it appears in a line: JSON with long texts replaced by their lengths. Input that is not JSON appears as its length when it is long. */
function given(input: Received): string {
  const parsed = parseJson(input);
  if ("value" in parsed) return JSON.stringify(sized(parsed.value));
  const text = asText(input);
  return text.length > longText ? `<${text.length} chars>` : text;
}

/** The line for a call whose tool has no digest: its input, followed by `(not ended)`, or by the failure reason when the call failed. */
const defaultDigest: ToolDigest = (input, outcome) => {
  const shown = given(input);
  if (outcome === undefined) return `${shown} (not ended)`;
  return outcome._tag === "Succeeded" ? shown : `${shown} (failed: ${outcome.reason._tag})`;
};

/** Returns every file that `messages` carried, by reference, in order, each once. */
export function attachmentsIn(messages: ReadonlyArray<ContextMessage>): ReadonlyArray<BlobRef> {
  const files = messages.flatMap((message) =>
    message.parts.flatMap((part): ReadonlyArray<BlobRef> => {
      if (part._tag === "File") return [part.blob];
      if (part._tag === "ToolResult" && part.outcome._tag === "Succeeded" && part.outcome.output.body._tag === "Stored")
        return [{ id: part.outcome.output.body.id, mediaType: part.outcome.output.mediaType, size: part.outcome.output.body.size }];
      return [];
    }),
  );
  return files.filter((file, at) => files.findIndex((each) => each.id === file.id) === at);
}

/** Returns the digest of `messages`, or an empty string when they carried no file and made no tool call. */
export function digestOf(messages: ReadonlyArray<ContextMessage>, digests: ToolDigests = new Map()): string {
  const parts = messages.flatMap((message) => message.parts);
  const outcomes = new Map(parts.flatMap((part) => (part._tag === "ToolResult" ? [[part.call, part.outcome] as const] : [])));
  const calls = parts.flatMap((part) => (part._tag === "ToolCall" ? [part] : []));
  const width = Math.max(0, ...calls.map((call) => call.tool.length));
  const lines = calls.map((call) => {
    const line = (digests.get(call.tool) ?? defaultDigest)(call.input, outcomes.get(call.call));
    return `\`${call.tool}\`${" ".repeat(width - call.tool.length)}:   ${line}`;
  });
  const files = attachmentsIn(messages);
  return [
    ...(files.length === 0 ? [] : [["Attachments (removed to preserve context):", ...files.map(blobPointer)].join("\n")]),
    ...(lines.length === 0 ? [] : [["Tool Calls:", ...lines].join("\n")]),
  ].join("\n\n");
}

export const DigestSummarizer = (digests: ToolDigests = new Map()): Summarizer => ({
  name: SummarizerName.make("Digest"),
  summarize: (_previous, messages) => Effect.succeed(receivedText(digestOf(messages, digests))),
});
