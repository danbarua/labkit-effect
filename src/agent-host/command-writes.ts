/**
 * The files a command writes text to, when its words show the text (`cat > f <<'EOF'`,
 * `echo x >> f`, `tee f <<< x`; `textsWritten` in `agent-policy/command-units.ts`), for a host to show
 * as a diff: each file's full path and the text the file will hold.
 *
 * A host reads a file's current text before the command runs (`currentOnDisk` in
 * `agent-tools/file-change.ts`, or through the editor), and the diff is between that text and the text the command leaves (`newTextOf`). A write
 * is not shown as a diff when:
 * - a `cd`, `pushd` or `popd` comes before it in the command, which may change which file it writes;
 * - its path names another user's home folder (`~name/…`);
 * - the current text cannot be read, or the file is larger than `maxCurrentBytes`; the reason is
 *   shown, with the text the command writes.
 *
 * A file that does not exist is new: its diff adds every line. Only a read that finds no file means
 * that; a read that fails for another reason does not.
 */

import { Effect } from "effect";
import { join, resolve } from "node:path";
import { ShellCommand } from "../agent-policy/command-segments.ts";
import { filesWritten, type Folders, textsWritten, unitsOf, type Writes } from "../agent-policy/command-units.ts";
import type { Current } from "../agent-tools/file-change.ts";
import { resolvePath } from "../agent-policy/path-resolver.ts";
import { segmentsOf } from "./command-parser.ts";

/** A write the command makes: with the file's full path, or why it is not shown as a diff. */
export type PlannedWrite =
  | { readonly _tag: "Planned"; readonly full: string; readonly writes: Writes }
  | { readonly _tag: "NotShown"; readonly writes: Writes; readonly reason: string };

/** Why a write to `path` is not resolved to a file, or its full path: a `cd` before it (`moved`) or another user's home folder leaves it unknown. */
const fullOf = (path: string, moved: boolean, folders: Folders): { readonly full: string } | { readonly reason: string } => {
  if (moved) return { reason: "a cd earlier in the command may change which file it writes" };
  if (path.startsWith("~") && path !== "~" && !path.startsWith("~/")) return { reason: "its path names another user's home folder" };
  return { full: path.startsWith("~") ? join(folders.home, path.slice(1)) : resolve(folders.working, path) };
};

/** The writes of `command` whose text its words show, in order, judged against `folders`. */
export const plannedWrites = (command: ShellCommand, folders: Folders): ReadonlyArray<PlannedWrite> => {
  const split = unitsOf(command, segmentsOf, folders);
  if (split._tag === "Unparsed") return [];
  return textsWritten(split.units).map(({ writes, moved }): PlannedWrite => {
    const found = fullOf(writes.path, moved, folders);
    return "full" in found ? { _tag: "Planned", full: found.full, writes } : { _tag: "NotShown", writes, reason: found.reason };
  });
};

/**
 * The full paths of the files that `command` writes (`filesWritten`), each once, resolved as the
 * permission policy resolves them (`resolvePath`): what a command tool records, by reading each file
 * before the command runs and after (`agent-host/recorded-changes.ts`). The text written need not be
 * in the command's words, so `sed -i` and `printf … > f` are recorded too. A write after a `cd`, to a
 * path the shell expands (`"$F"`), or to another user's home folder is not.
 */
export const writtenFiles =
  (folders: Folders) =>
  (command: string): ReadonlyArray<string> => {
    const split = unitsOf(ShellCommand.make(command), segmentsOf, folders);
    if (split._tag === "Unparsed") return [];
    return [
      ...new Set(
        filesWritten(split.units).flatMap(({ word, moved }) => {
          const resolved = moved ? undefined : resolvePath(word, folders);
          return resolved?._tag === "Local" && resolved.full !== undefined ? [resolved.full] : [];
        }),
      ),
    ];
  };

/** The text the file holds after `writes`, given its `current` text. */
export const newTextOf = (current: Exclude<Current, { readonly _tag: "Unknown" }>, writes: Writes): string =>
  writes.append && current._tag === "Text" ? `${current.text}${writes.text}` : writes.text;

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
