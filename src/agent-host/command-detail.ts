/**
 * Shows a permission question's detail (`CommandNeed.detail`): what a `sed` script does, in plain
 * English, or the code that a runtime or shell is given, in its language.
 *
 * - `markdownOf` returns Markdown, for a client that renders it (ACP): an explanation's lead line,
 *   then its commands as a nested list; code in a fence that names its language.
 * - `terminalOf` returns plain lines, for the REPL: an explanation indented by depth; code in the
 *   same fence, which reads as a block in a terminal too.
 *
 * The fence is one backtick longer than the longest run of backticks in the code, so that code
 * containing a fence does not end the block early.
 */

import { codeSpan } from "../agent-policy/code-span.ts";
import type { Detail } from "../agent-policy/command-units.ts";

const fenced = (language: string, code: string): ReadonlyArray<string> => {
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [`${fence}${language}`, ...code.split("\n"), fence];
};

const expandsNote = "When the command runs, the shell replaces `$…` and `` `…` `` in this text, so what it writes may differ.";

/**
 * Text written to a file, in plain English: when a diff of the file shows it (`diffShown`), a line
 * that says so, the diff carrying any note; otherwise the text, fenced, with a note when the shell
 * expands it.
 */
const writesLines = (detail: Extract<Detail, { _tag: "Writes" }>, diffShown: boolean): ReadonlyArray<string> =>
  diffShown
    ? [`The diff shows what it ${detail.append ? "adds to" : "writes to"} ${codeSpan(detail.path)}.`]
    : [`It ${detail.append ? "adds this text to the end of" : "writes this text to"} ${codeSpan(detail.path)}:`, ...fenced("", detail.text.replace(/\n$/, "")), ...(detail.expands ? [expandsNote] : [])];

/** `detail` as Markdown lines; `diffShown` when the call already shows the file's diff, so a write is not repeated as text. */
export const markdownOf = (detail: Detail, diffShown = false): ReadonlyArray<string> => {
  if (detail._tag === "Code") return fenced(detail.language, detail.code);
  if (detail._tag === "Writes") return writesLines(detail, diffShown);
  return detail.lines.map((line) => (line.depth === 0 ? line.text : `${"  ".repeat(line.depth - 1)}- ${line.text}`));
};

/** `detail` as plain lines, for a terminal; `diffShown` as for `markdownOf`. */
export const terminalOf = (detail: Detail, diffShown = false): ReadonlyArray<string> => {
  if (detail._tag === "Code") return fenced(detail.language, detail.code);
  if (detail._tag === "Writes") return writesLines(detail, diffShown);
  return detail.lines.map((line) => `${"  ".repeat(line.depth)}${line.text}`);
};
