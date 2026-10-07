/** Trusted folders: the folders whose own files the agent reads, listed in the user's configuration folder. */

import { expect } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { runTest } from "../../tests/support/run.ts";
import { test, testFolder } from "../../tests/support/test.ts";
import { isTrusted, isWithin, trustedFoldersIn, trustFileOf, trustFolder } from "./trust.ts";

const user = () => join(testFolder(), "config");
const folder = (name: string): string => {
  const path = join(testFolder(), name);
  mkdirSync(path, { recursive: true });
  return path;
};
const listing = (folders: ReadonlyArray<string>) => {
  mkdirSync(user(), { recursive: true });
  writeFileSync(trustFileOf(user()), JSON.stringify({ folders }));
};
const trusted = (path: string) => runTest(isTrusted(path, user()).pipe(Effect.provide(BunServices.layer)));
const refusal = () => runTest(trustedFoldersIn(user()).pipe(Effect.flip, Effect.map((error) => error.message), Effect.provide(BunServices.layer)));

test("with no list of trusted folders no folder is trusted; a folder listed is trusted with every folder inside it, and a folder whose name only starts the same way is not", async () => {
  const work = folder("work");
  expect(await trusted(work)).toBe(false);
  listing([work]);
  expect(await trusted(work)).toBe(true);
  expect(await trusted(folder("work/inside/deeper"))).toBe(true);
  expect(await trusted(folder("workshop"))).toBe(false);
  expect(await trusted(testFolder())).toBe(false);
  expect([isWithin("/a/b", "/a"), isWithin("/a", "/a"), isWithin("/ab", "/a"), isWithin("/a/..b", "/a")]).toEqual([true, true, false, true]);
});

test("folders are compared by their real paths: a link to a trusted folder is trusted, and so is a folder listed through a link", async () => {
  const real = folder("real");
  symlinkSync(real, join(testFolder(), "link"));
  listing([real]);
  expect(await trusted(join(testFolder(), "link"))).toBe(true);
  listing([join(testFolder(), "link")]);
  expect(await trusted(real)).toBe(true);
});

test("trusting a folder lists its real path, making the user's folder when there is none; the folders already listed stay in order, and a folder is not listed twice", async () => {
  const first = folder("first");
  const second = folder("second");
  symlinkSync(second, join(testFolder(), "second-link"));
  const trust = (path: string) => runTest(trustFolder(path, user()).pipe(Effect.provide(BunServices.layer)));
  await trust(first);
  await trust(join(testFolder(), "second-link"));
  await trust(first);
  const listed = JSON.parse(readFileSync(trustFileOf(user()), "utf8")).folders;
  expect(listed).toEqual([realpathSync(first), realpathSync(second)]);
  expect(await trusted(second)).toBe(true);
});

test("a list of trusted folders that is not JSON, that does not hold a list of folders, or that names a relative path is refused, naming the file", async () => {
  mkdirSync(user(), { recursive: true });
  writeFileSync(trustFileOf(user()), "folders: [a]\n");
  expect(await refusal()).toStartWith(`${trustFileOf(user())}: Not JSON:`);
  writeFileSync(trustFileOf(user()), JSON.stringify(["/a"]));
  expect(await refusal()).toBe(`${trustFileOf(user())}: Expected { "folders": [...] }, a list of folders.`);
  listing(["relative/folder"]);
  expect(await refusal()).toBe(`${trustFileOf(user())}: Not an absolute path: relative/folder`);
});
