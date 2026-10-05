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

test("the third identical call in a row is vetoed, and each one after it, with a reason that tells the model how many times it made the call", () => {
  const facts = factsOf(...[1, 2, 3, 4].map((n) => arrived("t1", `c${n}`, "read_file", { path: "a.ts" })));
  const verdicts = [1, 2, 3, 4].map((n) => shown(repeatedCalls(facts).start(run(`c${n}`, "read_file", { path: "a.ts" }))));
  expect(verdicts.slice(0, 2)).toEqual(["runs", "runs"]);
  expect(verdicts[2]).toBe(
    "vetoed: Not run: read_file has been called with this same input 3 times in a row. Do something else, or answer with what you have. After 5 such calls in a row the turn ends.",
  );
  expect(verdicts[3]).toStartWith("vetoed: Not run: read_file has been called with this same input 4 times in a row.");
});

test("calls in one response are counted by their position among identical calls, not by how many identical calls the facts hold when each is reviewed", () => {
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

test("a call repeated with other calls between the repetitions is not in a row: neither the call nor the turn's next model request is vetoed", () => {
  const tests = (n: number) => arrived("t1", `t${n}`, "run_command", { command: "bun test" });
  const edit = (n: number) => arrived("t1", `e${n}`, "edit_file", { path: "a.ts", edit: n });
  const facts = factsOf(tests(1), edit(1), tests(2), edit(2), tests(3), edit(3), tests(4), edit(4), tests(5));
  expect([1, 2, 3, 4, 5].map((n) => shown(repeatedCalls(facts).start(run(`t${n}`, "run_command", { command: "bun test" }))))).toEqual(Array(5).fill("runs"));
  expect(shown(repeatingTurns(facts).start(ask("t1")))).toBe("runs");
});

const readA = (turn: string, call: string) => arrived(turn, call, "read_file", { path: "a.ts" });

test.each([
  ["with another input", [readA("t1", "c1"), readA("t1", "c2"), arrived("t1", "c3", "read_file", { path: "b.ts" })], run("c3", "read_file", { path: "b.ts" })],
  ["with another tool", [readA("t1", "c1"), readA("t1", "c2"), arrived("t1", "c3", "search", { path: "a.ts" })], run("c3", "search", { path: "a.ts" })],
  ["after two identical calls in an earlier turn", [readA("t0", "c1"), readA("t0", "c2"), readA("t1", "c3")], run("c3", "read_file", { path: "a.ts" })],
  ["recorded twice after one identical call", [readA("t1", "c1"), readA("t1", "c2"), readA("t1", "c2")], run("c2", "read_file", { path: "a.ts" })],
  ["whose id an earlier turn used for its third identical call", [readA("t0", "c1"), readA("t0", "c2"), readA("t0", "c3"), arrived("t1", "c3", "read_file", { path: "b.ts" })], run("c3", "read_file", { path: "b.ts" })],
] as const)("a call %s is not the third identical call in a row, and runs", (_case, observations, request) => {
  expect(shown(repeatedCalls(factsOf(...observations)).start(request))).toBe("runs");
});

test("a turn's model request is vetoed once the turn's last five calls are identical; after a different call, or in another turn, the request continues", () => {
  const four = [1, 2, 3, 4].map((n) => arrived("t1", `c${n}`, "read_file", { path: "a.ts" }));
  expect(shown(repeatingTurns(factsOf(...four)).start(ask("t1")))).toBe("runs");
  const five = factsOf(...four, arrived("t1", "c5", "read_file", { path: "a.ts" }));
  expect(shown(repeatingTurns(five).start(ask("t1")))).toBe("vetoed: Stopped: read_file was called with the same input 5 times in a row.");
  // Another call after them ends the run.
  expect(shown(repeatingTurns(factsOf(...four, arrived("t1", "c5", "read_file", { path: "a.ts" }), arrived("t1", "c6", "search", {}))).start(ask("t1")))).toBe("runs");
  expect(shown(repeatingTurns(five).start(ask("t2")))).toBe("runs");
});

test("nudgeAt, stopAt and key are settings: with a key of the tool alone, calls with different inputs are identical", () => {
  const facts = factsOf(arrived("t1", "c1", "read_file", { path: "a.ts" }), arrived("t1", "c2", "read_file", { path: "b.ts" }));
  const byTool = { nudgeAt: 2, stopAt: 2, key: (tool: ToolName) => CallKey.make(tool) };
  expect(shown(repeatedCalls(facts, byTool).start(run("c2", "read_file", { path: "b.ts" })))).toStartWith("vetoed");
  expect(shown(repeatingTurns(facts, byTool).start(ask("t1")))).toStartWith("vetoed");
  expect(shown(repeatedCalls(facts, loopBreakerDefaults).start(run("c2", "read_file", { path: "b.ts" })))).toBe("runs");
});
