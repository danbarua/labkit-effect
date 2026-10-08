/**
 * `blobReads(tool)` lets `tool`, a tool that reads the text file at its `path` input (`read_file`),
 * read a blob as well: a `path` of `blob://<id>.<extension>` (`parseBlobUri`), a pointer the model
 * was given to an input's file or a tool's stored output, is read from the session's blob store as
 * UTF-8 text, with `line` and `limit` as for a file (`selectedLines`). The model is told that it may
 * pass a pointer. Refused, with the reason: a `blob://` path that is no pointer, a blob the store does
 * not hold, and bytes that are not text (not UTF-8, or holding a NUL byte). Any other path is the
 * tool's, so `blobReads` wraps the tool after `inWorkspace` has.
 */

import { Effect } from "effect";
import { Blobs, parseBlobUri } from "../agent-session/blobs.ts";
import { pathDescriptions } from "./in-workspace.ts";
import { selectedLines } from "./read-limits.ts";
import { Rejected, type Tool } from "./tool.ts";
import type { ReadFile } from "./workspace.ts";

/** Returns `bytes` as text when they are UTF-8 with no NUL byte; undefined otherwise. */
const textOf = (bytes: Uint8Array): string | undefined => {
  const decoded = Effect.runSync(Effect.option(Effect.try(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes))));
  return decoded._tag === "Some" && !decoded.value.includes("\0") ? decoded.value : undefined;
};

export const blobReads = <R>(tool: Tool<typeof ReadFile.fields, R>): Tool<typeof ReadFile.fields, R> => ({
  ...tool,
  input: tool.input.mapFields((fields) => ({ ...fields, path: fields.path.annotate({ description: `${pathDescriptions.file.replace(/\.$/, "")}, or a blob://<id>.<extension> pointer from the conversation.` }) })),
  run: (input) => {
    if (!input.path.startsWith("blob://")) return tool.run(input);
    return Effect.gen(function* () {
      const pointer = parseBlobUri(input.path);
      if (pointer === undefined) return yield* new Rejected({ problem: `${input.path} is not a blob pointer: a pointer is blob://, then 64 hex digits, then . and its extension.` });
      const bytes = yield* (yield* Blobs).read(pointer.id, pointer.extension);
      if (bytes === undefined) return yield* new Rejected({ problem: `No blob is stored for ${input.path}.` });
      const text = textOf(bytes);
      if (text === undefined) return yield* new Rejected({ problem: `${input.path} is not text: read_file reads a blob that is UTF-8 text.` });
      return yield* selectedLines(text, input.line, input.limit);
    });
  },
});
