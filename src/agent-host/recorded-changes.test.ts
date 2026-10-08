/** What a host's own tools change in files, recorded by the wrapper around their tool source: the workspace tools, run on a folder made for the test. */

import { expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import * as git from "es-git";
import { Effect, Layer, Logger } from "effect";
import { runTest } from "../../tests/support/run.ts";
import { test, testFolder } from "../../tests/support/test.ts";
import { CallId, ToolName } from "../agent-machine/names.ts";
import { WordText } from "../agent-policy/command-segments.ts";
import { logKeys } from "../agent-session/log-keys.ts";
import { asText, receivedJson } from "../agent-session/received.ts";
import type { ToolSource } from "../agent-session/tool-sources.ts";
import type { Current } from "../agent-tools/file-change.ts";
import { workspaceTools } from "../agent-tools/workspace.ts";
import { recordingChanges } from "./recorded-changes.ts";

/** Runs each call in order through the workspace tools of the test's folder, wrapped by `recordingChanges` (unless `wrapped` is false); returns each call's details, with their patches as text, or its failure's tag. */
const ran = (calls: ReadonlyArray<readonly [string, object]>, options: { readonly wrapped?: boolean; readonly fileText?: (full: string) => Effect.Effect<Current> } = {}) => {
  const root = testFolder();
  const logged: Array<unknown> = [];
  return runTest(
    Effect.gen(function* () {
      const bare: ToolSource = yield* workspaceTools(root).source;
      const source =
        options.wrapped === false
          ? bare
          : yield* recordingChanges({ root, folders: { working: WordText.make(root), home: WordText.make(join(root, "home")) }, commandTools: ["run_command"], fileText: options.fileText })(bare);
      const results = yield* Effect.forEach(calls, ([tool, input]) =>
        Effect.map(source.run(ToolName.make(tool), receivedJson({ intent: "A test call.", ...input } as never), CallId.make("call-1")), (outcome) =>
          outcome._tag === "Succeeded" ? (outcome.details ?? []).map((detail) => (detail._tag === "FileChanged" ? { ...detail, patch: asText(detail.patch) } : detail)) : outcome.reason._tag,
        ),
      );
      return { results, logged };
    }).pipe(Effect.provide(Layer.mergeAll(Logger.layer([Logger.make((log) => logged.push(log.message))], { mergeWithExisting: true }), BunServices.layer))),
  );
};

test("write_file and edit_file record what they changed: a file created, with its text; a file updated, with a unified diff; nothing when the text is the same", async () => {
  const full = join(testFolder(), "d.txt");
  const { results } = await ran([
    ["write_file", { path: "d.txt", text: "one\ntwo\n" }],
    ["edit_file", { path: "d.txt", old_text: "two", new_text: "three" }],
    ["write_file", { path: "d.txt", text: "one\nthree\n" }],
    ["read_file", { path: "d.txt" }],
  ]);
  expect(results as unknown).toEqual([
    [{ _tag: "FileChanged", path: full, change: "created", patch: "one\ntwo\n" }],
    [{ _tag: "FileChanged", path: full, change: "updated", patch: [`--- ${full}`, `+++ ${full}`, "@@ -1,2 +1,2 @@", " one", "-two", "+three"].join("\n") }],
    [],
    [],
  ]);
});

test("a command tool records each file its command writes, from the disk's text just before it runs and once it has run; a failed command records nothing", async () => {
  const full = join(testFolder(), "w.txt");
  mkdirSync(testFolder(), { recursive: true });
  writeFileSync(full, "old\n");
  const { results } = await ran([
    ["run_command", { command: "echo new > w.txt" }],
    ["run_command", { command: "echo again > w.txt; exit 1" }],
    ["run_command", { command: "echo hi" }],
  ]);
  expect(results as unknown).toEqual([[{ _tag: "FileChanged", path: full, change: "updated", patch: [`--- ${full}`, `+++ ${full}`, "@@ -1,1 +1,1 @@", "-old", "+new"].join("\n") }], "Reported", []]);
});

test("a command whose words do not show the text it writes is recorded too: sed -i's file, and printf's redirect target; a path the shell expands is not", async () => {
  const sedded = join(testFolder(), "s.txt");
  const printed = join(testFolder(), "p.txt");
  mkdirSync(testFolder(), { recursive: true });
  writeFileSync(sedded, "alpha\nbeta\n");
  const { results } = await ran([
    ["run_command", { command: "sed -i.bak 's/beta/gamma/' s.txt" }],
    ["run_command", { command: "printf 'one\\ntwo\\n' > p.txt" }],
    ["run_command", { command: 'F=q.txt; printf x > "$F"' }],
  ]);
  expect(results as unknown).toEqual([
    [{ _tag: "FileChanged", path: sedded, change: "updated", patch: [`--- ${sedded}`, `+++ ${sedded}`, "@@ -1,2 +1,2 @@", " alpha", "-beta", "+gamma"].join("\n") }],
    [{ _tag: "FileChanged", path: printed, change: "created", patch: "one\ntwo\n" }],
    [],
  ]);
});

test("after a cd, a relative path is read in each folder it may lead from, and only the file that changed is recorded; a file a program copies whole (cp) is not recorded as a diff", async () => {
  const inSub = join(testFolder(), "sub", "c.txt");
  mkdirSync(join(testFolder(), "sub"), { recursive: true });
  writeFileSync(inSub, "one\n");
  writeFileSync(join(testFolder(), "c.txt"), "root\n");
  const { results } = await ran([
    ["run_command", { command: "cd sub && sed -i.bak 's/one/two/' c.txt" }],
    ["run_command", { command: "cp sub/c.txt d.txt" }],
  ]);
  expect(results as unknown).toEqual([[{ _tag: "FileChanged", path: inSub, change: "updated", patch: [`--- ${inSub}`, `+++ ${inSub}`, "@@ -1,1 +1,1 @@", "-one", "+two"].join("\n") }], []]);
});

test("an mv is recorded as a move, not as text, once the disk shows it: renamed, into a folder, replacing a file; a move that failed records nothing", async () => {
  const at = (name: string) => join(testFolder(), name);
  mkdirSync(at("sub"), { recursive: true });
  writeFileSync(at("a.txt"), "a\n");
  writeFileSync(at("c.txt"), "c\n");
  writeFileSync(at("d.txt"), "d\n");
  const { results } = await ran([
    ["run_command", { command: "mv a.txt b.txt" }],
    ["run_command", { command: "mv b.txt sub" }],
    ["run_command", { command: "mv c.txt d.txt" }],
    ["run_command", { command: "mv missing.txt e.txt" }],
  ]);
  expect(results as unknown).toEqual([
    [{ _tag: "FileMoved", from: at("a.txt"), to: at("b.txt") }],
    [{ _tag: "FileMoved", from: at("b.txt"), to: join(at("sub"), "b.txt") }],
    [{ _tag: "FileMoved", from: at("c.txt"), to: at("d.txt"), replaced: true }],
    "Reported",
  ]);
});

test("a file git ignores is recorded by its size, not its text: created, then appended to; one the call did not write records nothing; a tracked file keeps its diff", async () => {
  const at = (name: string) => join(testFolder(), name);
  mkdirSync(testFolder(), { recursive: true });
  await git.initRepository(testFolder(), { initialHead: "main" });
  writeFileSync(at(".gitignore"), "*.log\n");
  writeFileSync(at("kept.log"), "old\n");
  const { results } = await ran([
    ["run_command", { command: "echo one > out.log" }],
    ["run_command", { command: "echo two >> out.log" }],
    ["run_command", { command: "cd sub || echo x > kept.txt" }],
    ["run_command", { command: "echo seen > notes.txt" }],
  ]);
  expect(results as unknown).toEqual([
    [{ _tag: "FileWritten", path: at("out.log"), bytes: 4 }],
    [{ _tag: "FileWritten", path: at("out.log"), bytes: 8, before: 4 }],
    [{ _tag: "FileChanged", path: at("kept.txt"), change: "created", patch: "x\n" }],
    [{ _tag: "FileChanged", path: at("notes.txt"), change: "created", patch: "seen\n" }],
  ]);
});

test("a working folder that an enclosing repository ignores is not ignored output: its files keep their diffs", async () => {
  // The test's folder is under this repository's logs/, which its .gitignore ignores.
  const { results } = await ran([["run_command", { command: "echo one > out.log" }]]);
  expect(results as unknown).toEqual([[{ _tag: "FileChanged", path: join(testFolder(), "out.log"), change: "created", patch: "one\n" }]]);
});

test("a patch over 32 KiB is kept to its first lines that fit, and the bytes left out are recorded", async () => {
  const line = `${"x".repeat(99)}\n`;
  const { results } = await ran([["write_file", { path: "big.txt", text: line.repeat(400) }]]);
  const [details] = results;
  expect(Array.isArray(details) ? details.map((detail) => (detail._tag === "FileChanged" ? { change: detail.change, kept: Buffer.byteLength(detail.patch), cut: detail.cut } : detail)) : details).toEqual([{ change: "created", kept: 327 * 100, cut: 73 * 100 }] as never);
});

test("a path input's text is read through the world's reader; a text over 256 KiB is not known, so nothing is recorded of its file, and a warning says so", async () => {
  const huge = "y".repeat(300 * 1024);
  const { results, logged } = await ran([["write_file", { path: "e.txt", text: "small\n" }]], { fileText: () => Effect.succeed<Current>({ _tag: "Text", text: huge }) });
  expect(results).toEqual([[]]);
  expect(logged).toContainEqual([logKeys.tools.changeNotRecorded, expect.objectContaining({ tool: "write_file", full: join(testFolder(), "e.txt"), reason: "it is larger than 256 KiB" })]);
});

test("a source that is not wrapped records nothing: the tools record no changes of their own", async () => {
  const { results } = await ran([["write_file", { path: "f.txt", text: "hi\n" }]], { wrapped: false });
  expect(results).toEqual([[]]);
});
