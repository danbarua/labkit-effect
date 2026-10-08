/** A tool's output as the model is sent it: an MCP server's result, recorded as received, sent as plain text. */

import { expect } from "bun:test";
import { observe, open, opened } from "../../tests/support/drive.ts";
import { json } from "../../tests/support/received.ts";
import { test } from "../../tests/support/test.ts";
import { conversationOf } from "./conversation.ts";
import { asText } from "./received.ts";
import { mcpToolResult } from "./tool-output.ts";

/** What the model is sent for a call that ended with `outcome`. */
const sent = (outcome: unknown) => {
  const session = open();
  observe(session, opened);
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "go" });
  observe(session, {
    _tag: "ModelResponded",
    turn: "turn-1",
    provider: "boring",
    model: "boring-1",
    parts: [{ _tag: "ToolCall", call: "c1", tool: "mcp__fake__echo", input: json({}) }],
    ending: { _tag: "Complete" },
    metadata: json({}),
  });
  observe(session, { _tag: "ToolEnded", call: "c1", outcome });
  const result = conversationOf(session.journal)
    .flatMap((message) => message.parts)
    .find((part) => part._tag === "ToolResult");
  return result?._tag === "ToolResult" ? result.outcome : undefined;
};

const mcp = (result: unknown) => ({ mediaType: mcpToolResult, body: { _tag: "Text", text: JSON.stringify(result) } });

test("an MCP server's result is sent as plain text: its text blocks, an embedded text resource, a resource link as a link, an image named", () => {
  const outcome = sent({
    _tag: "Succeeded",
    output: mcp({
      content: [
        { type: "text", text: "Echo: hi" },
        { type: "resource", resource: { uri: "file:///a.txt", text: "the file" } },
        { type: "resource_link", uri: "file:///b.txt", name: "b.txt" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ],
      _meta: { kept: true },
    }),
  });
  expect(outcome?._tag === "Succeeded" ? [outcome.output.mediaType, asText(outcome.output)] : outcome).toEqual([
    "text/plain",
    "Echo: hi\nthe file\n[b.txt](file:///b.txt)\n[image: image/png]",
  ]);
});

test("an MCP result with no text is sent as its structured content in JSON; an MCP tool's own failure (isError) is sent as its text; other output is sent as recorded", () => {
  const structured = sent({ _tag: "Succeeded", output: mcp({ content: [], structuredContent: { sum: 3 } }) });
  expect(structured?._tag === "Succeeded" ? asText(structured.output) : structured).toBe('{"sum":3}');
  const failed = sent({ _tag: "Failed", reason: { _tag: "Reported", error: mcp({ content: [{ type: "text", text: "no such file" }], isError: true }) } });
  expect(failed?._tag === "Failed" && failed.reason._tag === "Reported" ? asText(failed.reason.error) : failed).toBe("no such file");
  const plain = sent({ _tag: "Succeeded", output: json({ files: ["a"] }) });
  expect(plain?._tag === "Succeeded" ? [plain.output.mediaType, asText(plain.output)] : plain).toEqual(["application/json", '{"files":["a"]}']);
});

test("a result's details are never sent to the model: it is sent the output alone", () => {
  const output = { mediaType: "text/plain", body: { _tag: "Text", text: "Edited /w/a.txt." } };
  const details = [{ _tag: "FileChanged", path: "/w/a.txt", change: "updated", patch: { mediaType: "text/plain", body: { _tag: "Text", text: "-two\n+three" } } }];
  expect(sent({ _tag: "Succeeded", output, details }) as unknown).toEqual({ _tag: "Succeeded", output });
});
