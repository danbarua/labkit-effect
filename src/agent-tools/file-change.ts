/**
 * What a tool records of a file it changes (`FileChanged`, `ToolDetail`): the file's text before the
 * change, read from the local disk (`currentOnDisk`), and the change from it to the text after. A
 * host records what its tools change (`agent-host/recorded-changes.ts`).
 *
 * A file that does not exist is new: only a read that finds no file means that; a read that fails
 * for another reason does not. A file larger than `maxCurrentBytes` is not read.
 */

import { codeSpan } from "../agent-environment/code-span.ts";
import { Effect, FileSystem } from "effect";
import { ByteCount, FullPath } from "../agent-machine/names.ts";
import type { ToolDetail } from "../agent-machine/observation.ts";
import { logKeys } from "../agent-session/log-keys.ts";
import { receivedText } from "../agent-session/received.ts";
import { unifiedDiff } from "./line-diff.ts";

/** The largest current text that is read: 256 KiB, as the file tools read. */
export const maxCurrentBytes = 256 * 1024;

/** The largest patch that is kept whole: 32 KiB. A larger one is cut at the end of a line, and the bytes left out are recorded (`FileChanged`'s `cut`); git shows a large diff whole. */
export const maxPatchBytes = 32 * 1024;

/** `text` cut to its first lines that fit in `maxPatchBytes`, and the number of bytes left out after them. */
const keptOf = (text: string): { readonly kept: string; readonly cut: number } => {
  const total = Buffer.byteLength(text);
  if (total <= maxPatchBytes) return { kept: text, cut: 0 };
  const lines = text.split("\n");
  const fits = lines.reduce<{ readonly bytes: number; readonly count: number; readonly full: boolean }>(
    (sofar, line) => {
      const bytes = sofar.bytes + Buffer.byteLength(line) + 1;
      return sofar.full || bytes > maxPatchBytes ? { ...sofar, full: true } : { bytes, count: sofar.count + 1, full: false };
    },
    { bytes: 0, count: 0, full: false },
  );
  const kept = lines
    .slice(0, fits.count)
    .map((line) => `${line}\n`)
    .join("");
  return { kept, cut: total - Buffer.byteLength(kept) };
};

/** What a display says of a `FileMoved`: one line, with the paths as Markdown code spans. */
export const movedLine = (detail: Extract<ToolDetail, { readonly _tag: "FileMoved" }>): string =>
  `Moved ${codeSpan(detail.from)} to ${codeSpan(detail.to)}${detail.replaced === true ? ", replacing what was there" : ""}.`;

/** What a display says of a `FileWritten`: one line, with the path as a Markdown code span. */
export const writtenLine = (detail: Extract<ToolDetail, { readonly _tag: "FileWritten" }>): string =>
  detail.before === undefined
    ? `Wrote ${detail.bytes} bytes to ${codeSpan(detail.path)}, which git ignores.`
    : `Wrote to ${codeSpan(detail.path)}, which git ignores: ${detail.bytes} bytes, ${detail.before} before.`;

/** What a display says of a `FileChanged` whose patch was cut; undefined when it was kept whole. */
export const patchCutNote = (detail: Extract<ToolDetail, { readonly _tag: "FileChanged" }>): string | undefined =>
  detail.cut === undefined ? undefined : `The diff of ${detail.path} was cut at ${maxPatchBytes / 1024} KiB: ${detail.cut} more bytes are not shown.`;

/** A patch as `FileChanged` holds it: cut to `maxPatchBytes`, with the bytes left out when it is cut. */
const patchOf = (text: string): { readonly patch: ReturnType<typeof receivedText>; readonly cut?: ByteCount } => {
  const { kept, cut } = keptOf(text);
  return { patch: receivedText(kept), ...(cut === 0 ? {} : { cut: ByteCount.make(cut) }) };
};

/** A file's text before a change: none (`Missing`, a new file), its text, or why it is not known. */
export type Current = { readonly _tag: "Missing" } | { readonly _tag: "Text"; readonly text: string } | { readonly _tag: "Unknown"; readonly reason: string };

/** The current text of the file at `full`, read from the local disk with `fs`; `path` is the path as given, for the log. A failure other than a missing file is logged and named. */
export const currentOnDisk = (fs: FileSystem.FileSystem, full: string, path: string): Effect.Effect<Current> =>
  Effect.gen(function* () {
    const info = yield* fs.stat(full);
    if (info.type !== "File") return { _tag: "Unknown", reason: "it is not a file" } satisfies Current;
    if (info.size > BigInt(maxCurrentBytes)) return { _tag: "Unknown", reason: `it is larger than ${maxCurrentBytes / 1024} KiB` } satisfies Current;
    return { _tag: "Text", text: yield* fs.readFileString(full) } satisfies Current;
  }).pipe(
    Effect.catch((error) =>
      error.reason._tag === "NotFound"
        ? Effect.succeed<Current>({ _tag: "Missing" })
        : Effect.logWarning(logKeys.tools.currentUnread, { path, full, cause: error.message }).pipe(Effect.as<Current>({ _tag: "Unknown", reason: `its current text could not be read: ${error.message}` })),
    ),
  );

/**
 * The details of changing the file at `full` from `before` to `after`: the file created (from
 * `Missing`) with its whole text, or updated with a unified diff, each cut to `maxPatchBytes`. None
 * when the text is the same, and none when `before` is not known, since what changed is not known.
 */
export const fileChanged = (full: string, before: Current, after: string): ReadonlyArray<ToolDetail> => {
  if (before._tag === "Unknown" || (before._tag === "Text" && before.text === after)) return [];
  const path = FullPath.make(full);
  if (before._tag === "Missing") return [{ _tag: "FileChanged", path, change: "created", ...patchOf(after) }];
  return [{ _tag: "FileChanged", path, change: "updated", ...patchOf(unifiedDiff(full, before.text, after).join("\n")) }];
};
