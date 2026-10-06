/** What the CLI records of a session, and which stored sessions `--continue` and the `--resume` picker offer. */

import { expect } from "bun:test";
import { test } from "../../../tests/support/test.ts";
import { cliRecord, madeIn } from "./session.ts";

test("a session counts as made in a folder only when its record names the CLI and that folder", () => {
  expect(cliRecord("/work/a")).toEqual({ host: "cli", cwd: "/work/a" });
  expect(madeIn(cliRecord("/work/a"), "/work/a")).toBe(true);
  expect(madeIn(cliRecord("/work/a"), "/work/b")).toBe(false);
  expect(madeIn({ host: "acp", cwd: "/work/a" }, "/work/a")).toBe(false);
  expect(madeIn(undefined, "/work/a")).toBe(false);
});
