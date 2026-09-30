import { expect } from "bun:test";
import { test } from "../../tests/support/test.ts";
import { observe, open, opened, type DrivenMachines } from "../../tests/support/drive.ts";
import { json } from "../../tests/support/received.ts";

const tags = (session: DrivenMachines) =>
  session.journal.map((fact) => (fact._tag === "Observed" ? fact.observation._tag : fact.decision._tag));

const toOpenAi = { _tag: "ModelChangeArrived", provider: "openai", model: "gpt-5.6" };

const response = (parts: ReadonlyArray<unknown>) => ({
  _tag: "ModelResponded",
  turn: "turn-1",
  provider: "anthropic",
  model: "claude-sonnet-5",
  parts,
  stop: "end_turn",
  ending: { _tag: "Complete" },
  metadata: json({}),
});

test("M1: a change of model while no turn runs is taken at once", () => {
  const session = open();
  observe(session, opened);
  const change = observe(session, toOpenAi);
  expect(tags(session)).toEqual(["SessionOpened", "ModelChangeArrived", "ModelChangeTaken"]);
  expect(session.journal.at(-1) as unknown).toMatchObject({ decision: { _tag: "ModelChangeTaken", change } });
});

test("M1: a change of model during a step is taken between steps, before the next request", () => {
  const session = open();
  observe(session, opened);
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "list the files" });
  observe(session, toOpenAi);
  observe(session, response([{ _tag: "ToolCall", call: "c1", tool: "ls", input: json({}) }]));
  observe(session, { _tag: "ToolEnded", call: "c1", outcome: { _tag: "Succeeded", output: json(["a.ts"]) } });
  expect(tags(session).slice(4)).toEqual([
    "ModelAsked",
    "ModelChangeArrived",
    "ModelResponded",
    "ToolEnded",
    "ModelChangeTaken",
    "ModelAsked",
  ]);
});

test("M1: a change of model that arrives while the last step runs is taken once the step has answered", () => {
  const session = open();
  observe(session, opened);
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "hello" });
  observe(session, toOpenAi);
  observe(session, response([{ _tag: "Text", text: "Hello." }]));
  expect(tags(session).slice(-5)).toEqual([
    "ModelChangeArrived",
    "ModelResponded",
    "ModelChangeTaken",
    "TurnEndReviewed",
    "TurnEnded",
  ]);
});

test("M1: a change of model still waiting when the turn ends is taken, not dropped", () => {
  const session = open();
  observe(session, opened);
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "hello" });
  observe(session, toOpenAi);
  observe(session, { _tag: "TurnInterrupted", turn: "turn-1" });
  observe(session, {
    _tag: "ModelResponded",
    turn: "turn-1",
    provider: "boring",
    model: "boring-1",
    parts: [],
    ending: { _tag: "Interrupted" },
    metadata: { mediaType: "application/json", body: { _tag: "Text", text: "{}" } },
  });
  expect(tags(session).slice(-5)).toEqual([
    "ModelChangeArrived",
    "TurnInterrupted",
    "ModelResponded",
    "TurnEnded",
    "ModelChangeTaken",
  ]);
});
