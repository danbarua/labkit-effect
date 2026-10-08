/** The workspace tools, run on a folder made for the test. */

import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { runTest } from "../../tests/support/run.ts";
import { test } from "../../tests/support/test.ts";
import { undescribedInputs } from "../../tests/support/tool-input.ts";
import { CallId, ToolName } from "../agent-machine/names.ts";
import { ToolRunner } from "../agent-session/contracts.ts";
import { asText, receivedJson } from "../agent-session/received.ts";
import { Blobs, BlobsInMemory, blobUriOf } from "../agent-session/blobs.ts";
import { MediaType } from "../agent-machine/received.ts";
import { workspaceTools } from "./workspace.ts";

const root = mkdtempSync(join(tmpdir(), "workspace-"));
mkdirSync(join(root, "src"));
writeFileSync(join(root, "src", "a.txt"), "one\ntwo\nthree\nfour");
writeFileSync(join(root, "big.txt"), "x".repeat(300 * 1024));

const { catalog, source, system } = workspaceTools(root);
const runner = Layer.effect(ToolRunner, source);

/** What a call of `tool` with `input` and an intent gives: its output, or its failure. */
const call = (tool: string, input: object) =>
  runTest(
    Effect.gen(function* () {
      const outcome = yield* (yield* ToolRunner).run(ToolName.make(tool), receivedJson({ intent: "A test call.", ...input } as never), CallId.make("call-1"));
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

test("the system text names the folder as the working folder, and no tool's description or input schema names it", () => {
  expect(system).toBe(`The working folder is ${root}.`);
  expect(catalog.filter((tool) => JSON.stringify([tool.description, tool.input]).includes(root))).toEqual([]);
});

test("a tool's input schema is its Schema's with a description for each input, closed to other properties; a call with another property runs without it and says so, or, with strictInput, is refused", async () => {
  expect(catalog.find((tool) => tool.name === "read_file")?.input).toEqual({
    type: "object",
    properties: {
      path: { type: "string", minLength: 1, description: "The file's path: relative to the working folder, or absolute, or a blob://<id>.<extension> pointer from the conversation." },
      line: { type: "integer", minimum: 1, description: "Optional: the first line to read, 1-based. Default: 1." },
      limit: { type: "integer", minimum: 1, description: "Optional: the number of lines to read. Default: to the end of the file." },
      intent: { type: "string", minLength: 1, description: "What this call is for, in one sentence. The user sees it as the call's title." },
    },
    required: ["path", "intent"],
    additionalProperties: false,
  });
  expect(catalog.flatMap((tool) => undescribedInputs(tool.input).map((input) => `${tool.name}: ${input}`))).toEqual([]);
  expect(catalog.find((tool) => tool.name === "run_command")?.input).toMatchObject({ properties: { timeout_seconds: { minimum: 1, maximum: 600 } } });
  expect(await call("read_file", { path: "src/a.txt", lines: 2, extra: { a: 1 } })).toBe("one\ntwo\nthree\nfour\n[Not inputs of read_file, so ignored: lines, extra.]");
  const strict = workspaceTools(root, { strictInput: true });
  const refused = await runTest(
    Effect.gen(function* () {
      const outcome = yield* (yield* ToolRunner).run(ToolName.make("read_file"), receivedJson({ path: "src/a.txt", lines: 2, intent: "A test call." }), CallId.make("call-1"));
      return outcome._tag === "Failed" && outcome.reason._tag === "InputRejected" ? outcome.reason.problem : "not refused";
    }).pipe(Effect.provide(Layer.effect(ToolRunner, strict.source).pipe(Layer.provide(BunServices.layer)))),
  );
  expect(refused).toStartWith("read_file does not take this input: Expected no excess property");
});

test("edit_file replaces the one occurrence of a text; one that occurs never or more than once is refused, and nothing is written", async () => {
  writeFileSync(join(root, "src", "e.txt"), "alpha and a");
  expect(await call("edit_file", { path: "src/e.txt", old_text: "alpha", new_text: "beta" })).toBe(`Edited ${root}/src/e.txt.`);
  expect(await call("read_file", { path: "src/e.txt" })).toBe("beta and a");
  expect(await call("edit_file", { path: "src/e.txt", old_text: "a", new_text: "b" })).toBe(`rejected: old_text occurs 3 times in ${root}/src/e.txt; include more of the lines around it so that it occurs once.`);
  expect(await call("edit_file", { path: "src/e.txt", old_text: "gamma", new_text: "b" })).toBe(`rejected: old_text does not occur in ${root}/src/e.txt.`);
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

test("run_command cuts a long output at a character boundary: a cut that would split a multi-byte character starts after it", async () => {
  // 140,000 two-byte characters and a newline: 280,001 bytes. Keeping the last 262,144 bytes would start
  // inside a character, so the kept text starts at the next character instead.
  const output = await call("run_command", { command: `awk 'BEGIN { for (i = 0; i < 140000; i++) printf "é"; print "" }'` });
  const kept = output.slice("[The output's beginning was cut: its last 256 KiB follow.]\n".length);
  expect(output).toStartWith("[The output's beginning was cut: its last 256 KiB follow.]\n");
  expect(kept).toStartWith("éé");
  expect(output).not.toContain("\uFFFD");
});

test("list_dir lists one folder, a folder's name ending with /", async () => {
  expect(await call("list_dir", { path: "." })).toBe("big.txt\nsrc/");
  expect(await call("list_dir", { path: "src" })).toBe("a.txt");
});

test("read_file reads a file, or the lines asked for", async () => {
  expect(await call("read_file", { path: "src/a.txt" })).toBe("one\ntwo\nthree\nfour");
  expect(await call("read_file", { path: "src/a.txt", line: 2, limit: 2 })).toBe("two\nthree");
});

test("a call that cannot run says why: a missing file, a result over 256 KiB, input that does not fit, or no such tool; a path outside the working folder is the permission policy's to judge, not the tool's", async () => {
  expect(await call("read_file", { path: "../missing-outside.txt" })).toStartWith(`reported: ${resolve(root, "../missing-outside.txt")}:`);
  expect(await call("read_file", { path: "missing.txt" })).toStartWith(`reported: ${root}/missing.txt:`);
  expect(await call("read_file", { path: "big.txt" })).toBe("rejected: The result is over 256 KiB. Read fewer lines, for example line 1 and limit 100.");
  expect(await call("read_file", { line: 1 })).toStartWith("rejected: read_file does not take this input:");
  expect(await call("delete_file", { path: "a" })).toBe("NotFound");
});

/** The details a call of `tool` with `input` records of what it did; undefined when it records none or fails. */
const detailsOf = (tool: string, input: object) =>
  runTest(
    Effect.gen(function* () {
      const outcome = yield* (yield* ToolRunner).run(ToolName.make(tool), receivedJson({ intent: "A test call.", ...input } as never), CallId.make("call-1"));
      return outcome._tag === "Succeeded" ? outcome.details?.map((detail) => ({ ...detail, patch: asText(detail.patch) })) : undefined;
    }).pipe(Effect.provide(runner.pipe(Layer.provide(BunServices.layer)))),
  );

test("write_file and edit_file record what they changed: a file created, with its text; a file updated, with a unified diff; nothing when the text is the same", async () => {
  const full = `${root}/src/d.txt`;
  expect((await detailsOf("write_file", { path: "src/d.txt", text: "one\ntwo\n" })) as unknown).toEqual([{ _tag: "FileChanged", path: full, change: "created", patch: "one\ntwo\n" }]);
  expect((await detailsOf("edit_file", { path: "src/d.txt", old_text: "two", new_text: "three" })) as unknown).toEqual([
    { _tag: "FileChanged", path: full, change: "updated", patch: [`--- ${full}`, `+++ ${full}`, "@@ -1,2 +1,2 @@", " one", "-two", "+three"].join("\n") },
  ]);
  expect(await detailsOf("write_file", { path: "src/d.txt", text: "one\nthree\n" })).toBeUndefined();
});

test("a patch over 32 KiB is kept to its first lines that fit, and the bytes left out are recorded", async () => {
  const line = `${"x".repeat(99)}\n`;
  const text = line.repeat(400);
  const details = (await detailsOf("write_file", { path: "src/big.txt", text })) ?? [];
  expect(details.map((detail) => ({ change: detail.change, kept: Buffer.byteLength(detail.patch), cut: detail.cut })) as unknown).toEqual([{ change: "created", kept: 327 * 100, cut: 73 * 100 }]);
  expect(details[0]?.patch.endsWith(line)).toBe(true);
});

test("with writtenBy, run_command records each file its command writes, from its text before the command ran and after; a failed command records nothing", async () => {
  const full = join(root, "src", "w.txt");
  writeFileSync(full, "old\n");
  const recording = workspaceTools(root, { writtenBy: (command) => (command.includes("w.txt") ? [full, full] : []) });
  const ran = (command: string) =>
    runTest(
      Effect.gen(function* () {
        const outcome = yield* (yield* ToolRunner).run(ToolName.make("run_command"), receivedJson({ intent: "A test call.", command } as never), CallId.make("call-1"));
        return outcome._tag === "Succeeded" ? (outcome.details ?? []).map((detail) => ({ ...detail, patch: asText(detail.patch) })) : outcome.reason._tag;
      }).pipe(Effect.provide(Layer.effect(ToolRunner, recording.source).pipe(Layer.provide(BunServices.layer)))),
    );
  // The file is named twice, and recorded once.
  expect((await ran("echo new > src/w.txt")) as unknown).toEqual([
    { _tag: "FileChanged", path: full, change: "updated", patch: [`--- ${full}`, `+++ ${full}`, "@@ -1,1 +1,1 @@", "-old", "+new"].join("\n") },
  ]);
  expect(await ran("echo again > src/w.txt; exit 1")).toBe("Reported");
  expect(await ran("echo hi")).toEqual([]);
});

test("read_file reads a blob:// pointer from the blob store as text, with line and limit; a pointer to bytes that are not text, to no blob, or that is no pointer is refused", async () => {
  const read = (paths: ReadonlyArray<{ readonly path: string; readonly line?: number; readonly limit?: number }>) =>
    runTest(
      Effect.gen(function* () {
        const blobs = yield* Blobs;
        const csv = yield* blobs.store(new TextEncoder().encode("a,b\n1,2\n3,4\n"), MediaType.make("text/csv"), "runs.csv");
        const png = yield* blobs.store(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]), MediaType.make("image/png"));
        const pointers: Readonly<Record<string, string>> = { csv: blobUriOf(csv.id, csv.mediaType), png: blobUriOf(png.id, png.mediaType) };
        return yield* Effect.forEach(paths, (input) =>
          Effect.gen(function* () {
            const outcome = yield* (yield* ToolRunner).run(ToolName.make("read_file"), receivedJson({ intent: "A test call.", ...input, path: pointers[input.path] ?? input.path } as never), CallId.make("call-1"));
            if (outcome._tag === "Succeeded") return asText(outcome.output);
            return outcome.reason._tag === "InputRejected" ? `rejected: ${outcome.reason.problem}` : outcome.reason._tag;
          }),
        );
      }).pipe(Effect.provide(Layer.mergeAll(runner.pipe(Layer.provide(BunServices.layer)), BlobsInMemory))),
    );
  const missing = `blob://${"0".repeat(64)}.txt`;
  expect(await read([{ path: "csv" }, { path: "csv", line: 2, limit: 1 }, { path: "png" }, { path: missing }, { path: "blob://runs.csv" }])).toEqual([
    "a,b\n1,2\n3,4\n",
    "1,2",
    expect.stringMatching(/^rejected: blob:\/\/[0-9a-f]{64}\.png is not text/),
    `rejected: No blob is stored for ${missing}.`,
    "rejected: blob://runs.csv is not a blob pointer: a pointer is blob://, then 64 hex digits, then . and its extension.",
  ]);
});

test("write_file creates or replaces a file inside the workspace, whose folder exists", async () => {
  expect(await call("write_file", { path: "src/b.txt", text: "hello" })).toBe(`Wrote 5 bytes to ${root}/src/b.txt.`);
  expect(await call("read_file", { path: "src/b.txt" })).toBe("hello");
  expect(await call("write_file", { path: "nowhere/c.txt", text: "x" })).toStartWith(`reported: ${root}/nowhere/c.txt:`);
});

test("run_command is given the environment its host composed; by default this process's when the tools were made, without the variables that hold credentials", async () => {
  process.env["WORKSPACE_TEST_TOKEN"] = "secret";
  process.env["WORKSPACE_TEST_PLAIN"] = "plain";
  const envOf = (tools: ReturnType<typeof workspaceTools>) =>
    runTest(
      Effect.gen(function* () {
        const outcome = yield* (yield* ToolRunner).run(ToolName.make("run_command"), receivedJson({ command: "env", intent: "A test call." }), CallId.make("call-1"));
        return outcome._tag === "Succeeded" ? asText(outcome.output) : outcome._tag;
      }).pipe(Effect.provide(Layer.effect(ToolRunner, tools.source).pipe(Layer.provide(BunServices.layer)))),
    );
  const printed = await envOf(workspaceTools(root));
  expect(printed).toContain("WORKSPACE_TEST_PLAIN=plain");
  expect(printed).not.toContain("WORKSPACE_TEST_TOKEN");
  const given = await envOf(workspaceTools(root, { environment: { PATH: process.env["PATH"] ?? "", ONLY: "this" } }));
  expect(given).toContain("ONLY=this");
  expect(given).not.toContain("WORKSPACE_TEST_PLAIN");
});
