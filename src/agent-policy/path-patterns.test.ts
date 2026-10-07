/** Path patterns matched as gitignore matches them, checked against git itself; their roots; and the folders whose change reaches them. */

import { expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, testFolder } from "../../tests/support/test.ts";
import { WordText } from "./command-segments.ts";
import { changeReaches, matchesPath, parsePathPattern } from "./path-patterns.ts";

const folders = { working: WordText.make("/home/someone/project"), home: WordText.make("/home/someone") };
const matches = (pattern: string, path: string): boolean => {
  const parsed = parsePathPattern(pattern);
  if (parsed === undefined) throw new Error(`${pattern} is not a pattern`);
  return matchesPath(parsed, WordText.make(path), folders);
};

const patterns = [".env", "*.pem", "build", "src/**", "**/secrets", "a/**/b", "docs/*.md", "**", "x?z", "[ab]c", "[!a]c", "lib/**/*.ts", "a**b", "deep/x/"];
const paths = [".env", "a/.env", "a/.env/inner", "key.pem", "a/b/key.pem", "build", "build/out.txt", "a/build", "src", "src/a.ts", "src/x/y.ts", "other/src/a.ts", "secrets", "x/secrets/k", "a/b", "a/x/y/b", "a/b/c", "docs/a.md", "docs/x/a.md", "top", "a/top", "xyz", "x/z", "ac", "bc", "cc", "lib/a.ts", "lib/x/a.ts", "lib/x/a.js", "axxb", "ax/xb", "deep/x", "deep/x/y"];

test("a pattern from the working folder matches the paths git ignores for the same line in a .gitignore, except that a trailing / also matches a path git takes for a file", () => {
  const folder = testFolder();
  const answers = patterns.map((pattern, at) => {
    const repository = join(folder, `case-${at}`);
    mkdirSync(repository, { recursive: true });
    Bun.spawnSync(["git", "init", "-q"], { cwd: repository });
    writeFileSync(join(repository, ".gitignore"), `${pattern}\n`);
    const checked = Bun.spawnSync(["git", "check-ignore", "--no-index", "--stdin"], { cwd: repository, stdin: Buffer.from(`${paths.join("\n")}\n`) });
    const ignored = new Set(checked.stdout.toString().split("\n").filter((line) => line !== ""));
    return paths.flatMap((path) => {
      const ours = matches(pattern, `${folders.working}/${path}`);
      return ours === ignored.has(path) ? [] : [`${pattern} ${path}: git ${ignored.has(path)}, ours ${ours}`];
    });
  });
  expect(answers.flat()).toEqual(["deep/x/ deep/x: git false, ours true"]);
});

test("// is the file system's root, ~/ the home folder, and anything else the working folder; a path outside the root does not match", () => {
  expect(matches("//tmp/**", "/tmp/labkit/x")).toBe(true);
  expect(matches("~/.ssh/**", "/home/someone/.ssh/id_rsa")).toBe(true);
  expect(matches("./.env", "/home/someone/project/a/.env")).toBe(true);
  expect(matches("src", "/home/someone/other/src")).toBe(false);
  expect(matches("~", "/home/someone/notes.md")).toBe(true);
  expect(parsePathPattern("/top")).toBeUndefined();
});

test("changing a folder reaches the anchored patterns inside it, not one that matches at any depth; a match is reached too", () => {
  const reaches = (pattern: string, path: string) => {
    const parsed = parsePathPattern(pattern);
    return parsed !== undefined && changeReaches(parsed, WordText.make(path), folders);
  };
  expect(reaches("~/.ssh/**", "/home/someone")).toBe(true);
  expect(reaches("~/.ssh/**", "/home")).toBe(true);
  expect(reaches("~/.ssh/**", "/home/someone/.ssh")).toBe(true);
  expect(reaches("~/.ssh/**", "/home/someone/Code")).toBe(false);
  expect(reaches(".env", "/home/someone/project/build")).toBe(false);
  expect(reaches(".env", "/home/someone/project/.env")).toBe(true);
});
