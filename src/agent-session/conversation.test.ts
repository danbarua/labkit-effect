/** The conversation the model is sent, read from a session's facts: what it says of tool calls. */

import { expect } from "bun:test";
import { observe, open, opened } from "../../tests/support/drive.ts";
import { json } from "../../tests/support/received.ts";
import { test } from "../../tests/support/test.ts";
import { Schema } from "effect";
import { type ContextMessage, ModelContext } from "./contracts.ts";
import { conversationOf, nextMessages } from "./conversation.ts";

const responded = (parts: ReadonlyArray<unknown>, ending = "Complete") => ({
  _tag: "ModelResponded",
  turn: "turn-1",
  provider: "boring",
  model: "boring-1",
  parts,
  ending: { _tag: ending },
  metadata: json({}),
});

const call = (id: string) => ({ _tag: "ToolCall", call: id, tool: "ls", input: json({}) });

test("TC3: a call's result follows the response that made it, though the tool ended before the response did", () => {
  const session = open();
  observe(session, opened);
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "list the files" });
  observe(session, { _tag: "ToolCallArrived", turn: "turn-1", call: "c1", tool: "ls", input: json({}) });
  observe(session, { _tag: "ToolCallDispatched", call: "c1" });
  observe(session, { _tag: "ToolEnded", call: "c1", outcome: { _tag: "Succeeded", output: json(["a.ts"]) } });
  observe(session, responded([{ _tag: "Text", text: "Listing." }, call("c1")]));
  expect(conversationOf(session.journal).slice(1) as unknown).toEqual([
    { role: "assistant", parts: [{ _tag: "Text", text: "Listing." }, call("c1")] },
    { role: "user", parts: [{ _tag: "ToolResult", call: "c1", outcome: { _tag: "Succeeded", output: json(["a.ts"]) } }] },
  ]);
});

test("TC3: a call with no recorded end still has a result: not observed if it began to run, not run if it did not", () => {
  const session = open();
  observe(session, opened);
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "list the files" });
  observe(session, responded([call("c1"), call("c2")]));
  observe(session, { _tag: "ToolCallDispatched", call: "c1" });
  expect(conversationOf(session.journal).at(-1) as unknown).toEqual({
    role: "user",
    parts: [
      { _tag: "ToolResult", call: "c1", outcome: { _tag: "Failed", reason: { _tag: "Indeterminate" } } },
      { _tag: "ToolResult", call: "c2", outcome: { _tag: "Failed", reason: { _tag: "NotRun" } } },
    ],
  });
});

test("TC4: a call that arrived in a response that then failed is not sent to the model, nor is its result", () => {
  const session = open();
  observe(session, opened);
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "list the files" });
  observe(session, { _tag: "ToolCallArrived", turn: "turn-1", call: "c1", tool: "ls", input: json({}) });
  observe(session, { _tag: "ToolCallDispatched", call: "c1" });
  observe(session, {
    _tag: "ModelFailed",
    turn: "turn-1",
    failure: "the connection was lost",
    error: { mediaType: "text/plain", body: { _tag: "Text", text: "the connection was lost" } },
  });
  observe(session, { _tag: "ToolEnded", call: "c1", outcome: { _tag: "Succeeded", output: json(["a.ts"]) } });
  expect(conversationOf(session.journal)).toEqual([{ role: "user", parts: [{ _tag: "Text", text: "list the files" }] }]);
});

const sent = (messages: ReadonlyArray<ContextMessage>) =>
  json(Schema.encodeSync(Schema.toCodecJson(ModelContext))({ system: undefined, tools: [], messages }));

test("A6: the next request carries the last request's messages as recorded, though the facts would now project them otherwise", () => {
  const session = open();
  observe(session, opened);
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "list the files" });
  observe(session, responded([call("c1")]));
  observe(session, { _tag: "ToolCallDispatched", call: "c1" });
  const carried = conversationOf(session.journal);
  observe(session, { _tag: "ModelRequestDispatched", turn: "turn-1", provider: "boring", model: "boring-1", sent: sent(carried) });
  observe(session, { _tag: "ToolEnded", call: "c1", outcome: { _tag: "Succeeded", output: json(["a.ts"]) } });
  observe(session, responded([{ _tag: "Text", text: "Done." }]));
  const indeterminate = { _tag: "ToolResult", call: "c1", outcome: { _tag: "Failed", reason: { _tag: "Indeterminate" } } };
  expect(carried.at(-1) as unknown).toEqual({ role: "user", parts: [indeterminate] });
  expect(nextMessages(session.journal) as unknown).toEqual([...carried, { role: "assistant", parts: [{ _tag: "Text", text: "Done." }] }]);
  expect(conversationOf(session.journal)[2] as unknown).toEqual({
    role: "user",
    parts: [{ _tag: "ToolResult", call: "c1", outcome: { _tag: "Succeeded", output: json(["a.ts"]) } }],
  });
});

test("an input's files follow its text in the user's message, by reference", () => {
  const session = open();
  observe(session, opened);
  const chart = { id: "a".repeat(64), mediaType: "image/png", size: 7, name: "chart.png" };
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "What does this show?", attachments: [chart] });
  expect(conversationOf(session.journal) as unknown).toEqual([
    { role: "user", parts: [{ _tag: "Text", text: "What does this show?" }, { _tag: "File", blob: chart }] },
  ]);
});
