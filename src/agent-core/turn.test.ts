import { expect } from "bun:test";
import { test } from "../../tests/support/test.ts";
import { json } from "../../tests/support/received.ts";
import { observe, open, opened } from "../../tests/support/drive.ts";

const responseWithEveryPartKind = {
  _tag: "ModelResponded",
  turn: "turn-1",
  provider: "anthropic",
  model: "claude-sonnet-5",
  parts: [
    { _tag: "Thinking", text: "I should call ls.", received: json({ type: "thinking", thinking: "I should call ls.", signature: "sig-abc" }) },
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

test("R5: the turn runs to an answer through one tool call", () => {
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

test("R2: the recorded response holds every part the model sent, in order, one not recognised as it was received", () => {
  const session = oneTurnWithATool();
  const recorded = session.journal.find(
    (fact) => fact._tag === "Observed" && fact.observation._tag === "ModelResponded",
  );
  expect(recorded as unknown).toMatchObject({ observation: responseWithEveryPartKind });
});

const cutShort = (text: string, stop: string, ending: string) => ({
  _tag: "ModelResponded",
  turn: "turn-1",
  provider: "anthropic",
  model: "claude-sonnet-5",
  parts: [{ _tag: "Text", text }],
  stop,
  ending: { _tag: ending },
  metadata: json({}),
});

const tags = (session: ReturnType<typeof open>) =>
  session.journal.map((fact) => (fact._tag === "Observed" ? fact.observation._tag : fact.decision._tag));

test("I4: a response cut short without tool calls ends the turn as cut short: the model is not asked again with nothing new", () => {
  const session = open();
  observe(session, opened);
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "write the report" });
  observe(session, cutShort("The report, first half", "max_tokens", "CutShort"));
  expect(tags(session)).toEqual([
    "SessionOpened",
    "InputArrived",
    "TurnStarted",
    "InputDelivered",
    "ModelAsked",
    "ModelResponded",
    "TurnEndReviewed",
    "TurnEnded",
  ]);
  expect(session.journal.at(-1) as unknown).toMatchObject({ decision: { _tag: "TurnEnded", ending: { _tag: "CutShort" } } });
  expect(session.requests.map((request) => request._tag)).toEqual(["RequestModelResponse", "BeforeTurnEnded"]);
});

test("I3 I4: a response cut short is followed by another request when input arrived meanwhile", () => {
  const session = open();
  observe(session, opened);
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "write the report" });
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "keep it short" });
  observe(session, cutShort("The report, first half", "max_tokens", "CutShort"));
  observe(session, cutShort("and the second half.", "end_turn", "Complete"));
  expect(tags(session).slice(4)).toEqual([
    "ModelAsked",
    "InputArrived",
    "ModelResponded",
    "InputDelivered",
    "TurnEndReviewed",
    "ModelAsked",
    "ModelResponded",
    "TurnEndReviewed",
    "TurnEnded",
  ]);
  expect(session.journal.at(-1) as unknown).toMatchObject({ decision: { _tag: "TurnEnded", ending: { _tag: "Answered" } } });
});

test("S3: a failed attempt at a model request is recorded and changes nothing; the request's outcome ends the step", () => {
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

test("TC1 TC2: a call that arrives while the response streams is run at once; the response, when it comes, does not run it again", () => {
  const session = open();
  observe(session, opened);
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "list the files" });
  const call = { call: "c1", tool: "ls", input: json({ path: "." }) };
  observe(session, { _tag: "ToolCallArrived", turn: "turn-1", ...call });
  expect(session.requests.at(-1)).toEqual({ _tag: "RunTool", ...call } as never);
  observe(session, { _tag: "ToolCallDispatched", call: "c1" });
  observe(session, { _tag: "ToolEnded", call: "c1", outcome: { _tag: "Succeeded", output: json(["a.ts"]) } });
  // The tool has ended and the response has not: the step waits for the response.
  expect(tags(session).at(-1)).toBe("ToolEnded");
  observe(session, {
    ...cutShort("Listing.", "tool_use", "Complete"),
    parts: [
      { _tag: "Text", text: "Listing." },
      { _tag: "ToolCall", ...call },
    ],
  });
  expect(tags(session).slice(4)).toEqual([
    "ModelAsked",
    "ToolCallArrived",
    "ToolCallDispatched",
    "ToolEnded",
    "ModelResponded",
    "ModelAsked",
  ]);
  expect(session.requests.map((request) => request._tag)).toEqual(["RequestModelResponse", "RunTool", "RequestModelResponse"]);
  expect(tags(session)).not.toContain("ObservationNotExpected");
});

test("TC2: a response's calls that did not arrive earlier are run when it comes; the step waits for those still running", () => {
  const session = open();
  observe(session, opened);
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "list the files" });
  observe(session, { _tag: "ToolCallArrived", turn: "turn-1", call: "c1", tool: "ls", input: json({}) });
  observe(session, {
    ...cutShort("", "tool_use", "Complete"),
    parts: [
      { _tag: "ToolCall", call: "c1", tool: "ls", input: json({}) },
      { _tag: "ToolCall", call: "c2", tool: "ls", input: json({}) },
    ],
  });
  expect(session.requests.flatMap((request) => (request._tag === "RunTool" ? [request.call] : []))).toEqual(["c1", "c2"] as never);
  observe(session, { _tag: "ToolEnded", call: "c2", outcome: { _tag: "Succeeded", output: json([]) } });
  expect(tags(session).at(-1)).toBe("ToolEnded");
  observe(session, { _tag: "ToolEnded", call: "c1", outcome: { _tag: "Succeeded", output: json([]) } });
  expect(tags(session).slice(-2)).toEqual(["ToolEnded", "ModelAsked"]);
});

test("I7: a whole response that is not yet an answer is followed by another request", () => {
  const session = open();
  observe(session, opened);
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "write the report" });
  observe(session, { ...cutShort("Writing it.", "pause_turn", "Unfinished"), parts: [{ _tag: "Commentary", text: "Writing it." }] });
  observe(session, cutShort("The report.", "end_turn", "Complete"));
  expect(tags(session).slice(4)).toEqual(["ModelAsked", "ModelResponded", "ModelAsked", "ModelResponded", "TurnEndReviewed", "TurnEnded"]);
  expect(session.journal.at(-1) as unknown).toMatchObject({ decision: { ending: { _tag: "Answered" } } });
});

test("S6: a request that was made is recorded; the step waits for what comes of it", () => {
  const session = open();
  observe(session, opened);
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "hello" });
  observe(session, { _tag: "ModelRequestDispatched", turn: "turn-1", provider: "anthropic", model: "claude-sonnet-5" });
  expect(tags(session).slice(-2)).toEqual(["ModelAsked", "ModelRequestDispatched"]);
  expect(session.world.agent.state._tag).toBe("Running");
  observe(session, cutShort("Hello.", "end_turn", "Complete"));
  expect(tags(session).slice(-3)).toEqual(["ModelResponded", "TurnEndReviewed", "TurnEnded"]);
  expect(tags(session)).not.toContain("ObservationNotExpected");
});
