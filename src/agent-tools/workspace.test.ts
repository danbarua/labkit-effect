/** The workspace tools, run on a folder made for the test. */

import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("the catalog is read_file, list_dir, write_file, edit_file and run_command, each with its kind", () => {
  expect(catalog.map((tool) => [tool.name as string, tool.kind, tool.replay])).toEqual([
    ["read_file", "read", "safe"],
    ["list_dir", "search", "safe"],
    ["write_file", "edit", "idempotent"],
    ["edit_file", "edit", "unsafe"],
    ["run_command", "execute", "unsafe"],
  ]);
});

test("edit_file replaces the one occurrence of a text; one that occurs never or more than once is refused, and nothing is written", async () => {
  writeFileSync(join(root, "src", "e.txt"), "alpha and a");
  expect(await call("edit_file", { path: "src/e.txt", old_text: "alpha", new_text: "beta" })).toBe("Edited src/e.txt.");
  expect(await call("read_file", { path: "src/e.txt" })).toBe("beta and a");
  expect(await call("edit_file", { path: "src/e.txt", old_text: "a", new_text: "b" })).toBe("rejected: old_text occurs 3 times in src/e.txt; include more of the lines around it so that it occurs once.");
  expect(await call("edit_file", { path: "src/e.txt", old_text: "gamma", new_text: "b" })).toBe("rejected: old_text does not occur in src/e.txt.");
  expect(await call("read_file", { path: "src/e.txt" })).toBe("beta and a");
  // The other tests list src: the file goes.
  rmSync(join(root, "src", "e.txt"));
});

test("run_command runs sh -c in the workspace: exit 0 succeeds with the output; any other exit fails with it; past its time it is stopped", async () => {
  expect(await call("run_command", { command: "ls src | head -1" })).toBe("a.txt\n[Exit code 0.]");
  expect(await call("run_command", { command: "echo out; echo err >&2; exit 3" })).toBe("reported: out\nerr\n[Exit code 3.]");
  expect(await call("run_command", { command: "sleep 5", timeout_seconds: 1 })).toBe("reported: [Still running after 1 seconds: stopped.]");
});

/** Whether process `pid` is running. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("run_command is a process group: stopped at its time, what it started is stopped too; ended by itself, what it left in the background runs on", async () => {
  const stopped = await call("run_command", { command: "sleep 30 & echo $! > stopped.pid; wait", timeout_seconds: 1 });
  expect(stopped).toBe("reported: [Still running after 1 seconds: stopped.]");
  const orphan = Number(readFileSync(join(root, "stopped.pid"), "utf8"));
  await Bun.sleep(100);
  expect(alive(orphan)).toBe(false);
  const ran = await call("run_command", { command: "nohup sleep 30 > /dev/null 2>&1 & echo $!" });
  const server = Number(ran.split("\n")[0]);
  expect(alive(server)).toBe(true);
  process.kill(server, "SIGKILL");
  rmSync(join(root, "stopped.pid"));
});

test("run_command keeps the last 256 KiB of a long output, read as it comes", async () => {
  const output = await call("run_command", { command: "head -c 600000 /dev/zero | tr '\\0' x; echo; echo end" });
  expect(output).toStartWith("[The output's beginning was cut: its last 256 KiB follow.]\n");
  expect(output).toEndWith("x\nend\n[Exit code 0.]");
  expect(Buffer.byteLength(output)).toBeLessThan(256 * 1024 + 200);
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
