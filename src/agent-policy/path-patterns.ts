/**
 * Path patterns, as Claude Code's `Read(...)` and `Edit(...)` rules write them, matched with
 * gitignore's rules (`permission-rules.ts`):
 *
 * | Pattern | Matches paths |
 * | --- | --- |
 * | `//abs/path` | from the root of the file system |
 * | `~/path` | from the home folder |
 * | `path`, `./path` | from the working folder |
 *
 * After its root, a pattern is matched as a line of a `.gitignore` in the root would be:
 * - `*` matches anything but `/`, `?` one character but `/`, `[...]` one of a set (`[!...]` none);
 * - `**` as a whole part matches across folders: as the first part, at any depth; as the last part,
 *   everything inside the folder before it; between two parts, any folders between them;
 * - a pattern with a `/` at its start or in its middle is anchored at the root; one without matches a
 *   file or folder of that name at any depth (`.env`, `*.pem`);
 * - a path inside a folder that matches is matched too (`build` matches `build/out.txt`);
 * - a trailing `/` is dropped: whether a path is a folder is not known before the command runs;
 * - as in Claude Code, a trailing `/**` matches the folder itself as well as what it holds
 *   (`//tmp/**` matches `/tmp`), and the pattern stays anchored (`src/**` does not match `a/src`).
 *
 * A pattern starting with a single `/` is not accepted: in Claude Code it is relative to the
 * settings file it is in, which the policy does not know. A path outside a pattern's root does not
 * match it: `src` does not match `../other/src`.
 */

import { WordText } from "./command-segments.ts";
import type { Folders } from "./command-units.ts";

/** A pattern's root: the file system's, the home folder, or the working folder. */
export type PathRoot = "absolute" | "home" | "working";

export interface PathPattern {
  readonly root: PathRoot;
  /** The pattern after its root, as gitignore reads it. */
  readonly glob: WordText;
}

type Text = Parameters<typeof WordText.make>[0];

/** Returns `text` as a pattern; undefined when it starts with a single `/`. */
export const parsePathPattern = (text: Text): PathPattern | undefined => {
  const trimmed = text.length > 1 ? text.replace(/\/+$/, "") : text;
  const everything = WordText.make("**");
  if (trimmed.startsWith("//")) return { root: "absolute", glob: trimmed.length > 2 ? WordText.make(trimmed.slice(2)) : everything };
  if (trimmed === "~" || trimmed === "~/") return { root: "home", glob: everything };
  if (trimmed.startsWith("~/")) return { root: "home", glob: WordText.make(trimmed.slice(2)) };
  if (trimmed.startsWith("/")) return undefined;
  const relative = trimmed.replace(/^(\.\/)+/, "");
  return { root: "working", glob: relative === "" || relative === "." ? everything : WordText.make(relative) };
};

/** One part of a glob (no `/`), as a regular expression: `*` and `**` within a part match anything but `/`. */
const partSource = (part: Text): Text =>
  part
    .split(/(\*+|\?|\[[^\]]+\])/)
    .map((piece) => {
      if (/^\*+$/.test(piece)) return "[^/]*";
      if (piece === "?") return "[^/]";
      if (piece.startsWith("[") && piece.endsWith("]") && piece.length > 2) return `[${piece.slice(1, -1).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
      return piece.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    })
    .join("");

/** A glob of several parts, as a regular expression over a path from the root. */
const anchoredSource = (glob: Text): Text => {
  const parts = glob.replace(/^\//, "").split("/");
  const last = parts.length - 1;
  return parts.reduce<{ readonly source: Text; readonly slash: boolean }>(
    (built, part, at) => {
      if (part !== "**") return { source: `${built.source}${built.slash ? "/" : ""}${partSource(part)}`, slash: true };
      if (at === last) return { source: `${built.source}${at === 0 ? ".*" : "/.+"}`, slash: false };
      return { source: `${built.source}${at === 0 ? "(?:.*/)?" : "/(?:.*/)?"}`, slash: false };
    },
    { source: "", slash: false },
  ).source;
};

/** Whether `relative`, a path from the pattern's root, matches `glob`: itself, or a folder it is inside. */
const globMatches = (glob: Text, relative: ReadonlyArray<Text>): boolean => {
  // A trailing `/**` matches the folder too: matched as the folder, anchored, it covers what the folder holds.
  if (glob.endsWith("/**") && glob !== "/**") return globMatches(`/${glob.slice(0, -3).replace(/^\//, "")}`, relative);
  if (!glob.replace(/\/$/, "").includes("/") && glob !== "**") {
    const part = new RegExp(`^${partSource(glob)}$`, "u");
    return relative.some((name) => part.test(name));
  }
  const whole = new RegExp(`^${anchoredSource(glob)}$`, "u");
  return relative.some((_, at) => whole.test(relative.slice(0, at + 1).join("/")));
};

/** The parts of an absolute path, with `.` and `..` resolved. */
const partsOf = (path: Text): ReadonlyArray<Text> =>
  path.split("/").reduce<ReadonlyArray<Text>>((parts, part) => {
    if (part === "" || part === ".") return parts;
    return part === ".." ? parts.slice(0, -1) : [...parts, part];
  }, []);

/** The path from `pattern`'s root to `full`, an absolute path; undefined when `full` is not under the root. */
const fromRoot = (pattern: PathPattern, full: WordText, folders: Folders): ReadonlyArray<Text> | undefined => {
  const rootParts = pattern.root === "absolute" ? [] : partsOf(pattern.root === "home" ? folders.home : folders.working);
  const parts = partsOf(full);
  if (parts.length < rootParts.length || rootParts.some((part, at) => parts[at] !== part)) return undefined;
  return parts.slice(rootParts.length);
};

/** Whether `full`, an absolute path, matches `pattern`, its roots taken from `folders`: the path itself, or a folder it is inside. */
export const matchesPath = (pattern: PathPattern, full: WordText, folders: Folders): boolean => {
  const relative = fromRoot(pattern, full, folders);
  return relative !== undefined && relative.length > 0 && globMatches(pattern.glob, relative);
};

/**
 * Whether changing `full` (deleting, moving, or changing a folder and what is in it) may change a
 * path that `pattern` matches: `full` matches, or it is a folder that holds the folder an anchored
 * pattern starts from (`rm -rf ~` holds `~/.ssh/**`). A pattern that matches at any depth (`.env`) is
 * not assumed to be in every folder.
 */
export const changeReaches = (pattern: PathPattern, full: WordText, folders: Folders): boolean => {
  if (matchesPath(pattern, full, folders)) return true;
  const glob = pattern.glob.replace(/\/$/, "");
  if (!glob.includes("/") && glob !== "**") return false;
  const base = glob.replace(/^\//, "").split("/");
  const fixed = base.slice(0, Math.max(0, base.findIndex((part) => /[*?[]/.test(part)) === -1 ? base.length : base.findIndex((part) => /[*?[]/.test(part))));
  const relative = fromRoot(pattern, full, folders);
  if (relative !== undefined) return relative.length <= fixed.length && relative.every((part, at) => fixed[at] === part);
  // `full` is above the pattern's root: it holds the root, and so all the pattern can match.
  const rootParts = pattern.root === "absolute" ? [] : partsOf(pattern.root === "home" ? folders.home : folders.working);
  const parts = partsOf(full);
  return parts.length < rootParts.length && parts.every((part, at) => rootParts[at] === part);
};
