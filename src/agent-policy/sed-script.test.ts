/** What a sed script does besides transforming text: runs commands, writes files, reads files; or that it is not understood. */

import { expect } from "bun:test";
import { test } from "../../tests/support/test.ts";
import { analyse, explain, parse, SedFile, SedScript } from "./sed-script.ts";

const effects = (script: string): unknown => analyse(SedScript.make(script));

test("a script that only transforms text has no effects, whatever its addresses, delimiters, blocks and labels", () => {
  const plain = { executes: false, writes: [], reads: [] };
  for (const script of ["s/a/b/g", "1,10p", "/foo/d; s|a|b|2", "$!N; P; D", "1,5{p;d}", "y/abc/xyz/", "/x/I,+3!d", ":a; N; $!ba; s/\\n/ /g", "s/\\//_/g", "a appended text", "# a comment\np", "0~2d", "5q", "="]) {
    expect([script, effects(script)]).toEqual([script, plain]);
  }
});

test("e, and the e flag of s, run commands; w, W and the w flag of s write files; r and R read them, each file name running to the end of the line", () => {
  expect(effects("s/x/y/e")).toMatchObject({ executes: true });
  expect(effects("1e date")).toMatchObject({ executes: true });
  expect(effects("w out.txt")).toEqual({ executes: false, writes: ["out.txt"], reads: [] });
  expect(effects("s/a/b/gw changed;p")).toEqual({ executes: false, writes: ["changed;p"], reads: [] });
  expect(effects("/x/r /etc/hosts\np")).toEqual({ executes: false, writes: [], reads: ["/etc/hosts"] });
});

test("a script with a command that is not known, or that ends inside a command, is not understood", () => {
  for (const script of ["k", "s/a/b", "s/[/]/x/e", "{p", "y/ab/x", "p x", "w"]) expect([script, effects(script)]).toEqual([script, undefined]);
});

const explained = (script: string, options: { quiet?: boolean; inPlace?: boolean; files?: ReadonlyArray<string> } = {}): ReadonlyArray<string> => {
  const parsed = parse(SedScript.make(script));
  if (parsed === undefined) throw new Error(`${script} is not understood`);
  return explain([parsed], { quiet: options.quiet ?? false, inPlace: options.inPlace ?? false, files: (options.files ?? []).map((file) => SedFile.make(file)) }).map(
    (line) => `${"  ".repeat(line.depth)}${line.text}`,
  );
};

test("explain says what sed reads, then each command at its addresses, then that it prints every line unless it is quiet (-n)", () => {
  expect(explained("s/a/b/g", { files: ["notes.txt"] })).toEqual(["Reads notes.txt:", "  Replaces every match of `a` with `b`, on every line.", "  Prints every line, after these changes."]);
  expect(explained("/^#/d; 5q")).toEqual(["Reads its input:", "  Deletes lines matching `^#`.", "  Stops after line 5.", "  Prints every line, after these changes."]);
  expect(explained("1,10p", { quiet: true, files: ["f"] })).toEqual(["Reads f:", "  Prints lines 1 to 10."]);
});

test("explain says that sed edits its files in place with -i, and saves every line rather than printing it", () => {
  expect(explained("s/old/new/2", { inPlace: true, files: ["a.ts", "b.ts"] })).toEqual([
    "Edits a.ts, b.ts in place:",
    "  Replaces match 2 of `old` with `new`, on every line.",
    "  Saves every line, after these changes.",
  ]);
});

test("explain puts a block's commands one level deeper, applying to the block's lines; it names flags, negation and commands it does not describe", () => {
  expect(explained("/x/{s/a/b/I;p}", { quiet: true })).toEqual(["Reads its input:", "  On lines matching `x`:", "    Replaces the first match of `a` (ignoring case) with `b`, on those lines.", "    Prints those lines."]);
  expect(explained("$!N", { quiet: true })).toEqual(["Reads its input:", "  Uses `N` on every line except the last line, to join, hold or branch between lines."]);
  expect(explained("s/x/y/w out.txt", { quiet: true })).toEqual(["Reads its input:", "  Replaces the first match of `x` with `y`, on every line, and writes the lines it changes to out.txt."]);
  expect(explained("s/x/y/e", { quiet: true })).toEqual(["Reads its input:", "  Replaces the first match of `x` with `y`, on every line, then runs each changed line as a shell command."]);
});
