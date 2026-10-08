/**
 * What a tool records of a file it changes (`FileChanged`, `ToolDetail`): the file's text before the
 * change, read from the local disk (`currentOnDisk`), and the change from it to the text after.
 *
 * A file that does not exist is new: only a read that finds no file means that; a read that fails
 * for another reason does not. A file larger than `maxCurrentBytes` is not read.
 */

import { Effect, FileSystem } from "effect";
import { FullPath } from "../agent-machine/names.ts";
import type { ToolDetail } from "../agent-machine/observation.ts";
import { logKeys } from "../agent-session/log-keys.ts";
import { receivedText } from "../agent-session/received.ts";
import { unifiedDiff } from "./line-diff.ts";

/** The largest current text that is read: 256 KiB, as the file tools read. */
export const maxCurrentBytes = 256 * 1024;

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
 * `Missing`) with its whole text, or updated with a unified diff. None when the text is the same, and
 * none when `before` is not known, since what changed is not known.
 */
export const fileChanged = (full: string, before: Current, after: string): ReadonlyArray<ToolDetail> => {
  if (before._tag === "Unknown" || (before._tag === "Text" && before.text === after)) return [];
  const path = FullPath.make(full);
  if (before._tag === "Missing") return [{ _tag: "FileChanged", path, change: "created", patch: receivedText(after) }];
  return [{ _tag: "FileChanged", path, change: "updated", patch: receivedText(unifiedDiff(full, before.text, after).join("\n")) }];
};
