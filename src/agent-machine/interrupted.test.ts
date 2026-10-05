import { expect } from "bun:test";
import { observe, open, opened, type DrivenMachines } from "../../tests/support/drive.ts";
import { json } from "../../tests/support/received.ts";
import { test } from "../../tests/support/test.ts";

const tags = (session: DrivenMachines) =>
  session.journal.map((fact) => (fact._tag === "Observed" ? fact.observation._tag : fact.decision._tag));

/** The response to `turn-1`'s request as far as it had arrived when it was stopped. */
const stopped = (parts: ReadonlyArray<unknown> = []) => ({
  _tag: "ModelResponded",
  turn: "turn-1",
  provider: "boring",
  model: "boring-1",
  parts,
  ending: { _tag: "Interrupted" },
  metadata: json({}),
});

test("an interruption during a step requests StopTurnWork; the turn ends when the model request reports how far it got, and the waiting input is dropped", () => {
  const session = open();
  observe(session, opened);
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "list the files" });
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "and count them" });
  observe(session, { _tag: "TurnInterrupted", turn: "turn-1" });
  expect(tags(session).slice(-2)).toEqual(["InputArrived", "TurnInterrupted"]);
  expect(session.requests.at(-1)).toEqual({ _tag: "StopTurnWork", turn: "turn-1" } as never);
  expect(session.world.agent.state._tag).toBe("Running");
  observe(session, stopped([{ _tag: "Text", text: "Listing" }]));
  expect(tags(session)).toEqual([
    "SessionOpened",
    "InputArrived",
    "TurnStarted",
    "InputDelivered",
    "AskModel",
    "InputArrived",
    "TurnInterrupted",
    "ModelResponded",
    "TurnEnded",
    "InputDropped",
  ]);
  expect(session.journal[8] as unknown).toMatchObject({ decision: { ending: { _tag: "Interrupted" } } });
  expect(session.world.agent.state._tag).toBe("Idle");
});

test("an interruption while a tool runs ends the turn when the tool's end is observed", () => {
  const session = open();
  observe(session, opened);
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "list the files" });
  observe(session, { _tag: "ToolCallArrived", turn: "turn-1", call: "c1", tool: "ls", input: json({ path: "." }) });
  observe(session, { _tag: "ToolCallDispatched", call: "c1" });
  observe(session, { _tag: "TurnInterrupted", turn: "turn-1" });
  observe(session, stopped([{ _tag: "Text", text: "Listing." }, { _tag: "ToolCall", call: "c1", tool: "ls", input: json({ path: "." }) }]));
  expect(tags(session).slice(-2)).toEqual(["TurnInterrupted", "ModelResponded"]);
  observe(session, { _tag: "ToolEnded", call: "c1", outcome: { _tag: "Failed", reason: { _tag: "Indeterminate" } } });
  expect(tags(session).slice(-2)).toEqual(["ToolEnded", "TurnEnded"]);
  expect(tags(session)).not.toContain("ObservationNotExpected");
  expect(session.requests.filter((request) => request._tag === "RunTool")).toHaveLength(1);
});

test("an interruption during the turn-end review stops the review; the turn ends Interrupted when the review reports", () => {
  const session = open();
  session.reviewsTurnEnds = false;
  observe(session, opened);
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "hello" });
  observe(session, { ...stopped([{ _tag: "Text", text: "Hello." }]), ending: { _tag: "Complete" } });
  observe(session, { _tag: "TurnInterrupted", turn: "turn-1" });
  expect(tags(session).slice(-2)).toEqual(["TurnCompleted", "TurnInterrupted"]);
  expect(session.requests.map((request) => request._tag).slice(-2)).toEqual(["BeforeTurnEnded", "StopTurnWork"]);
  expect(session.world.agent.state._tag).toBe("Running");
  observe(session, { _tag: "TurnEndReviewed", turn: "turn-1" });
  expect(tags(session).slice(-2)).toEqual(["TurnEndReviewed", "TurnEnded"]);
  expect(session.journal.at(-1) as unknown).toMatchObject({ decision: { ending: { _tag: "Interrupted" } } });
  expect(session.world.agent.state._tag).toBe("Idle");
});

test("hook feedback that arrives after an interruption during the review is dropped, and the model is not asked again", () => {
  const session = open();
  session.reviewsTurnEnds = false;
  observe(session, opened);
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "hello" });
  observe(session, { ...stopped([{ _tag: "Text", text: "Hello." }]), ending: { _tag: "Complete" } });
  observe(session, { _tag: "TurnInterrupted", turn: "turn-1" });
  const feedback = observe(session, { _tag: "InputArrived", from: { _tag: "System" }, text: "Try again." });
  observe(session, { _tag: "TurnEndReviewed", turn: "turn-1" });
  expect(tags(session).slice(-4)).toEqual(["InputArrived", "TurnEndReviewed", "TurnEnded", "InputDropped"]);
  expect(session.journal.at(-1) as unknown).toMatchObject({ decision: { inputs: [feedback] } });
  expect(tags(session)).not.toContain("TellModel");
});

test("an interruption after hook feedback was taken, before the review reported, ends the turn without asking the model again", () => {
  const session = open();
  session.reviewsTurnEnds = false;
  observe(session, opened);
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "hello" });
  observe(session, { ...stopped([{ _tag: "Text", text: "Hello." }]), ending: { _tag: "Complete" } });
  observe(session, { _tag: "InputArrived", from: { _tag: "System" }, text: "Try again." });
  expect(tags(session).at(-1)).toBe("InputDelivered");
  observe(session, { _tag: "TurnInterrupted", turn: "turn-1" });
  observe(session, { _tag: "TurnEndReviewed", turn: "turn-1" });
  expect(tags(session).slice(-3)).toEqual(["TurnInterrupted", "TurnEndReviewed", "TurnEnded"]);
  expect(session.journal.at(-1) as unknown).toMatchObject({ decision: { ending: { _tag: "Interrupted" } } });
  expect(tags(session)).not.toContain("TellModel");
});

test("a response to a turn that has ended is recorded as ObservationNotExpected", () => {
  const session = open();
  observe(session, opened);
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "list the files" });
  observe(session, { _tag: "TurnInterrupted", turn: "turn-1" });
  observe(session, stopped());
  observe(session, { ...stopped([{ _tag: "Text", text: "Listing." }]), ending: { _tag: "Complete" } });
  expect(tags(session).slice(-2)).toEqual(["ModelResponded", "ObservationNotExpected"]);
});
