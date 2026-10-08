/** A line diff of two texts as a unified diff: a new file, a change in the middle, an addition at the end, and texts with the same lines. */

import { expect } from "bun:test";
import { test } from "../../tests/support/test.ts";
import { unifiedDiff } from "./line-diff.ts";

test("a new file's diff is from /dev/null, every line added", () => {
  expect(unifiedDiff("new.txt", undefined, "one\ntwo\n")).toEqual(["--- /dev/null", "+++ b/new.txt", "@@ -0,0 +1,2 @@", "+one", "+two"]);
});

test("a changed line is removed and added, with up to three unchanged lines around it; changes far apart are separate hunks", () => {
  const before = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"].join("\n");
  const after = ["a", "B", "c", "d", "e", "f", "g", "h", "i", "j", "k", "L"].join("\n");
  expect(unifiedDiff("f.txt", before, after)).toEqual(["--- a/f.txt", "+++ b/f.txt", "@@ -1,5 +1,5 @@", " a", "-b", "+B", " c", " d", " e", "@@ -9,4 +9,4 @@", " i", " j", " k", "-l", "+L"]);
});

test("lines added at the end follow the last unchanged lines; texts with the same lines have no diff", () => {
  expect(unifiedDiff("log.txt", "one\ntwo\n", "one\ntwo\nthree\n")).toEqual(["--- a/log.txt", "+++ b/log.txt", "@@ -1,2 +1,3 @@", " one", " two", "+three"]);
  expect(unifiedDiff("same.txt", "x\n", "x\n")).toEqual([]);
});
