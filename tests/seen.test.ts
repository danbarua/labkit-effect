import { expect, test } from "bun:test";
import type { Fact } from "../src/agent-core/fact.ts";
import { observe, open } from "./support/drive.ts";
import { json } from "./support/received.ts";

const callsTool = {
  _tag: "ModelResponded",
  turn: "turn-1",
  provider: "p",
  model: "m",
  parts: [{ _tag: "ToolCall", call: "c1", tool: "run_tests", input: json({}) }],
  stop: "tool_use",
  metadata: json({}),
};

/** How far each model request went, in the order asked. */
function asked(journal: ReadonlyArray<Fact>): Array<number> {
  return journal.flatMap((fact) => (fact._tag === "Decided" && fact.decision._tag === "ModelAsked" ? [fact.decision.through] : []));
}

test("each request records how far the conversation it carries goes; after a failed request the next one goes further", () => {
  const session = open();
  observe(session, { _tag: "SessionOpened", session: "s1" });
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "fix the tests" });
  observe(session, callsTool);
  const result = observe(session, { _tag: "ToolEnded", call: "c1", outcome: { _tag: "Succeeded", output: json("2 failed") } });
  expect(asked(session.journal).at(-1)).toBeGreaterThanOrEqual(result);

  observe(session, { _tag: "ModelFailed", turn: "turn-1", failure: "overloaded after 3 retries" });
  expect(session.world.inbox).toMatchObject({ _tag: "Idle" });

  const stimulus = observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "try again" });
  expect(session.journal.at(-1)).toMatchObject({ decision: { _tag: "ModelAsked", turn: "turn-2" } });
  expect(asked(session.journal).at(-1)).toBeGreaterThanOrEqual(stimulus);
});
