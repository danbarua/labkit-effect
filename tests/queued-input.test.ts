import { expect, test } from "bun:test";
import { json } from "./support/received.ts";
import type { Fact } from "../src/agent-core/fact.ts";
import { observe, open, type Session } from "./support/drive.ts";

function tags(facts: ReadonlyArray<Fact>): Array<string> {
  return facts.map((fact) => (fact._tag === "Observed" ? fact.observation._tag : fact.decision._tag));
}

function started(): Session {
  const session = open();
  observe(session, { _tag: "SessionOpened", session: "s1" });
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "fix the tests" });
  return session;
}

const callsTool = {
  _tag: "ModelResponded",
  turn: "turn-1",
  provider: "p",
  model: "m",
  parts: [{ _tag: "ToolCall", call: "c1", tool: "run_tests", input: json({}) }],
  stop: "tool_use",
  metadata: json({}),
};

const answers = {
  _tag: "ModelResponded",
  turn: "turn-1",
  provider: "p",
  model: "m",
  parts: [{ _tag: "Text", text: "Done." }],
  stop: "end_turn",
  metadata: json({}),
};

test("input from another agent while a tool runs is given to the turn when the batch settles", () => {
  const session = started();
  observe(session, callsTool);
  const interjection = observe(session, {
    _tag: "InputArrived",
    from: { _tag: "Agent", agent: "reviewer" },
    text: "the flaky test is in b.ts",
  });
  expect(session.world.inbox).toMatchObject({ queued: [interjection] });

  const ended = observe(session, { _tag: "ToolEnded", call: "c1", outcome: { _tag: "Succeeded", output: json("2 failed") } });
  expect(tags(session.journal.filter((fact) => fact.seq > ended))).toEqual(["InputDelivered", "ModelAsked"]);
  expect(session.journal.at(-2)).toMatchObject({ decision: { inputs: [interjection] } });
});

test("a final answer with input queued does not end the turn: the input is given and the model asked again", () => {
  const session = started();
  const interjection = observe(session, { _tag: "InputArrived", from: { _tag: "System" }, text: "CI went red" });
  const answered = observe(session, answers);
  expect(tags(session.journal.filter((fact) => fact.seq > answered))).toEqual(["InputDelivered", "ModelAsked"]);
  expect(session.journal.at(-2)).toMatchObject({ decision: { inputs: [interjection] } });

  const second = observe(session, answers);
  expect(tags(session.journal.filter((fact) => fact.seq > second))).toEqual(["TurnEnded"]);
});

test("queued input cancelled by its sender is not given to the turn", () => {
  const session = started();
  const queued = observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "also update the docs" });
  observe(session, { _tag: "InputCancelled", input: queued });
  const answered = observe(session, answers);
  expect(tags(session.journal.filter((fact) => fact.seq > answered))).toEqual(["TurnEnded"]);
  const given = session.journal.flatMap((fact) =>
    fact._tag === "Decided" && (fact.decision._tag === "InputDelivered" || fact.decision._tag === "TurnRequested")
      ? fact.decision.inputs
      : [],
  );
  expect(given).not.toContain(queued);
});

test("cancelling input already given to a turn changes nothing", () => {
  const session = started();
  const given = observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "and b.ts" });
  observe(session, answers);
  const before = session.world;
  const cancel = observe(session, { _tag: "InputCancelled", input: given });
  expect(session.world).toEqual(before);
  expect(session.journal.at(-1)).toMatchObject({ seq: cancel, observation: { _tag: "InputCancelled" } });
});

test("input queued when a turn fails is dropped, and no turn starts until the next input", () => {
  const session = started();
  const queued = observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "try again" });
  const failed = observe(session, { _tag: "ModelFailed", turn: "turn-1", failure: "overloaded" });
  expect(tags(session.journal.filter((fact) => fact.seq > failed))).toEqual(["TurnEnded", "InputDropped"]);
  expect(session.world.inbox).toMatchObject({ _tag: "Idle", queued: [] });
  expect(session.journal.at(-1)).toMatchObject({ decision: { _tag: "InputDropped", turn: "turn-1", inputs: [queued] } });
  const next = observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "now" });
  expect(session.journal.at(-3)).toMatchObject({ decision: { _tag: "TurnRequested", inputs: [next] } });
  expect(session.journal.at(-2)).toMatchObject({ observation: { _tag: "TurnStarted", turn: "turn-2", inputs: [next] } });
});

test("a tool result for a call no machine exists for is recorded as undelivered, and changes nothing", () => {
  const session = started();
  const before = session.world;
  const stray = observe(session, { _tag: "ToolEnded", call: "c9", outcome: { _tag: "Failed", reason: { _tag: "Reported", error: json("?") } } });
  expect(session.world).toEqual(before);
  expect(session.journal.at(-1)).toMatchObject({ decision: { _tag: "ObservationUndelivered", observation: stray } });
});

test("a vetoed call settles the batch and the model is asked again", () => {
  const session = started();
  observe(session, callsTool);
  const vetoed = observe(session, {
    _tag: "ToolEnded",
    call: "c1",
    outcome: { _tag: "Failed", reason: { _tag: "Vetoed", reason: json({ rule: "no test runs on main" }) } },
  });
  expect(tags(session.journal.filter((fact) => fact.seq > vetoed))).toEqual(["ModelAsked"]);
  expect(session.requests.map((request) => request._tag)).toEqual([
    "StartTurn",
    "RequestModelResponse",
    "RunTool",
    "RequestModelResponse",
  ]);
});

test("input that arrives while a turn is starting is queued, not added to the starting turn", () => {
  const session = open();
  observe(session, { _tag: "SessionOpened", session: "s1" });
  session.startsTurns = false;
  const first = observe(session, { _tag: "InputArrived", from: { _tag: "System" }, text: "wake up" });
  expect(session.journal.at(-1)).toMatchObject({ decision: { _tag: "TurnRequested", inputs: [first] } });
  expect(session.world.inbox).toMatchObject({ _tag: "Starting", queued: [] });
  const second = observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "and check mail" });
  expect(session.world.inbox).toMatchObject({ _tag: "Starting", queued: [second] });
  observe(session, { _tag: "TurnStarted", turn: "wake-7", inputs: [first] });
  expect(session.world.inbox).toMatchObject({ _tag: "Serving", turn: "wake-7", queued: [second] });
});

test("a turn reported while none was requested is recorded as not expected", () => {
  const session = open();
  observe(session, { _tag: "SessionOpened", session: "s1" });
  const stray = observe(session, { _tag: "TurnStarted", turn: "turn-x", inputs: [2] });
  expect(session.journal.at(-1)).toMatchObject({ decision: { _tag: "ObservationNotExpected", observation: stray } });
  expect(session.world.inbox).toMatchObject({ _tag: "Idle" });
});
