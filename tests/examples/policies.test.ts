/**
 * Policies (`src/agent-policy`), shown with the example policies in `src/examples/policies.ts`: the
 * verdict each gives, and what the core does with a veto.
 */

import { expect } from "bun:test";
import { Millis } from "../../src/agent-machine/names.ts";
import type { EffectRequest } from "../../src/agent-machine/request.ts";
import { receivedText } from "../../src/agent-session/received.ts";
import { every, type Policy, type PolicyMessage, type PolicyStep } from "../../src/agent-policy/policy.ts";
import { askPerson, budgetSpent, denyTools, notBefore } from "../../src/examples/policies.ts";
import { observe, open, opened } from "../support/drive.ts";
import { json } from "../support/received.ts";
import { test } from "../support/test.ts";

/** What `policy` decides on `request`, given `messages` while it waits: a verdict, or what it asks while waiting. */
function decide<State>(policy: Policy<State>, request: EffectRequest, messages: ReadonlyArray<PolicyMessage> = []): PolicyStep<State> {
  return messages.reduce<PolicyStep<State>>((step, message) => (step._tag === "Waiting" ? policy.receive(step.state, message) : step), policy.start(request));
}

const runTool = (call: string, tool: string) =>
  ({ _tag: "RunTool", call, tool, input: json({}) }) as unknown as EffectRequest;
const askModel = (turn: string) => ({ _tag: "RequestModelResponse", turn }) as unknown as EffectRequest;

test("P1 P2 P3: a denied tool is vetoed before the person is asked, the veto saying which policy it was (by); another tool waits for the answer", () => {
  const policy = every([denyTools(["rm"]), askPerson]);
  expect(decide(policy, runTool("c1", "rm")) as unknown).toEqual({ _tag: "Decided", verdict: { _tag: "Veto", reason: json({ denied: "rm" }) }, by: 0 });
  expect(decide(policy, runTool("c2", "ls")) as unknown).toMatchObject({ _tag: "Waiting", asks: json({ question: "run?", tool: "ls" }) });
});

test("P1: the person's answer lets the waiting call continue, or vetoes it", () => {
  const policy = every([denyTools(["rm"]), askPerson]);
  expect(decide(policy, runTool("c2", "ls"), [{ _tag: "Answered", answer: receivedText("yes") }]) as unknown).toEqual({
    _tag: "Decided",
    verdict: { _tag: "Continue" },
  });
  expect(decide(policy, runTool("c2", "ls"), [{ _tag: "Answered", answer: receivedText("not on main") }]) as unknown).toEqual({
    _tag: "Decided",
    verdict: { _tag: "Veto", reason: json({ person: "not on main" }) },
    by: 1,
  });
});

test("P1: a delayed model request continues when the clock reaches the policy's time", () => {
  expect(decide(notBefore(1000), askModel("turn-1"), [{ _tag: "Tick", at: Millis.make(999) }])._tag).toBe("Waiting");
  expect(decide(notBefore(1000), askModel("turn-1"), [{ _tag: "Tick", at: Millis.make(1000) }]) as unknown).toEqual({
    _tag: "Decided",
    verdict: { _tag: "Continue" },
  });
});

test("a vetoed tool call, given to the core as how the call ended, settles the batch and the model is asked again", () => {
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
  const step = decide(denyTools(["rm"]), session.requests.at(-1)!);
  if (step._tag !== "Decided" || step.verdict._tag !== "Veto") throw new Error(`expected a veto, got ${JSON.stringify(step)}`);
  observe(session, { _tag: "ToolEnded", call: "c1", outcome: { _tag: "Failed", reason: { _tag: "Vetoed", reason: step.verdict.reason } } });
  expect(session.journal.at(-1)).toMatchObject({ decision: { _tag: "TellModel", turn: "turn-1" } });
});

test("a vetoed model request, given to the core as ModelVetoed, ends the turn with the policy's reason", () => {
  const session = open();
  observe(session, opened);
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "go" });
  const step = decide(budgetSpent, session.requests.at(-1)!);
  if (step._tag !== "Decided" || step.verdict._tag !== "Veto") throw new Error(`expected a veto, got ${JSON.stringify(step)}`);
  observe(session, { _tag: "ModelVetoed", turn: "turn-1", reason: step.verdict.reason });
  expect(session.journal.at(-1)).toMatchObject({
    decision: { _tag: "TurnEnded", turn: "turn-1", ending: { _tag: "Vetoed", reason: json({ budget: "80% of the month used" }) } },
  });
  expect(session.world.agent.state).toMatchObject({ _tag: "Idle" });
});
