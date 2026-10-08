/** What a host's own tools change in files, recorded by the wrapper around their tool source: the workspace tools, run on a folder made for the test. */

import { expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
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
          outcome._tag === "Succeeded" ? (outcome.details ?? []).map((detail) => ({ ...detail, patch: asText(detail.patch) })) : outcome.reason._tag,
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

test("a patch over 32 KiB is kept to its first lines that fit, and the bytes left out are recorded", async () => {
  const line = `${"x".repeat(99)}\n`;
  const { results } = await ran([["write_file", { path: "big.txt", text: line.repeat(400) }]]);
  const [details] = results;
  expect(Array.isArray(details) ? details.map((detail) => ({ change: detail.change, kept: Buffer.byteLength(detail.patch), cut: detail.cut })) : details).toEqual([{ change: "created", kept: 327 * 100, cut: 73 * 100 }] as never);
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
