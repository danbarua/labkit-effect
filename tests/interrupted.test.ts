import { expect } from "bun:test";
import { test } from "./support/test.ts";
import { json } from "./support/received.ts";
import { observe, open, opened, type Session } from "./support/drive.ts";

const tags = (session: Session) =>
  session.journal.map((fact) => (fact._tag === "Observed" ? fact.observation._tag : fact.decision._tag));

test("an interruption during a step ends the turn; input waiting for it is dropped", () => {
  const session = open();
  observe(session, opened);
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "list the files" });
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "and count them" });
  observe(session, { _tag: "TurnInterrupted", turn: "turn-1" });
  expect(tags(session)).toEqual([
    "SessionOpened",
    "InputArrived",
    "TurnStarted",
    "InputDelivered",
    "ModelAsked",
    "InputArrived",
    "TurnInterrupted",
    "TurnEnded",
    "InputDropped",
  ]);
  expect(session.journal[7] as unknown).toMatchObject({ decision: { ending: { _tag: "Interrupted" } } });
  expect(session.world.agent.state._tag).toBe("Idle");
});

test("a response to an interrupted turn is not expected", () => {
  const session = open();
  observe(session, opened);
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "list the files" });
  observe(session, { _tag: "TurnInterrupted", turn: "turn-1" });
  observe(session, {
    _tag: "ModelResponded",
    turn: "turn-1",
    provider: "openai",
    model: "gpt-5",
    parts: [{ _tag: "Text", text: "Listing." }],
    stop: "completed",
    ending: { _tag: "Complete" },
    metadata: json({}),
  });
  expect(tags(session).slice(-2)).toEqual(["ModelResponded", "ObservationNotExpected"]);
});
