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

test("X1 X3: an interruption during a step stops the turn's work; the turn ends when the request says how far it got, and input waiting is dropped", () => {
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
    "ModelAsked",
    "InputArrived",
    "TurnInterrupted",
    "ModelResponded",
    "TurnEnded",
    "InputDropped",
  ]);
  expect(session.journal[8] as unknown).toMatchObject({ decision: { ending: { _tag: "Interrupted" } } });
  expect(session.world.agent.state._tag).toBe("Idle");
});

test("X1: interrupted while a tool runs: the turn ends when the tool's end is heard", () => {
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

test("X2: an interruption between steps ends the turn at once, and stops what is being carried out for it", () => {
  const session = open();
  session.reviewsTurnEnds = false;
  observe(session, opened);
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "hello" });
  observe(session, { ...stopped([{ _tag: "Text", text: "Hello." }]), ending: { _tag: "Complete" } });
  observe(session, { _tag: "TurnInterrupted", turn: "turn-1" });
  expect(tags(session).slice(-2)).toEqual(["TurnInterrupted", "TurnEnded"]);
  expect(session.requests.map((request) => request._tag).slice(-2)).toEqual(["BeforeTurnEnded", "StopTurnWork"]);
});

test("R5: a response to a turn that has ended is not expected", () => {
  const session = open();
  observe(session, opened);
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "list the files" });
  observe(session, { _tag: "TurnInterrupted", turn: "turn-1" });
  observe(session, stopped());
  observe(session, { ...stopped([{ _tag: "Text", text: "Listing." }]), ending: { _tag: "Complete" } });
  expect(tags(session).slice(-2)).toEqual(["ModelResponded", "ObservationNotExpected"]);
});
