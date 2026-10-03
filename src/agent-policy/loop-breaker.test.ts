/** The loop breaker: identical calls in a row are vetoed from the `nudgeAt`-th, and the turn stopped at `stopAt`. */

import { expect } from "bun:test";
import type { Schema } from "effect";
import { observe, open } from "../../tests/support/drive.ts";
import { test } from "../../tests/support/test.ts";
import type { Fact } from "../agent-machine/fact.ts";
import { CallId, ToolName, TurnId } from "../agent-machine/names.ts";
import type { EffectRequest } from "../agent-machine/request.ts";
import { asText, receivedJson } from "../agent-session/received.ts";
import { CallKey, loopBreakerDefaults, repeatedCalls, repeatingTurns } from "./loop-breaker.ts";
import type { PolicyStep } from "./policy.ts";

const arrived = (turn: string, call: string, tool: string, input: Schema.Json) => ({
  _tag: "ToolCallArrived",
  turn,
  call,
  tool,
  input: receivedJson(input),
});
const run = (call: string, tool: string, input: Schema.Json): EffectRequest => ({
  _tag: "RunTool",
  call: CallId.make(call),
  tool: ToolName.make(tool),
  input: receivedJson(input),
});
const ask = (turn: string): EffectRequest => ({ _tag: "RequestModelResponse", turn: TurnId.make(turn) });

const factsOf = (...observations: ReadonlyArray<unknown>): ReadonlyArray<Fact> => {
  const session = open();
  for (const observation of observations) observe(session, observation);
  return session.journal;
};
const shown = (step: PolicyStep<unknown>): string =>
  step._tag === "Waiting" ? "waits" : step.verdict._tag === "Continue" ? "runs" : `vetoed: ${asText(step.verdict.reason)}`;

test("P10: the third identical call in a row is vetoed, and each after it, with a reason the model reads", () => {
  const facts = factsOf(...[1, 2, 3, 4].map((n) => arrived("t1", `c${n}`, "read_file", { path: "a.ts" })));
  const verdicts = [1, 2, 3, 4].map((n) => shown(repeatedCalls(facts).start(run(`c${n}`, "read_file", { path: "a.ts" }))));
  expect(verdicts.slice(0, 2)).toEqual(["runs", "runs"]);
  expect(verdicts[2]).toBe(
    "vetoed: Not run: read_file has been called with this same input 3 times in a row. Do something else, or answer with what you have. After 5 such calls in a row the turn ends.",
  );
  expect(verdicts[3]).toStartWith("vetoed: Not run: read_file has been called with this same input 4 times in a row.");
});

test("P10: a call is counted by its place among identical calls, not by how many the facts hold when it is reviewed", () => {
  // Four identical calls in one response are recorded before any of them is reviewed.
  const facts = factsOf({
    _tag: "ModelResponded",
    turn: "t1",
    provider: "boring",
    model: "boring-1",
    parts: [1, 2, 3, 4].map((n) => ({ _tag: "ToolCall", call: `c${n}`, tool: "read_file", input: receivedJson({ path: "a.ts" }) })),
    ending: { _tag: "Complete" },
    metadata: receivedJson({}),
  });
  expect([1, 2, 3, 4].map((n) => shown(repeatedCalls(facts).start(run(`c${n}`, "read_file", { path: "a.ts" }))).slice(0, 6))).toEqual([
    "runs",
    "runs",
    "vetoed",
    "vetoed",
  ]);
});

test("P10: a call made again after other calls is not in a row: running the tests, editing, and running them again", () => {
  const tests = (n: number) => arrived("t1", `t${n}`, "run_command", { command: "bun test" });
  const edit = (n: number) => arrived("t1", `e${n}`, "edit_file", { path: "a.ts", edit: n });
  const facts = factsOf(tests(1), edit(1), tests(2), edit(2), tests(3), edit(3), tests(4), edit(4), tests(5));
  expect([1, 2, 3, 4, 5].map((n) => shown(repeatedCalls(facts).start(run(`t${n}`, "run_command", { command: "bun test" }))))).toEqual(Array(5).fill("runs"));
  expect(shown(repeatingTurns(facts).start(ask("t1")))).toBe("runs");
});

test("P10: calls with another tool or input, or in another turn, are not identical; a call recorded twice is one call", () => {
  const facts = factsOf(
    arrived("t1", "c1", "read_file", { path: "a.ts" }),
    arrived("t1", "c2", "read_file", { path: "b.ts" }),
    arrived("t1", "c3", "search", { path: "a.ts" }),
    arrived("t0", "c0", "read_file", { path: "a.ts" }),
    arrived("t1", "c1", "read_file", { path: "a.ts" }),
    arrived("t1", "c4", "read_file", { path: "a.ts" }),
  );
  expect(shown(repeatedCalls(facts).start(run("c4", "read_file", { path: "a.ts" })))).toBe("runs");
});

test("P10: a turn's model request is vetoed once its last five calls are identical; other turns' requests are not", () => {
  const four = [1, 2, 3, 4].map((n) => arrived("t1", `c${n}`, "read_file", { path: "a.ts" }));
  expect(shown(repeatingTurns(factsOf(...four)).start(ask("t1")))).toBe("runs");
  const five = factsOf(...four, arrived("t1", "c5", "read_file", { path: "a.ts" }));
  expect(shown(repeatingTurns(five).start(ask("t1")))).toBe("vetoed: Stopped: read_file was called with the same input 5 times in a row.");
  // Another call after them ends the run.
  expect(shown(repeatingTurns(factsOf(...four, arrived("t1", "c5", "read_file", { path: "a.ts" }), arrived("t1", "c6", "search", {}))).start(ask("t1")))).toBe("runs");
  expect(shown(repeatingTurns(five).start(ask("t2")))).toBe("runs");
});

test("P10: what counts as identical, and when to nudge and stop, are settings", () => {
  const facts = factsOf(arrived("t1", "c1", "read_file", { path: "a.ts" }), arrived("t1", "c2", "read_file", { path: "b.ts" }));
  const byTool = { nudgeAt: 2, stopAt: 2, key: (tool: ToolName) => CallKey.make(tool) };
  expect(shown(repeatedCalls(facts, byTool).start(run("c2", "read_file", { path: "b.ts" })))).toStartWith("vetoed");
  expect(shown(repeatingTurns(facts, byTool).start(ask("t1")))).toStartWith("vetoed");
  expect(shown(repeatedCalls(facts, loopBreakerDefaults).start(run("c2", "read_file", { path: "b.ts" })))).toBe("runs");
});
