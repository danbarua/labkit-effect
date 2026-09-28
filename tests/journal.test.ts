import { expect, test } from "bun:test";
import { Schema } from "effect";
import { Journal } from "../src/agent-core/fact.ts";

/** One turn with a tool call: every observation and decision kind the slice has. */
const turn = [
  {
    _tag: "Observed",
    seq: 1,
    observation: { _tag: "SessionOpened", session: "s1", configuration: { permission: "ask" } },
  },
  { _tag: "Observed", seq: 2, observation: { _tag: "UserWrote", text: "list the files" } },
  { _tag: "Decided", seq: 3, decision: { _tag: "TurnStarted", turn: "t1", input: 2 } },
  {
    _tag: "Observed",
    seq: 4,
    observation: {
      _tag: "ModelResponded",
      turn: "t1",
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
    },
  },
  { _tag: "Observed", seq: 5, observation: { _tag: "PermissionAnswered", call: "c1", answer: "allow" } },
  { _tag: "Decided", seq: 6, decision: { _tag: "ToolCallAllowed", call: "c1", by: "user" } },
  {
    _tag: "Observed",
    seq: 7,
    observation: { _tag: "ToolEnded", call: "c1", outcome: { _tag: "Succeeded", output: ["a.ts"] } },
  },
  {
    _tag: "Observed",
    seq: 8,
    observation: {
      _tag: "ModelResponded",
      turn: "t1",
      provider: "anthropic",
      model: "claude-sonnet-5",
      parts: [{ _tag: "Text", text: "There is one file, a.ts." }],
      stop: "end_turn",
      metadata: {},
    },
  },
  { _tag: "Decided", seq: 9, decision: { _tag: "TurnAnswered", turn: "t1" } },
];

const strict = { onExcessProperty: "error" } as const;

test("a journal written to JSON and read back holds every part it held", () => {
  const journal = Schema.decodeUnknownSync(Journal)(turn, strict);
  const written = JSON.stringify(Schema.encodeSync(Journal)(journal));
  const read = Schema.decodeUnknownSync(Journal)(JSON.parse(written), strict);
  expect(read).toEqual(journal);
  expect(JSON.parse(written)).toEqual(turn);
});

test("reading a fact with a field this build does not know is refused, not stripped", () => {
  const withNewField = structuredClone(turn);
  (withNewField[1] as { observation: Record<string, unknown> }).observation["attachments"] = ["x.png"];
  expect(() => Schema.decodeUnknownSync(Journal)(withNewField, strict)).toThrow();
});

test("the default decode strips that field, which is why the journal is read strictly", () => {
  const withNewField = structuredClone(turn);
  (withNewField[1] as { observation: Record<string, unknown> }).observation["attachments"] = ["x.png"];
  const read = Schema.decodeUnknownSync(Journal)(withNewField);
  expect(JSON.stringify(read)).not.toContain("x.png");
});
