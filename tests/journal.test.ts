import { expect, test } from "bun:test";
import { Schema } from "effect";
import { Journal } from "../src/agent-core/fact.ts";
import { replay } from "../src/agent-core/machine.ts";
import { conversation } from "../src/agent-core/view.ts";
import { observe, open } from "./support/drive.ts";

const strict = { onExcessProperty: "error" } as const;

const responseWithEveryPartKind = {
  _tag: "ModelResponded",
  turn: "turn-1",
  provider: "anthropic",
  model: "claude-sonnet-5",
  parts: [
    { _tag: "Thinking", text: "I should call ls.", signature: "sig-abc" },
    { _tag: "Text", text: "Listing them." },
    { _tag: "ToolCall", call: "c1", tool: "ls", input: { path: "." } },
    { _tag: "Unrecognised", received: { type: "citation", source: "doc-1" } },
  ],
  stop: "tool_use",
  metadata: { usage: { input_tokens: 120, output_tokens: 40 }, id: "msg_1" },
};

function oneTurnWithATool() {
  const session = open();
  observe(session, { _tag: "SessionOpened", session: "s1", configuration: { permission: "ask" } });
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "list the files" });
  observe(session, responseWithEveryPartKind);
  observe(session, { _tag: "PermissionAnswered", call: "c1", answer: "allow" });
  observe(session, { _tag: "ToolEnded", call: "c1", outcome: { _tag: "Succeeded", output: ["a.ts"] } });
  observe(session, {
    _tag: "ModelResponded",
    turn: "turn-1",
    provider: "anthropic",
    model: "claude-sonnet-5",
    parts: [{ _tag: "Text", text: "There is one file, a.ts." }],
    stop: "end_turn",
    metadata: {},
  });
  return session;
}

function reload(journal: unknown): Journal {
  const written = JSON.stringify(Schema.encodeSync(Journal)(journal as Journal));
  return Schema.decodeUnknownSync(Journal)(JSON.parse(written), strict);
}

test("the turn runs to an answer, asking permission for the tool call", () => {
  const session = oneTurnWithATool();
  expect(session.journal.map((fact) => (fact._tag === "Observed" ? fact.observation._tag : fact.decision._tag))).toEqual([
    "SessionOpened",
    "InputArrived",
    "TurnStarted",
    "ModelAsked",
    "ModelResponded",
    "PermissionAnswered",
    "ToolCallAllowed",
    "ToolEnded",
    "ModelAsked",
    "ModelResponded",
    "TurnAnswered",
  ]);
  expect(session.requests.map((request) => request._tag)).toEqual([
    "RequestModelResponse",
    "AskPermission",
    "RunTool",
    "RequestModelResponse",
  ]);
});

test("a journal read back after writing holds every part of every observation", () => {
  const session = oneTurnWithATool();
  const read = reload(session.journal);
  expect(read).toEqual(session.journal);
  const recorded = read.find((fact) => fact._tag === "Observed" && fact.observation._tag === "ModelResponded");
  expect(Schema.encodeSync(Journal)([recorded!])[0]).toMatchObject({ observation: responseWithEveryPartKind });
});

test("the view after reload is the view built live", () => {
  const session = oneTurnWithATool();
  expect(conversation(reload(session.journal))).toEqual(session.live);
  const response = session.live.find((entry) => entry._tag === "ModelResponse");
  expect(response).toMatchObject({ parts: responseWithEveryPartKind.parts });
});

test("the state after reload is the state built live", () => {
  const session = oneTurnWithATool();
  expect(replay(reload(session.journal))).toEqual(session.state);
});

test("reading a fact with a field this build does not know is refused, not stripped", () => {
  const written = Schema.encodeSync(Journal)(oneTurnWithATool().journal) as unknown as Array<Record<string, unknown>>;
  const withNewField = structuredClone(written);
  (withNewField[1] as { observation: Record<string, unknown> }).observation["attachments"] = ["x.png"];
  expect(() => Schema.decodeUnknownSync(Journal)(withNewField, strict)).toThrow();
  expect(JSON.stringify(Schema.decodeUnknownSync(Journal)(withNewField))).not.toContain("x.png");
});
