import { expect, test } from "bun:test";
import { json } from "./support/received.ts";
import { unseen } from "../src/agent-core/view.ts";
import { observe, open } from "./support/drive.ts";

const callsTool = {
  _tag: "ModelResponded",
  turn: "turn-1",
  provider: "p",
  model: "m",
  parts: [{ _tag: "ToolCall", call: "c1", tool: "run_tests", input: json({}) }],
  stop: "tool_use",
  metadata: json({}),
};

test("a tool result sent in a request that failed stays unseen, and the next turn's request carries it", () => {
  const session = open();
  observe(session, { _tag: "SessionOpened", session: "s1" });
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "fix the tests" });
  observe(session, callsTool);
  const result = observe(session, {
    _tag: "ToolEnded",
    call: "c1",
    outcome: { _tag: "Succeeded", output: json("2 failed") },
  });
  expect(session.live.sentThrough).toBeGreaterThanOrEqual(result);

  observe(session, { _tag: "ModelFailed", turn: "turn-1", failure: "overloaded after 3 retries" });
  expect(session.world.session).toMatchObject({ _tag: "Idle" });
  expect(session.live.sentThrough).toBeUndefined();
  expect(unseen(session.live)).toMatchObject([{ _tag: "ToolResult", seq: result }]);

  const stimulus = observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "try again" });
  const asked = session.journal.at(-1);
  expect(asked).toMatchObject({ decision: { _tag: "ModelAsked", turn: "turn-2" } });
  expect(session.live.sentThrough).toBeGreaterThanOrEqual(stimulus);
  expect(unseen(session.live).map((entry) => entry.seq)).toEqual([result, stimulus]);

  observe(session, { ...callsTool, turn: "turn-2", parts: [{ _tag: "Text", text: "Two tests fail in b.ts." }] });
  expect(unseen(session.live)).toEqual([]);
});
