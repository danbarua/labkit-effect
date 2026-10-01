/**
 * A digest of a span of the conversation, for a compaction's summary, made from the messages
 * alone, with no model. It has up to two sections, each left out when it would be empty:
 *
 *   Attachments (removed to preserve context):
 *   [image/png, 1 KiB, halves.png: blob://1ec195…]
 *
 *   Tool Calls:
 *   `list_dir`:   21 files in /foo/bar/baz
 *   `read`    :   package.json
 *
 * The attachments are every file the span carried, a user's or a tool's output kept in the blob
 * store, as its pointer, in order, each once. Each tool call is one line: what the tool's own
 * `ToolDigest` says of its input and outcome, or, for a tool with none, its input as JSON and, when
 * it failed, why. A call with no result in the span is listed as not ended.
 *
 * `DigestSummarizer(digests)` is a summarizer whose summary is the digest.
 */

import { Effect } from "effect";
import type { BlobRef } from "../agent-machine/blob.ts";
import type { ToolOutcome } from "../agent-machine/observation.ts";
import type { Received } from "../agent-machine/received.ts";
import type { ContextMessage } from "../agent-session/contracts.ts";
import { asText, receivedText } from "../agent-session/received.ts";
import { blobPointer } from "../agent-session/shaping.ts";
import type { Summarizer } from "./compaction.ts";
import { SummarizerName } from "./forks.ts";

/** One tool call as a line of the digest: what was done and what came of it, in the tool's own words. */
export type ToolDigest = (input: Received, outcome: ToolOutcome | undefined) => string;

/** Each tool's digest, by its name; a tool not here gets the default line. */
export type ToolDigests = ReadonlyMap<string, ToolDigest>;

const shortened = (text: string, most = 80): string => (text.length <= most ? text : `${text.slice(0, most - 1)}…`);

/** A call's line when its tool has no digest of its own: its input, and why it failed when it did. */
const defaultDigest: ToolDigest = (input, outcome) => {
  const given = shortened(asText(input).replace(/\s+/g, " "));
  if (outcome === undefined) return `${given} (not ended)`;
  return outcome._tag === "Succeeded" ? given : `${given} (failed: ${outcome.reason._tag})`;
};

/** Every file the messages carried, by reference, in order, each once. */
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

/** The digest of `messages`; empty when they carried no file and made no tool call. */
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
