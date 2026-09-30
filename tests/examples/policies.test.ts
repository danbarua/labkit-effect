/**
 * The policy gate (`src/agent-policy`), shown with the example policies in
 * `src/examples/policies.ts`: what the gate gives for a verdict, and what the core does with a veto.
 */

import { expect } from "bun:test";
import { Millis } from "../../src/agent-machine/names.ts";
import type { EffectRequest } from "../../src/agent-machine/request.ts";
import { receivedText } from "../../src/agent-session/received.ts";
import { emptyGate, type GateInput, type GateOutput, type GateState, gate, RequestKey } from "../../src/agent-policy/gate.ts";
import { every, type Policy } from "../../src/agent-policy/policy.ts";
import { askPerson, budgetSpent, denyTools, notBefore } from "../../src/examples/policies.ts";
import { observe, open, opened } from "../support/drive.ts";
import { json } from "../support/received.ts";
import { test } from "../support/test.ts";

function run<State>(policy: Policy<State>, inputs: ReadonlyArray<GateInput>): Array<GateOutput> {
  let held: GateState<State> = emptyGate();
  const outputs: Array<GateOutput> = [];
  for (const input of inputs) {
    const step = gate(policy, held, input);
    held = step.gate;
    outputs.push(...step.outputs);
  }
  return outputs;
}

const runTool = (call: string, tool: string) =>
  ({ _tag: "RunTool", call, tool, input: json({}) }) as unknown as EffectRequest;
const askModel = (turn: string) => ({ _tag: "RequestModelResponse", turn }) as unknown as EffectRequest;

test("P1 P2 P3: a denied tool is vetoed before the person is asked; another tool waits for the answer", () => {
  const policy = every([denyTools(["rm"]), askPerson]);
  const outputs = run(policy, [
    { _tag: "Requested", request: runTool("c1", "rm") },
    { _tag: "Requested", request: runTool("c2", "ls") },
  ]);
  expect(outputs as unknown).toEqual([
    { _tag: "Observe", observation: { _tag: "ToolEnded", call: "c1", outcome: { _tag: "Failed", reason: { _tag: "Vetoed", reason: json({ denied: "rm" }) } } } },
    { _tag: "Ask", key: "tool:c2", asks: json({ question: "run?", tool: "ls" }) },
  ]);
});

test("P1 P4: the person's answer lets the waiting call continue, or vetoes it", () => {
  const policy = every([denyTools(["rm"]), askPerson]);
  const yes = run(policy, [
    { _tag: "Requested", request: runTool("c2", "ls") },
    { _tag: "Answered", key: RequestKey.make("tool:c2"), answer: receivedText("yes") },
  ]);
  expect(yes.at(-1) as unknown).toEqual({ _tag: "Forward", request: runTool("c2", "ls") });
  const no = run(policy, [
    { _tag: "Requested", request: runTool("c2", "ls") },
    { _tag: "Answered", key: RequestKey.make("tool:c2"), answer: receivedText("not on main") },
  ]);
  expect(no.at(-1) as unknown).toEqual({
    _tag: "Observe",
    observation: { _tag: "ToolEnded", call: "c2", outcome: { _tag: "Failed", reason: { _tag: "Vetoed", reason: json({ person: "not on main" }) } } },
  });
});

test("P1: a delayed model request is forwarded when the clock reaches the policy's time", () => {
  const outputs = run(notBefore(1000), [
    { _tag: "Requested", request: askModel("turn-1") },
    { _tag: "Tick", message: { _tag: "Tick", at: Millis.make(999) } },
  ]);
  expect(outputs).toEqual([]);
  const later = run(notBefore(1000), [
    { _tag: "Requested", request: askModel("turn-1") },
    { _tag: "Tick", message: { _tag: "Tick", at: Millis.make(1000) } },
  ]);
  expect(later as unknown).toEqual([{ _tag: "Forward", request: askModel("turn-1") }]);
});

test("P4: a vetoed tool call, fed back to the core, settles the batch and the model is asked again", () => {
  const session = open();
  observe(session, opened);
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "clean up" });
  observe(session, {
    _tag: "ModelResponded",
    turn: "turn-1",
    provider: "p",
    model: "m",
    parts: [{ _tag: "ToolCall", call: "c1", tool: "rm", input: json({ path: "/" }) }],
    stop: "tool_use",
    ending: { _tag: "Complete" },
    metadata: json({}),
  });
  const request = session.requests.at(-1)!;
  const [output] = run(denyTools(["rm"]), [{ _tag: "Requested", request }]);
  if (output?._tag !== "Observe") throw new Error(`expected a veto, got ${JSON.stringify(output)}`);
  observe(session, output.observation);
  expect(session.journal.at(-1)).toMatchObject({ decision: { _tag: "ModelAsked", turn: "turn-1" } });
});

test("P4: a vetoed model request ends the turn, recorded with the policy's reason", () => {
  const session = open();
  observe(session, opened);
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "go" });
  const [output] = run(budgetSpent, [{ _tag: "Requested", request: session.requests.at(-1)! }]);
  if (output?._tag !== "Observe") throw new Error(`expected a veto, got ${JSON.stringify(output)}`);
  observe(session, output.observation);
  expect(session.journal.at(-1)).toMatchObject({
    decision: { _tag: "TurnEnded", turn: "turn-1", ending: { _tag: "Vetoed", reason: json({ budget: "80% of the month used" }) } },
  });
  expect(session.world.agent.state).toMatchObject({ _tag: "Idle" });
});
