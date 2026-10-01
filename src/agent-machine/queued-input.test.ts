import { expect } from "bun:test";
import { test } from "../../tests/support/test.ts";
import { json } from "../../tests/support/received.ts";
import type { Fact } from "./fact.ts";
import { observe, open, opened, type DrivenMachines } from "../../tests/support/drive.ts";

function tags(facts: ReadonlyArray<Fact>): Array<string> {
  return facts.map((fact) => (fact._tag === "Observed" ? fact.observation._tag : fact.decision._tag));
}

function started(): DrivenMachines {
  const session = open();
  observe(session, opened);
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
  ending: { _tag: "Complete" },
  metadata: json({}),
};

const answers = {
  _tag: "ModelResponded",
  turn: "turn-1",
  provider: "p",
  model: "m",
  parts: [{ _tag: "Text", text: "Done." }],
  stop: "end_turn",
  ending: { _tag: "Complete" },
  metadata: json({}),
};

test("I1 I3: input from another agent while a tool runs is given to the turn when the batch settles", () => {
  const session = started();
  observe(session, callsTool);
  const interjection = observe(session, {
    _tag: "InputArrived",
    from: { _tag: "Agent", agent: "reviewer" },
    text: "the flaky test is in b.ts",
  });
  expect(session.world.turns.get("turn-1" as never)?.mailbox as unknown).toEqual([
    { message: { _tag: "Steer", input: interjection }, seq: interjection },
  ]);

  const ended = observe(session, { _tag: "ToolEnded", call: "c1", outcome: { _tag: "Succeeded", output: json("2 failed") } });
  expect(tags(session.journal.filter((fact) => fact.seq > ended))).toEqual(["InputDelivered", "TellModel"]);
  expect(session.journal.at(-2)).toMatchObject({ decision: { inputs: [interjection] } });
});

test("I3 I4: a final answer with input queued does not end the turn: the input is given and the model asked again", () => {
  const session = started();
  const interjection = observe(session, { _tag: "InputArrived", from: { _tag: "System" }, text: "CI went red" });
  const answered = observe(session, answers);
  expect(tags(session.journal.filter((fact) => fact.seq > answered))).toEqual([
    "TurnCompleted",
    "InputDelivered",
    "TurnEndReviewed",
    "TellModel",
  ]);
  expect(session.journal.at(-3)).toMatchObject({ decision: { inputs: [interjection] } });

  const second = observe(session, answers);
  expect(tags(session.journal.filter((fact) => fact.seq > second))).toEqual(["TurnCompleted", "TurnEndReviewed", "TurnEnded"]);
});

test("I5: queued input cancelled by its sender is not given to the turn", () => {
  const session = started();
  const queued = observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "also update the docs" });
  observe(session, { _tag: "InputCancelled", input: queued });
  const answered = observe(session, answers);
  expect(tags(session.journal.filter((fact) => fact.seq > answered))).toEqual(["TurnCompleted", "TurnEndReviewed", "TurnEnded"]);
  const given = session.journal.flatMap((fact) =>
    fact._tag === "Decided" && fact.decision._tag === "InputDelivered"
      ? fact.decision.inputs
      : [],
  );
  expect(given).not.toContain(queued);
});

test("I5: cancelling input already given to a turn changes nothing", () => {
  const session = started();
  const given = observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "and b.ts" });
  observe(session, answers);
  const before = session.world;
  const cancel = observe(session, { _tag: "InputCancelled", input: given });
  expect(session.world).toEqual(before);
  expect(session.journal.at(-1)).toMatchObject({ seq: cancel, observation: { _tag: "InputCancelled" } });
});

test("I6: input queued when a turn fails is dropped, and no turn starts until the next input", () => {
  const session = started();
  const queued = observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "try again" });
  const failed = observe(session, { _tag: "ModelFailed", turn: "turn-1", failure: "overloaded", error: json({ reason: "overloaded" }) });
  expect(tags(session.journal.filter((fact) => fact.seq > failed))).toEqual(["TurnEnded", "InputDropped"]);
  expect(session.world.agent.state).toMatchObject({ _tag: "Idle" });
  expect(session.journal.at(-1)).toMatchObject({ decision: { _tag: "InputDropped", turn: "turn-1", inputs: [queued] } });
  const next = observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "now" });
  expect(session.journal.filter((fact) => fact.seq > next).map((fact) => (fact._tag === "Observed" ? fact.observation : fact.decision)) as unknown).toEqual([
    { _tag: "TurnStarted", turn: "turn-2" },
    { _tag: "InputDelivered", turn: "turn-2", inputs: [next] },
    { _tag: "AskModel", turn: "turn-2" },
  ]);
});

test("R5: a tool result for a call no machine exists for is recorded as undelivered, and changes nothing", () => {
  const session = started();
  const before = session.world;
  const stray = observe(session, { _tag: "ToolEnded", call: "c9", outcome: { _tag: "Failed", reason: { _tag: "Reported", error: json("?") } } });
  expect(session.world).toEqual(before);
  expect(session.journal.at(-1)).toMatchObject({ decision: { _tag: "ObservationUndelivered", observation: stray } });
});

test("R3: a vetoed call settles the batch and the model is asked again", () => {
  const session = started();
  observe(session, callsTool);
  const vetoed = observe(session, {
    _tag: "ToolEnded",
    call: "c1",
    outcome: { _tag: "Failed", reason: { _tag: "Vetoed", reason: json({ rule: "no test runs on main" }) } },
  });
  expect(tags(session.journal.filter((fact) => fact.seq > vetoed))).toEqual(["TellModel"]);
  expect(session.requests.map((request) => request._tag)).toEqual([
    "RequestModelResponse",
    "RunTool",
    "RequestModelResponse",
  ]);
});

test("I2: input that arrives before a turn starts waits in the agent's mailbox, and the turn takes all of it", () => {
  const session = open();
  observe(session, opened);
  session.startsTurns = false;
  const first = observe(session, { _tag: "InputArrived", from: { _tag: "System" }, text: "wake up" });
  const second = observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "and check mail" });
  expect(session.world.agent.mailbox.map((waiting) => waiting.seq)).toEqual([first, second]);
  const started = observe(session, { _tag: "TurnStarted", turn: "wake-7" });
  expect(session.journal.filter((fact) => fact.seq > started).map((fact) => (fact as { decision: unknown }).decision)).toEqual([
    { _tag: "InputDelivered", turn: "wake-7", inputs: [first] },
    { _tag: "InputDelivered", turn: "wake-7", inputs: [second] },
    { _tag: "AskModel", turn: "wake-7" },
  ]);
  expect(session.world.agent).toMatchObject({ state: { _tag: "Running", turn: "wake-7" }, mailbox: [] });
});

test("R5: a turn reported while one is running is recorded as not expected", () => {
  const session = started();
  const stray = observe(session, { _tag: "TurnStarted", turn: "turn-x" });
  expect(session.journal.at(-1)).toMatchObject({ decision: { _tag: "ObservationNotExpected", observation: stray } });
  expect(session.world.agent.state).toMatchObject({ _tag: "Running", turn: "turn-1" });
});

test("R5: a model response passed on to a step that is running tools is recorded as not expected", () => {
  const session = started();
  observe(session, callsTool);
  const stray = observe(session, answers);
  expect(session.journal.at(-1)).toMatchObject({ decision: { _tag: "ObservationNotExpected", observation: stray } });
});
