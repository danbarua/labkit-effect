import { expect, test } from "bun:test";
import { json } from "./support/received.ts";
import { observe, open, opened } from "./support/drive.ts";

const responseWithEveryPartKind = {
  _tag: "ModelResponded",
  turn: "turn-1",
  provider: "anthropic",
  model: "claude-sonnet-5",
  parts: [
    { _tag: "Thinking", text: "I should call ls.", signature: "sig-abc" },
    { _tag: "Text", text: "Listing them." },
    { _tag: "ToolCall", call: "c1", tool: "ls", input: json({ path: "." }) },
    { _tag: "Unrecognised", received: json({ type: "citation", source: "doc-1" }) },
  ],
  stop: "tool_use",
  ending: { _tag: "Complete" },
  metadata: json({ usage: { input_tokens: 120, output_tokens: 40 }, id: "msg_1" }),
};

function oneTurnWithATool() {
  const session = open();
  observe(session, opened);
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "list the files" });
  observe(session, responseWithEveryPartKind);
  observe(session, { _tag: "ToolEnded", call: "c1", outcome: { _tag: "Succeeded", output: json(["a.ts"]) } });
  observe(session, {
    _tag: "ModelResponded",
    turn: "turn-1",
    provider: "anthropic",
    model: "claude-sonnet-5",
    parts: [{ _tag: "Text", text: "There is one file, a.ts." }],
    stop: "end_turn",
    ending: { _tag: "Complete" },
    metadata: json({}),
  });
  return session;
}

test("the turn runs to an answer through one tool call", () => {
  const session = oneTurnWithATool();
  expect(session.journal.map((fact) => (fact._tag === "Observed" ? fact.observation._tag : fact.decision._tag))).toEqual([
    "SessionOpened",
    "InputArrived",
    "TurnStarted",
    "InputDelivered",
    "ModelAsked",
    "ModelResponded",
    "ToolEnded",
    "ModelAsked",
    "ModelResponded",
    "TurnEndReviewed",
    "TurnEnded",
  ]);
  expect(session.requests.map((request) => request._tag)).toEqual([
    "RequestModelResponse",
    "RunTool",
    "RequestModelResponse",
    "BeforeTurnEnded",
  ]);
});

test("the recorded response holds every part the model sent", () => {
  const session = oneTurnWithATool();
  const recorded = session.journal.find(
    (fact) => fact._tag === "Observed" && fact.observation._tag === "ModelResponded",
  );
  expect(recorded as unknown).toMatchObject({ observation: responseWithEveryPartKind });
});

test("a response cut short without tool calls is not an answer: the turn asks the model again", () => {
  const session = open();
  observe(session, opened);
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "write the report" });
  const response = (text: string, stop: string, ending: string) => ({
    _tag: "ModelResponded",
    turn: "turn-1",
    provider: "anthropic",
    model: "claude-sonnet-5",
    parts: [{ _tag: "Text", text }],
    stop,
    ending: { _tag: ending },
    metadata: json({}),
  });
  observe(session, response("The report, first half", "max_tokens", "CutShort"));
  observe(session, response("and the second half.", "end_turn", "Complete"));
  expect(session.journal.map((fact) => (fact._tag === "Observed" ? fact.observation._tag : fact.decision._tag))).toEqual([
    "SessionOpened",
    "InputArrived",
    "TurnStarted",
    "InputDelivered",
    "ModelAsked",
    "ModelResponded",
    "ModelAsked",
    "ModelResponded",
    "TurnEndReviewed",
    "TurnEnded",
  ]);
  expect(session.requests.map((request) => request._tag)).toEqual([
    "RequestModelResponse",
    "RequestModelResponse",
    "BeforeTurnEnded",
  ]);
});

test("a failed attempt at a model request is recorded and changes nothing; the request's outcome ends the step", () => {
  const session = open();
  observe(session, opened);
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "hello" });
  const attempt = {
    _tag: "ModelAttemptFailed",
    turn: "turn-1",
    provider: "anthropic",
    model: "claude-sonnet-5",
    failure: "overloaded",
    error: json({ reason: "InternalProviderError" }),
  };
  const failed = observe(session, attempt);
  expect(session.journal.filter((fact) => fact.seq > failed)).toEqual([]);
  observe(session, {
    _tag: "ModelResponded",
    turn: "turn-1",
    provider: "openai",
    model: "gpt-5.6",
    parts: [{ _tag: "Text", text: "Hello." }],
    stop: "stop",
    ending: { _tag: "Complete" },
    metadata: json({}),
  });
  expect(session.journal.at(-1) as unknown).toMatchObject({ decision: { _tag: "TurnEnded", ending: { _tag: "Answered" } } });
  const late = observe(session, attempt);
  expect(session.journal.at(-1) as unknown).toMatchObject({ decision: { _tag: "ObservationNotExpected", observation: late } });
});
