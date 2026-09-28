import { expect, test } from "bun:test";
import type { Fact } from "../src/agent-core/fact.ts";
import { observe, open, type Session } from "./support/drive.ts";

function tags(facts: ReadonlyArray<Fact>): Array<string> {
  return facts.map((fact) => (fact._tag === "Observed" ? fact.observation._tag : fact.decision._tag));
}

function started(permission: "ask" | "allow"): Session {
  const session = open();
  observe(session, { _tag: "SessionOpened", session: "s1", configuration: { permission } });
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "fix the tests" });
  return session;
}

const callsTool = {
  _tag: "ModelResponded",
  turn: "turn-1",
  provider: "p",
  model: "m",
  parts: [{ _tag: "ToolCall", call: "c1", tool: "run_tests", input: {} }],
  stop: "tool_use",
  metadata: {},
};

const answers = {
  _tag: "ModelResponded",
  turn: "turn-1",
  provider: "p",
  model: "m",
  parts: [{ _tag: "Text", text: "Done." }],
  stop: "end_turn",
  metadata: {},
};

test("input from another agent while a tool runs is given to the turn when the batch settles", () => {
  const session = started("allow");
  observe(session, callsTool);
  const interjection = observe(session, {
    _tag: "InputArrived",
    from: { _tag: "Agent", agent: "reviewer" },
    text: "the flaky test is in b.ts",
  });
  expect(session.state).toMatchObject({ queued: [interjection] });

  const ended = observe(session, { _tag: "ToolEnded", call: "c1", outcome: { _tag: "Succeeded", output: "2 failed" } });
  expect(tags(session.journal.filter((fact) => fact.seq > ended))).toEqual(["InputDelivered", "ModelAsked"]);
  expect(session.journal.at(-2)).toMatchObject({ decision: { inputs: [interjection] } });
  expect(session.live.find((entry) => entry._tag === "Input" && entry.seq === interjection)).toMatchObject({
    status: { _tag: "Given", turn: "turn-1" },
  });
});

test("a final answer with input queued does not end the turn: the input is given and the model asked again", () => {
  const session = started("allow");
  const interjection = observe(session, { _tag: "InputArrived", from: { _tag: "System" }, text: "CI went red" });
  const answered = observe(session, answers);
  expect(tags(session.journal.filter((fact) => fact.seq > answered))).toEqual(["InputDelivered", "ModelAsked"]);
  expect(session.journal.at(-2)).toMatchObject({ decision: { inputs: [interjection] } });

  const second = observe(session, answers);
  expect(tags(session.journal.filter((fact) => fact.seq > second))).toEqual(["TurnAnswered"]);
});

test("queued input cancelled by its sender is not given to the turn", () => {
  const session = started("allow");
  const queued = observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "also update the docs" });
  observe(session, { _tag: "InputCancelled", input: queued });
  const answered = observe(session, answers);
  expect(tags(session.journal.filter((fact) => fact.seq > answered))).toEqual(["TurnAnswered"]);
  expect(session.live.find((entry) => entry._tag === "Input" && entry.seq === queued)).toMatchObject({
    status: { _tag: "Cancelled" },
  });
});

test("cancelling input already given to a turn is recorded as not expected", () => {
  const session = started("allow");
  const given = observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "and b.ts" });
  observe(session, answers);
  const cancel = observe(session, { _tag: "InputCancelled", input: given });
  expect(session.journal.at(-1)).toMatchObject({
    _tag: "Decided",
    seq: cancel + 1,
    decision: { _tag: "ObservationNotExpected", observation: cancel },
  });
});

test("input queued when a turn fails is dropped, and no turn starts until the next input", () => {
  const session = started("allow");
  const queued = observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "try again" });
  const failed = observe(session, { _tag: "ModelFailed", turn: "turn-1", failure: "overloaded" });
  expect(tags(session.journal.filter((fact) => fact.seq > failed))).toEqual(["InputDropped", "TurnFailed"]);
  expect(session.state).toMatchObject({ turn: undefined, queued: [] });
  expect(session.live.find((entry) => entry._tag === "Input" && entry.seq === queued)).toMatchObject({
    status: { _tag: "Dropped", turn: "turn-1" },
  });
  const next = observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "now" });
  expect(session.journal.at(-2)).toMatchObject({ decision: { _tag: "TurnStarted", turn: "turn-2", inputs: [next] } });
});

test("a tool result for a call nobody made is recorded, and changes nothing", () => {
  const session = started("ask");
  const before = session.state;
  const stray = observe(session, { _tag: "ToolEnded", call: "c9", outcome: { _tag: "Failed", failure: "?" } });
  expect(session.state).toEqual(before);
  expect(session.journal.at(-1)).toMatchObject({ decision: { _tag: "ObservationNotExpected", observation: stray } });
});

test("a refused call settles the batch and the model is asked again", () => {
  const session = started("ask");
  observe(session, callsTool);
  const refused = observe(session, { _tag: "PermissionAnswered", call: "c1", answer: "refuse" });
  expect(tags(session.journal.filter((fact) => fact.seq > refused))).toEqual(["ToolCallRefused", "ModelAsked"]);
  expect(session.requests.map((request) => request._tag)).toEqual(["RequestModelResponse", "AskPermission", "RequestModelResponse"]);
});
