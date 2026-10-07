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

import type { Detail } from "../agent-policy/command-units.ts";

const fenced = (language: string, code: string): ReadonlyArray<string> => {
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [`${fence}${language}`, ...code.split("\n"), fence];
};

/** `detail` as Markdown lines. */
export const markdownOf = (detail: Detail): ReadonlyArray<string> =>
  detail._tag === "Code"
    ? fenced(detail.language, detail.code)
    : detail.lines.map((line) => (line.depth === 0 ? line.text : `${"  ".repeat(line.depth - 1)}- ${line.text}`));

/** `detail` as plain lines, for a terminal. */
export const terminalOf = (detail: Detail): ReadonlyArray<string> =>
  detail._tag === "Code" ? fenced(detail.language, detail.code) : detail.lines.map((line) => `${"  ".repeat(line.depth)}${line.text}`);
