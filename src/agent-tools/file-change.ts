/**
 * What a tool records of a file it changes (`FileChanged`, `ToolDetail`): the file's text before the
 * change, read from the local disk (`currentOnDisk`), and the change from it to the text after. A
 * command tool records the files its command writes text to (`recordingWrites`), as its host names
 * them from the command's words.
 *
 * A file that does not exist is new: only a read that finds no file means that; a read that fails
 * for another reason does not. A file larger than `maxCurrentBytes` is not read.
 */

import { Effect, FileSystem } from "effect";
import { FullPath } from "../agent-machine/names.ts";
import type { ToolDetail } from "../agent-machine/observation.ts";
import { type Fields, type Tool, withDetails } from "./tool.ts";
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

/**
 * The details of the files a command wrote, from each file's text `before` the command ran and its
 * text on the disk now. A file named twice is recorded once, from its first text before. A file
 * whose text before or now is not known records nothing.
 */
export const filesWritten = (fs: FileSystem.FileSystem, written: ReadonlyArray<{ readonly full: string; readonly before: Current }>): Effect.Effect<ReadonlyArray<ToolDetail>> => {
  const once = written.filter((each, at) => written.findIndex((other) => other.full === each.full) === at);
  return Effect.map(
    Effect.forEach(once, ({ full, before }) => Effect.map(currentOnDisk(fs, full, full), (now) => (now._tag === "Text" ? fileChanged(full, before, now.text) : []))),
    (all) => all.flat(),
  );
};

/**
 * Returns `tool`, which runs the shell command in its `command` input, recording the text files the
 * command writes (`FileChanged`). `writtenBy` returns their full paths, from the command's words.
 * Each file's text is read from the disk before the command runs and once it has run. A call that
 * fails records nothing.
 */
export const recordingWrites =
  (writtenBy: (command: string) => ReadonlyArray<string>) =>
  <F extends Fields, R>(tool: Tool<F, R>): Tool<F, R | FileSystem.FileSystem> => ({
    ...tool,
    run: (input) =>
      Effect.gen(function* () {
        const command: unknown = (input as Readonly<Record<string, unknown>>)["command"];
        const files = typeof command === "string" ? writtenBy(command) : [];
        if (files.length === 0) return yield* tool.run(input);
        const fs = yield* FileSystem.FileSystem;
        const before = yield* Effect.forEach(files, (full) => Effect.map(currentOnDisk(fs, full, full), (text) => ({ full, before: text })));
        const output = yield* tool.run(input);
        return withDetails(output, yield* filesWritten(fs, before));
      }),
  });
