import { expect, test } from "bun:test";
import { Millis } from "../src/agent-core/names.ts";
import type { EffectRequest } from "../src/agent-core/request.ts";
import { emptyGate, type GateInput, type GateOutput, type GateState, gate, RequestKey } from "../src/agent-policy/gate.ts";
import { every, type Policy } from "../src/agent-policy/policy.ts";
import { observe, open } from "./support/drive.ts";

/** Vetoes running any tool named in `denied`. */
const denyTools = (denied: ReadonlyArray<string>): Policy<unknown> => ({
  start: (request) =>
    request._tag === "RunTool" && denied.includes(request.tool)
      ? { _tag: "Decided", verdict: { _tag: "Veto", reason: { denied: request.tool } } }
      : { _tag: "Decided", verdict: { _tag: "Continue" } },
  receive: () => ({ _tag: "Decided", verdict: { _tag: "Continue" } }),
});

/** Asks a person before any tool runs; continues on "yes", vetoes on anything else. */
const askPerson: Policy<unknown> = {
  start: (request) =>
    request._tag === "RunTool"
      ? { _tag: "Waiting", state: request.call, asks: { question: "run?", tool: request.tool } }
      : { _tag: "Decided", verdict: { _tag: "Continue" } },
  receive: (_state, message) =>
    message._tag === "Answered" && message.answer === "yes"
      ? { _tag: "Decided", verdict: { _tag: "Continue" } }
      : message._tag === "Answered"
        ? { _tag: "Decided", verdict: { _tag: "Veto", reason: { person: message.answer } } }
        : { _tag: "Waiting", state: _state, asks: undefined },
};

/** Holds every model request until the clock reaches `at`: a rate limit, a budget window. */
const notBefore = (at: number): Policy<unknown> => ({
  start: (request) =>
    request._tag === "RequestModelResponse"
      ? { _tag: "Waiting", state: at, asks: undefined }
      : { _tag: "Decided", verdict: { _tag: "Continue" } },
  receive: (state, message) =>
    message._tag === "Tick" && message.at >= (state as number)
      ? { _tag: "Decided", verdict: { _tag: "Continue" } }
      : { _tag: "Waiting", state, asks: undefined },
});

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
  ({ _tag: "RunTool", call, tool, input: {} }) as unknown as EffectRequest;
const askModel = (turn: string) => ({ _tag: "RequestModelResponse", turn }) as unknown as EffectRequest;

test("a denied tool is vetoed before the person is asked; another tool waits for the answer", () => {
  const policy = every([denyTools(["rm"]), askPerson]);
  const outputs = run(policy, [
    { _tag: "Requested", request: runTool("c1", "rm") },
    { _tag: "Requested", request: runTool("c2", "ls") },
  ]);
  expect(outputs as unknown).toEqual([
    { _tag: "Observe", observation: { _tag: "ToolEnded", call: "c1", outcome: { _tag: "Vetoed", reason: { denied: "rm" } } } },
    { _tag: "Ask", key: "tool:c2", asks: { question: "run?", tool: "ls" } },
  ]);
});

test("the person's answer lets the waiting call continue, or vetoes it", () => {
  const policy = every([denyTools(["rm"]), askPerson]);
  const yes = run(policy, [
    { _tag: "Requested", request: runTool("c2", "ls") },
    { _tag: "Answered", key: RequestKey.make("tool:c2"), answer: "yes" },
  ]);
  expect(yes.at(-1) as unknown).toEqual({ _tag: "Forward", request: runTool("c2", "ls") });
  const no = run(policy, [
    { _tag: "Requested", request: runTool("c2", "ls") },
    { _tag: "Answered", key: RequestKey.make("tool:c2"), answer: "not on main" },
  ]);
  expect(no.at(-1) as unknown).toEqual({
    _tag: "Observe",
    observation: { _tag: "ToolEnded", call: "c2", outcome: { _tag: "Vetoed", reason: { person: "not on main" } } },
  });
});

test("a delayed model request is forwarded when the clock reaches the policy's time", () => {
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

test("a vetoed tool call, fed back to the core, settles the batch and the model is asked again", () => {
  const session = open();
  observe(session, { _tag: "SessionOpened", session: "s1" });
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "clean up" });
  observe(session, {
    _tag: "ModelResponded",
    turn: "turn-1",
    provider: "p",
    model: "m",
    parts: [{ _tag: "ToolCall", call: "c1", tool: "rm", input: { path: "/" } }],
    stop: "tool_use",
    metadata: {},
  });
  const request = session.requests.at(-1)!;
  const [output] = run(denyTools(["rm"]), [{ _tag: "Requested", request }]);
  if (output?._tag !== "Observe") throw new Error(`expected a veto, got ${JSON.stringify(output)}`);
  observe(session, output.observation);
  expect(session.journal.at(-1)).toMatchObject({ decision: { _tag: "ModelAsked", turn: "turn-1" } });
});

test("a vetoed model request ends the turn, recorded with the policy's reason", () => {
  const session = open();
  observe(session, { _tag: "SessionOpened", session: "s1" });
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "go" });
  const budget: Policy<unknown> = {
    start: () => ({ _tag: "Decided", verdict: { _tag: "Veto", reason: { budget: "80% of the month used" } } }),
    receive: () => ({ _tag: "Decided", verdict: { _tag: "Continue" } }),
  };
  const [output] = run(budget, [{ _tag: "Requested", request: session.requests.at(-1)! }]);
  if (output?._tag !== "Observe") throw new Error(`expected a veto, got ${JSON.stringify(output)}`);
  observe(session, output.observation);
  expect(session.journal.at(-1)).toMatchObject({
    decision: { _tag: "TurnEnded", turn: "turn-1", ending: { _tag: "Vetoed", reason: { budget: "80% of the month used" } } },
  });
  expect(session.state).toMatchObject({ activity: { _tag: "Idle" } });
});

test("starting a turn is forwarded without review", () => {
  const session = open();
  observe(session, { _tag: "SessionOpened", session: "s1" });
  session.startsTurns = false;
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "go" });
  const start = session.requests.at(-1)!;
  expect(run(denyTools([]), [{ _tag: "Requested", request: start }])).toEqual([{ _tag: "Forward", request: start }]);
});
