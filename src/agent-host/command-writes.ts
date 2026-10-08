/**
 * The files a command writes text to, when its words show the text (`cat > f <<'EOF'`,
 * `echo x >> f`, `tee f <<< x`; `textsWritten` in `agent-policy/command-units.ts`), for a host to show
 * as a diff: each file's full path and the text the file will hold.
 *
 * A host reads a file's current text before the command runs (`currentOnDisk` in
 * `agent-tools/file-change.ts`, or through the editor), and the diff is between that text and the text the command leaves (`newTextOf`). A write
 * is not shown as a diff when:
 * - its path may name more than one file, or an unknown one: a `cd` or `pushd` before it that may or
 *   may not have moved the folder it leads from, or a `popd` or `cd -` (`placesOf`);
 * - its path names another user's home folder (`~name/…`);
 * - the current text cannot be read, or the file is larger than `maxCurrentBytes`; the reason is
 *   shown, with the text the command writes.
 *
 * A file that does not exist is new: its diff adds every line. Only a read that finds no file means
 * that; a read that fails for another reason does not.
 */

import { Effect } from "effect";
import { ShellCommand, type Word } from "../agent-policy/command-segments.ts";
import { filesWritten, type Folders, type Place, placesOf, relativePath, textsWritten, unitsOf, type Writes } from "../agent-policy/command-units.ts";
import type { Current } from "../agent-tools/file-change.ts";
import { resolvePath } from "../agent-policy/path-resolver.ts";
import { segmentsOf } from "./command-parser.ts";

/** A write the command makes: with the file's full path, or why it is not shown as a diff. */
export type PlannedWrite =
  | { readonly _tag: "Planned"; readonly full: string; readonly writes: Writes }
  | { readonly _tag: "NotShown"; readonly writes: Writes; readonly reason: string };

/**
 * The full paths `word`, written by the unit at `at`, may name: one for each folder a relative path
 * may lead from there (`placesOf`); none when that is not known, the shell expands the word, or it
 * names another user's home folder.
 */
const fullsOf = (word: Word, place: Place | undefined, folders: Folders): ReadonlyArray<string> => {
  if (place === undefined || (relativePath(word) && place.unknown)) return [];
  return (relativePath(word) ? place.bases : [undefined]).flatMap((base) => {
    const resolved = resolvePath(word, folders, base);
    return resolved._tag === "Local" && resolved.full !== undefined ? [resolved.full] : [];
  });
};

/**
 * The writes of `command` whose text its words show, in order, judged against `folders`. A write is
 * shown as a diff only when its path names one file: not after a `cd` that may or may not have moved
 * the folder it leads from, nor to another user's home folder.
 */
export const plannedWrites = (command: ShellCommand, folders: Folders): ReadonlyArray<PlannedWrite> => {
  const split = unitsOf(command, segmentsOf, folders);
  if (split._tag === "Unparsed") return [];
  const places = placesOf(split.units, folders);
  return textsWritten(split.units).map(({ writes, at }): PlannedWrite => {
    const word: Word = { text: writes.path, literal: writes.path };
    if (resolvePath(word, folders)._tag === "Unresolved") return { _tag: "NotShown", writes, reason: "its path names another user's home folder" };
    const fulls = fullsOf(word, places[at], folders);
    const [full] = fulls;
    return fulls.length === 1 && full !== undefined ? { _tag: "Planned", full, writes } : { _tag: "NotShown", writes, reason: "a cd earlier in the command may change which file it writes" };
  });
};

/**
 * The full paths of the files whose text `command` writes (`filesWritten`), each once: what a command
 * tool records, by reading each file before the command runs and after
 * (`agent-host/recorded-changes.ts`). The text need not be in the command's words, so `sed -i` and
 * `printf … > f` are recorded too. After a `cd` that may or may not have moved, a relative path names
 * a file in each folder it may lead from, and each is read: only a file that changed is recorded. A
 * path the shell expands (`"$F"`), or one after a move that cannot be followed (`popd`, `cd -`), is
 * not recorded.
 */
export const writtenFiles =
  (folders: Folders) =>
  (command: string): ReadonlyArray<string> => {
    const split = unitsOf(ShellCommand.make(command), segmentsOf, folders);
    if (split._tag === "Unparsed") return [];
    const places = placesOf(split.units, folders);
    return [...new Set(filesWritten(split.units).flatMap(({ word, at }) => fullsOf(word, places[at], folders)))];
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
