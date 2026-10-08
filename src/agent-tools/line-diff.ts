/**
 * A line diff of two texts, as a unified diff (`--- a/<path>`, `+++ b/<path>`, `@@` hunks with three
 * lines of context; an absolute path without `a/` and `b/`): what a terminal shows of a change to a
 * file, and what a tool records of it (`FileChanged`). A text that does not exist yet is
 * `undefined`, and its side is `/dev/null`.
 *
 * The diff is the longest common subsequence of the lines, from a table of `before × after` cells.
 * Above `maxCells` cells, every line of `before` is removed and every line of `after` added: a diff
 * that is correct, not the shortest.
 */

export type DiffLine = { readonly op: " " | "-" | "+"; readonly line: string };

const maxCells = 4_000_000;

/** `text`'s lines, without the empty one after a final line break. */
const linesOf = (text: string | undefined): ReadonlyArray<string> => {
  if (text === undefined || text === "") return [];
  const lines = text.split("\n");
  return lines.at(-1) === "" ? lines.slice(0, -1) : lines;
};

/** Each line of `before` and `after`, kept, removed or added, in order. */
export const lineDiff = (before: string | undefined, after: string): ReadonlyArray<DiffLine> => {
  const a = linesOf(before);
  const b = linesOf(after);
  if (a.length * b.length > maxCells) return [...a.map((line) => ({ op: "-" as const, line })), ...b.map((line) => ({ op: "+" as const, line }))];
  const width = b.length + 1;
  // common[i * width + j]: the length of the longest common subsequence of a[i..] and b[j..].
  const common = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      common[i * width + j] = a[i] === b[j] ? (common[(i + 1) * width + j + 1] ?? 0) + 1 : Math.max(common[(i + 1) * width + j] ?? 0, common[i * width + j + 1] ?? 0);
    }
  }
  const out: Array<DiffLine> = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ op: " ", line: a[i] ?? "" });
      i++;
      j++;
    } else if (i < a.length && (j === b.length || (common[(i + 1) * width + j] ?? 0) >= (common[i * width + j + 1] ?? 0))) {
      // A removed line comes before the line added in its place.
      out.push({ op: "-", line: a[i] ?? "" });
      i++;
    } else {
      out.push({ op: "+", line: b[j] ?? "" });
      j++;
    }
  }
  return out;
};

/**
 * The unified diff of `before` and `after` for the file `path`: its header and its hunks, each with up
 * to `context` unchanged lines around its changes. Empty when the texts have the same lines.
 */
export const unifiedDiff = (path: string, before: string | undefined, after: string, context = 3): ReadonlyArray<string> => {
  const lines = lineDiff(before, after);
  const changed = lines.flatMap((line, at) => (line.op === " " ? [] : [at]));
  if (changed.length === 0) return [];
  // Hunks: runs of lines within `context` of a change, joined when they touch.
  const ranges: Array<[number, number]> = [];
  for (const at of changed) {
    const start = Math.max(0, at - context);
    const end = Math.min(lines.length, at + context + 1);
    const last = ranges.at(-1);
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  }
  // A relative path is marked a/ and b/, as git marks it; an absolute path is given as it is, as diff -u gives it.
  const [a, b] = path.startsWith("/") ? ["", ""] : ["a/", "b/"];
  const header = [before === undefined ? "--- /dev/null" : `--- ${a}${path}`, `+++ ${b}${path}`];
  const hunks = ranges.flatMap(([start, end]) => {
    const preceding = lines.slice(0, start);
    const hunk = lines.slice(start, end);
    const oldStart = preceding.filter((line) => line.op !== "+").length;
    const newStart = preceding.filter((line) => line.op !== "-").length;
    const oldCount = hunk.filter((line) => line.op !== "+").length;
    const newCount = hunk.filter((line) => line.op !== "-").length;
    return [`@@ -${oldCount === 0 ? oldStart : oldStart + 1},${oldCount} +${newCount === 0 ? newStart : newStart + 1},${newCount} @@`, ...hunk.map((line) => `${line.op}${line.line}`)];
  });
  return [...header, ...hunks];
};

/**
 * The hunks of a unified diff that `unifiedDiff` made, each as the text of its old lines and the text
 * of its new lines: its context lines in both, its removed lines in the old, its added lines in the
 * new, in order, each line ending with a line break. The header is skipped.
 */
export const hunksOf = (patch: string): ReadonlyArray<{ readonly before: string; readonly after: string }> => {
  const hunks: Array<{ readonly before: Array<string>; readonly after: Array<string> }> = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      hunks.push({ before: [], after: [] });
      continue;
    }
    const hunk = hunks.at(-1);
    // Lines before the first hunk are the header; an empty line is none of a hunk's (a context line starts with a space).
    if (hunk === undefined || line === "") continue;
    if (line.startsWith("-")) hunk.before.push(line.slice(1));
    else if (line.startsWith("+")) hunk.after.push(line.slice(1));
    else {
      hunk.before.push(line.slice(1));
      hunk.after.push(line.slice(1));
    }
  }
  const text = (lines: ReadonlyArray<string>) => lines.map((line) => `${line}\n`).join("");
  return hunks.map((hunk) => ({ before: text(hunk.before), after: text(hunk.after) }));
};
