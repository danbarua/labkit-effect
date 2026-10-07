/**
 * The files a command writes text to, when its words show the text (`cat > f <<'EOF'`,
 * `echo x >> f`, `tee f <<< x`; `textsWritten` in `agent-policy/command-units.ts`), for a host to show
 * as a diff: each file's full path and the text the file will hold.
 *
 * A host reads a file's current text before the command runs (`currentOnDisk`, or through the
 * editor), and the diff is between that text and the text the command leaves (`newTextOf`). A write
 * is not shown as a diff when:
 * - a `cd`, `pushd` or `popd` comes before it in the command, which may change which file it writes;
 * - its path names another user's home folder (`~name/…`);
 * - the current text cannot be read, or the file is larger than `maxCurrentBytes`; the reason is
 *   shown, with the text the command writes.
 *
 * A file that does not exist is new: its diff adds every line. Only a read that finds no file means
 * that; a read that fails for another reason does not.
 */

import { Effect, FileSystem } from "effect";
import { join, resolve } from "node:path";
import type { ShellCommand } from "../agent-policy/command-segments.ts";
import { type Folders, textsWritten, unitsOf, type Writes } from "../agent-policy/command-units.ts";
import { segmentsOf } from "./command-parser.ts";
import { logKeys } from "./log-keys.ts";

/** The largest current text that is read for a diff: 256 KiB, as the file tools read. */
export const maxCurrentBytes = 256 * 1024;

/** A write the command makes: with the file's full path, or why it is not shown as a diff. */
export type PlannedWrite =
  | { readonly _tag: "Planned"; readonly full: string; readonly writes: Writes }
  | { readonly _tag: "NotShown"; readonly writes: Writes; readonly reason: string };

/** A file's text before the command runs: none (`Missing`, a new file), its text, or why it is not known. */
export type Current = { readonly _tag: "Missing" } | { readonly _tag: "Text"; readonly text: string } | { readonly _tag: "Unknown"; readonly reason: string };

/** The writes of `command` whose text its words show, in order, judged against `folders`. */
export const plannedWrites = (command: ShellCommand, folders: Folders): ReadonlyArray<PlannedWrite> => {
  const split = unitsOf(command, segmentsOf, folders);
  if (split._tag === "Unparsed") return [];
  return textsWritten(split.units).map(({ writes, moved }): PlannedWrite => {
    if (moved) return { _tag: "NotShown", writes, reason: "a cd earlier in the command may change which file it writes" };
    const path: string = writes.path;
    if (path.startsWith("~") && path !== "~" && !path.startsWith("~/")) return { _tag: "NotShown", writes, reason: "its path names another user's home folder" };
    return { _tag: "Planned", full: path.startsWith("~") ? join(folders.home, path.slice(1)) : resolve(folders.working, path), writes };
  });
};

/** The text the file holds after `writes`, given its `current` text. */
export const newTextOf = (current: Exclude<Current, { readonly _tag: "Unknown" }>, writes: Writes): string =>
  writes.append && current._tag === "Text" ? `${current.text}${writes.text}` : writes.text;

/** The current text of the file at `full`, read from the local disk with `fs`. A failure other than a missing file is logged and named. */
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
        : Effect.logWarning(logKeys.writes.currentUnread, { path, full, cause: error.message }).pipe(Effect.as<Current>({ _tag: "Unknown", reason: `its current text could not be read: ${error.message}` })),
    ),
  );

/** A write as a host shows it: the file's text before and after (`before` is undefined for a new file), or why no diff is shown. */
export type ShownWrite =
  | { readonly _tag: "Diff"; readonly writes: Writes; readonly full: string; readonly before: string | undefined; readonly after: string }
  | { readonly _tag: "NoDiff"; readonly writes: Writes; readonly reason: string };

/** The writes of `command` as a host shows them, reading each file's current text with `currentOf`. Run it before the command runs. */
export const shownWrites = (command: ShellCommand, folders: Folders, currentOf: (full: string, path: string) => Effect.Effect<Current>): Effect.Effect<ReadonlyArray<ShownWrite>> =>
  Effect.forEach(plannedWrites(command, folders), (planned) => {
    if (planned._tag === "NotShown") return Effect.succeed<ShownWrite>({ _tag: "NoDiff", writes: planned.writes, reason: planned.reason });
    return currentOf(planned.full, planned.writes.path).pipe(
      Effect.map((current): ShownWrite =>
        current._tag === "Unknown"
          ? { _tag: "NoDiff", writes: planned.writes, reason: current.reason }
          : { _tag: "Diff", writes: planned.writes, full: planned.full, before: current._tag === "Text" ? current.text : undefined, after: newTextOf(current, planned.writes) },
      ),
    );
  });
