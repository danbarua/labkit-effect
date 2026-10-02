/** The workspace tools, run on a folder made for the test. */

import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { runTest } from "../../tests/support/run.ts";
import { test } from "../../tests/support/test.ts";
import { CallId, ToolName } from "../agent-machine/names.ts";
import { ToolRunner } from "../agent-session/contracts.ts";
import { asText, receivedJson } from "../agent-session/received.ts";
import { workspaceTools } from "./workspace.ts";

const root = mkdtempSync(join(tmpdir(), "workspace-"));
mkdirSync(join(root, "src"));
writeFileSync(join(root, "src", "a.txt"), "one\ntwo\nthree\nfour");
writeFileSync(join(root, "big.txt"), "x".repeat(300 * 1024));

const { catalog, runner } = workspaceTools(root);

/** What a call of `tool` with `input` gives: its output, or its failure. */
const call = (tool: string, input: unknown) =>
  runTest(
    Effect.gen(function* () {
      const outcome = yield* (yield* ToolRunner).run(ToolName.make(tool), receivedJson(input as never), CallId.make("call-1"));
      if (outcome._tag === "Succeeded") return asText(outcome.output);
      const reason = outcome.reason;
      return reason._tag === "InputRejected" ? `rejected: ${reason.problem}` : reason._tag === "Reported" ? `reported: ${asText(reason.error)}` : reason._tag;
    }).pipe(Effect.provide(runner.pipe(Layer.provide(BunServices.layer)))),
  );

test("the catalog is read_file, list_dir and write_file, each with its kind", () => {
  expect(catalog.map((tool) => [tool.name as string, tool.kind])).toEqual([["read_file", "read"], ["list_dir", "search"], ["write_file", "edit"]]);
});

test("list_dir lists one folder, a folder's name ending with /", async () => {
  expect(await call("list_dir", { path: "." })).toBe("big.txt\nsrc/");
  expect(await call("list_dir", { path: "src" })).toBe("a.txt");
});

test("read_file reads a file, or the lines asked for", async () => {
  expect(await call("read_file", { path: "src/a.txt" })).toBe("one\ntwo\nthree\nfour");
  expect(await call("read_file", { path: "src/a.txt", line: 2, limit: 2 })).toBe("two\nthree");
});

test("a call that cannot run says why", async () => {
  expect(await call("read_file", { path: "../outside.txt" })).toStartWith("rejected: ../outside.txt is not inside the workspace");
  expect(await call("read_file", { path: "/etc/hosts" })).toStartWith("rejected: /etc/hosts is not inside the workspace");
  expect(await call("read_file", { path: "missing.txt" })).toStartWith("reported: missing.txt:");
  expect(await call("read_file", { path: "big.txt" })).toBe('rejected: The result is over 256 KiB. Read fewer lines: {"path":"big.txt","line":1,"limit":100}.');
  expect(await call("read_file", { line: 1 })).toStartWith("rejected: read_file does not take this input:");
  expect(await call("delete_file", { path: "a" })).toBe("NotFound");
});

test("write_file creates or replaces a file inside the workspace, whose folder exists", async () => {
  expect(await call("write_file", { path: "src/b.txt", text: "hello" })).toBe("Wrote 5 bytes to src/b.txt.");
  expect(await call("read_file", { path: "src/b.txt" })).toBe("hello");
  expect(await call("write_file", { path: "../escape.txt", text: "x" })).toStartWith("rejected: ../escape.txt is not inside the workspace");
  expect(await call("write_file", { path: "nowhere/c.txt", text: "x" })).toStartWith("reported: nowhere/c.txt:");
});
