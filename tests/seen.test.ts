import { expect } from "bun:test";
import { test } from "./support/test.ts";
import type { Fact } from "../src/agent-core/fact.ts";
import { observe, open, opened } from "./support/drive.ts";
import { json } from "./support/received.ts";

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

/** Where each model request was made, in the order asked: it is made from the facts before it. */
function asked(journal: ReadonlyArray<Fact>): Array<number> {
  return journal.flatMap((fact) => (fact._tag === "Decided" && fact.decision._tag === "ModelAsked" ? [fact.seq] : []));
}

test("each request is made after the facts it can carry; after a failed request the next one comes later", () => {
  const session = open();
  observe(session, opened);
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "fix the tests" });
  observe(session, callsTool);
  const result = observe(session, { _tag: "ToolEnded", call: "c1", outcome: { _tag: "Succeeded", output: json("2 failed") } });
  expect(asked(session.journal).at(-1)).toBeGreaterThan(result);

  observe(session, { _tag: "ModelFailed", turn: "turn-1", failure: "overloaded after 3 retries", error: json({ reason: "overloaded" }) });
  expect(session.world.agent.state).toMatchObject({ _tag: "Idle" });

  const stimulus = observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "try again" });
  expect(session.journal.at(-1)).toMatchObject({ decision: { _tag: "ModelAsked", turn: "turn-2" } });
  expect(asked(session.journal).at(-1)).toBeGreaterThan(stimulus);
});
