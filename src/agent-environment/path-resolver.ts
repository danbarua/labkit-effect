/**
 * Where a path that a command names leads: the one place a path as written becomes a full path, so
 * that every check of a path (outside the working folder, a path rule) resolves it the same way.
 *
 * | Path as written | Resolves to |
 * | --- | --- |
 * | `/abs/path` | itself, with `.` and `..` resolved |
 * | `~`, `~/path` | from the home folder |
 * | `path`, `../path` | from the working folder |
 * | `~name/path` | not resolved: another user's home folder |
 * | `"$DIR"/x`, `$(pwd)` | not resolved: not written out |
 *
 * A resolved path is inside when it is the working folder or an additional folder, or under one. Without folders, a relative
 * path is inside unless its `..` climb above its start, and an absolute path or one from `~` is
 * outside, with no full path to match rules against.
 *
 * Later, virtual URLs resolve here too, from a registry of schemes: `tmp://` (the session's own
 * temporary folder), `mcp://server/resource`, `blob://`.
 */

import { type Word, WordText } from "./command-segments.ts";
import type { Folders } from "./command-units.ts";

type Text = Parameters<typeof WordText.make>[0];

/** Where a path leads: a local path, full and absolute when the folders are known, or why it is not resolved. */
export type ResolvedPath =
  | { readonly _tag: "Local"; readonly full: WordText | undefined; readonly inside: boolean }
  | { readonly _tag: "Unresolved"; readonly why: "not written out" | "another user's home folder" };

/** `path`'s parts with `.` and `..` resolved; a relative path that climbs above its start keeps its leading `..`. */
export const normalised = (path: Text): ReadonlyArray<WordText> =>
  path.split("/").reduce<ReadonlyArray<WordText>>((parts, part) => {
    if (part === "" || part === ".") return parts;
    if (part === ".." && parts.length > 0 && parts.at(-1) !== WordText.make("..")) return parts.slice(0, -1);
    return part === ".." && path.startsWith("/") ? parts : [...parts, WordText.make(part)];
  }, []);

const isUnder = (path: ReadonlyArray<WordText>, folder: ReadonlyArray<WordText>): boolean => path.length >= folder.length && folder.every((part, at) => path[at] === part);

/** Resolves `word`, a path as a command writes it, against `folders`: a relative path from `from` (the working folder unless a `cd` moved), inside judged against the working folder and the additional ones. */
export const resolvePath = (word: Word, folders: Folders | undefined, from?: WordText): ResolvedPath => {
  if (word.literal === undefined && /[$`]/.test(word.text)) return { _tag: "Unresolved", why: "not written out" };
  const value = word.literal ?? word.text;
  const fromHome = value === "~" || value.startsWith("~/");
  if (value.startsWith("~") && !fromHome) return { _tag: "Unresolved", why: "another user's home folder" };
  if (folders === undefined) return { _tag: "Local", full: undefined, inside: !(fromHome || value.startsWith("/")) && normalised(value)[0] !== WordText.make("..") };
  const absolute = fromHome ? `${folders.home}${value.slice(1)}` : value.startsWith("/") ? value : `${from ?? folders.working}/${value}`;
  const parts = normalised(absolute);
  const inside = [folders.working, ...(folders.additional ?? [])].some((folder) => isUnder(parts, normalised(folder)));
  return { _tag: "Local", full: WordText.make(`/${parts.join("/")}`), inside };
};

/** Whether `word` may lead outside the working folder: a path outside it, or one that is not resolved. */
export const leavesFolder = (word: Word, folders: Folders | undefined, from?: WordText): boolean => {
  const resolved = resolvePath(word, folders, from);
  return resolved._tag === "Unresolved" || !resolved.inside;
};
