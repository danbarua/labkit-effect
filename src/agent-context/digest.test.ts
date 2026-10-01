/** The digest of a compacted span: attachments as their pointers, one line for each tool call. */

import { expect } from "bun:test";
import { runTest } from "../../tests/support/run.ts";
import { test } from "../../tests/support/test.ts";
import type { BlobRef } from "../agent-machine/blob.ts";
import { CallId, ToolName } from "../agent-machine/names.ts";
import type { ToolOutcome } from "../agent-machine/observation.ts";
import { MediaType } from "../agent-machine/received.ts";
import type { ContextMessage } from "../agent-session/contracts.ts";
import { parseJson, receivedJson, receivedText } from "../agent-session/received.ts";
import { blobPointer } from "../agent-session/shaping.ts";
import { DigestSummarizer, digestOf, type ToolDigests } from "./digest.ts";

const image = { id: "1ec195f71ba3ca69bc4055d456b5511969a3f553805ce317ea43654f6ea9153e", mediaType: "image/png", size: 1495, name: "halves.png" } as BlobRef;
const pdf = { id: "b55a6d4541e919924a51e3052bc74c6a8ae122fc5da22f77103fafe060ccbe13", mediaType: "application/pdf", size: 601, name: "papaya.pdf" } as BlobRef;

const call = (id: string, tool: string, input: unknown) => ({ _tag: "ToolCall" as const, call: CallId.make(id), tool: ToolName.make(tool), input: receivedJson(input as never) });
const result = (id: string, outcome: ToolOutcome) => ({ _tag: "ToolResult" as const, call: CallId.make(id), outcome });
const succeeded = (output: unknown): ToolOutcome => ({ _tag: "Succeeded", output: receivedJson(output as never) });

const span: ReadonlyArray<ContextMessage> = [
  { role: "user", parts: [{ _tag: "Text", text: "Look at these, then check the repo." }, { _tag: "File", blob: image }, { _tag: "File", blob: pdf }] },
  { role: "assistant", parts: [call("c1", "list_dir", { path: "/foo/bar/baz" }), call("c2", "read", { path: "package.json" }), call("c3", "bash", { command: "bun test" })] },
  {
    role: "user",
    parts: [
      result("c1", succeeded(Array.from({ length: 21 }, (_, n) => `file-${n}`))),
      result("c2", succeeded({ name: "labkit" })),
      result("c3", succeeded({ exit: -999, log: "workspace://logs/0f3a.log" })),
    ],
  },
  // The same image again is listed once.
  { role: "user", parts: [{ _tag: "Text", text: "And this one again." }, { _tag: "File", blob: image }] },
];

/** The digests the workspace tools would give: what each did, in a few words. */
const field = (received: Parameters<typeof parseJson>[0], key: string): string => {
  const parsed = parseJson(received);
  return "value" in parsed && typeof parsed.value === "object" && parsed.value !== null ? String((parsed.value as Record<string, unknown>)[key]) : "";
};
const workspace: ToolDigests = new Map([
  ["list_dir", (input, outcome) => `${outcome?._tag === "Succeeded" ? (parseJson(outcome.output) as { value: Array<unknown> }).value.length : "?"} files in ${field(input, "path")}`],
  ["read", (input) => field(input, "path")],
  ["bash", (input, outcome) => (outcome?._tag === "Succeeded" ? `\`${field(input, "command")}\` (exit ${field(outcome.output, "exit")}, see ${field(outcome.output, "log")})` : "")],
]);

test("the digest lists the span's attachments as their pointers, each once, and each tool call on one line in the tool's own words", () => {
  expect(digestOf(span, workspace)).toBe(
    [
      "Attachments (removed to preserve context):",
      blobPointer(image),
      blobPointer(pdf),
      "",
      "Tool Calls:",
      "`list_dir`:   21 files in /foo/bar/baz",
      "`read`    :   package.json",
      "`bash`    :   `bun test` (exit -999, see workspace://logs/0f3a.log)",
    ].join("\n"),
  );
});

test("a tool with no digest of its own is listed by its input, with why it failed, or as not ended", () => {
  const messages: ReadonlyArray<ContextMessage> = [
    { role: "assistant", parts: [call("c1", "grep", { pattern: "TODO" }), call("c2", "fetch", { url: "https://example.com" })] },
    { role: "user", parts: [result("c1", { _tag: "Failed", reason: { _tag: "NotRun" } })] },
  ];
  expect(digestOf(messages)).toBe(
    ["Tool Calls:", '`grep` :   {"pattern":"TODO"} (failed: NotRun)', '`fetch`:   {"url":"https://example.com"} (not ended)'].join("\n"),
  );
});

test("a tool's image kept in the blob store is listed with the attachments; a span with neither files nor calls has an empty digest", async () => {
  const stored: ToolOutcome = { _tag: "Succeeded", output: { mediaType: MediaType.make("image/png"), body: { _tag: "Stored", id: image.id, size: image.size } } };
  const messages: ReadonlyArray<ContextMessage> = [
    { role: "assistant", parts: [call("c1", "screenshot", {})] },
    { role: "user", parts: [result("c1", stored)] },
  ];
  expect(digestOf(messages).split("\n")[1]).toBe(blobPointer({ id: image.id, mediaType: image.mediaType, size: image.size }));
  const summary = await runTest(DigestSummarizer().summarize([], [{ role: "user", parts: [{ _tag: "Text", text: "hello" }] }], undefined as never, undefined as never));
  expect(summary).toEqual(receivedText(""));
});
