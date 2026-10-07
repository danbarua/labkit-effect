/** What a sed script does besides transforming text: runs commands, writes files, reads files; or that it is not understood. */

import { expect } from "bun:test";
import { test } from "../../tests/support/test.ts";
import { analyse, SedScript } from "./sed-script.ts";

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
