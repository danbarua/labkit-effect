/** The projection of a session's facts and deltas to ACP's `session/update`, live and on load. */

import { expect } from "bun:test";
import { Schema } from "effect";
import { boringOpening } from "../../tests/support/boring.ts";
import { observe, open } from "../../tests/support/drive.ts";
import { json } from "../../tests/support/received.ts";
import { test } from "../../tests/support/test.ts";
import type { SessionUpdate } from "../acp/schema/v1.gen.ts";
import { StepIndex, ToolName, TurnId } from "../agent-machine/names.ts";
import { CapturedObservation } from "../agent-machine/observation.ts";
import type { ToolSpec } from "../agent-session/contracts.ts";
import { type Delta, type Present, presentFrom, type ProjectionContext, type ProjectionInput, project } from "./projection.ts";

const tools: ReadonlyArray<ToolSpec> = [
  { name: ToolName.make("ls"), description: "Lists files.", input: { type: "object" }, kind: "read", replay: "safe" },
  { name: ToolName.make("rm"), description: "Removes a file.", input: { type: "object" }, kind: "delete", replay: "unsafe" },
];

const live: ProjectionContext = { mode: "live", present: presentFrom(tools) };
const replay: ProjectionContext = { mode: "replay", present: presentFrom(tools) };

/**
 * A session driven as the loop would, keeping what a live host is fed in the order it happens: each
 * fact as it is recorded (`fact`), and what the response streams (`stream`).
 */
const recording = () => {
  const session = open();
  const inputs: Array<ProjectionInput> = [];
  const fact = (raw: unknown) => {
    const from = session.journal.length;
    observe(session, raw);
    inputs.push(...session.journal.slice(from));
  };
  const stream = (...streamed: ReadonlyArray<ProjectionInput>) => inputs.push(...streamed);
  fact(boringOpening(tools));
  return { session, inputs, fact, stream };
};

const delta = (response: number, part: number, kind: Delta["kind"], text: string, turn = "turn-1"): Delta => ({
  _tag: "Delta",
  turn: TurnId.make(turn),
  response: StepIndex.make(response),
  part,
  kind,
  text,
});

const arrived = (part: unknown, turn = "turn-1") => Schema.decodeUnknownSync(CapturedObservation)({ _tag: "ModelPartArrived", turn, part }) as ProjectionInput;

const responded = (parts: ReadonlyArray<unknown>, ending = "Complete") => ({
  _tag: "ModelResponded",
  turn: "turn-1",
  provider: "boring",
  model: "boring-1",
  parts,
  ending: { _tag: ending },
  metadata: json({}),
});

const asked = (text: string) => ({ _tag: "InputArrived", from: { _tag: "User" }, text });
const thinking = (text: string) => ({ _tag: "Thinking", text, received: json({ thinking: text }) });
const answer = (text: string) => ({ _tag: "Text", text });
const ls = { call: "c1", tool: "ls", input: json({ path: "." }) };

const user = (text: string): SessionUpdate => ({ sessionUpdate: "user_message_chunk", content: { type: "text", text } });
const said = (text: string): SessionUpdate => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const thought = (text: string): SessionUpdate => ({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text } });
const output = (text: string) => [{ type: "content", content: { type: "text", text } }];
const announced = (call: string, title: string, kind?: string) => ({ sessionUpdate: "tool_call", toolCallId: call, title, status: "pending", ...(kind === undefined ? {} : { kind }) });
const updated = (call: string, status: string, more: object = {}) => ({ sessionUpdate: "tool_call_update", toolCallId: call, status, ...more });

/** All the text of the updates of `kind`, joined. */
const joined = (updates: ReadonlyArray<SessionUpdate>, kind: "agent_message_chunk" | "agent_thought_chunk") =>
  updates.flatMap((update) => (update.sessionUpdate === kind && update.content.type === "text" ? [update.content.text] : [])).join("");

/** A turn that lists the files: it thinks, says so and calls `ls`; told the result, it answers. */
const listing = (streaming: (stream: (...streamed: ReadonlyArray<ProjectionInput>) => void, step: 1 | 2) => void = () => {}) => {
  const { session, inputs, fact, stream } = recording();
  fact(asked("list the files"));
  streaming(stream, 1);
  fact({ _tag: "ToolCallArrived", turn: "turn-1", ...ls });
  fact({ _tag: "ToolCallDispatched", call: "c1" });
  fact({ _tag: "ToolEnded", call: "c1", outcome: { _tag: "Succeeded", output: json(["a.ts"]) } });
  fact(responded([thinking("I should list them."), answer("Listing."), { _tag: "ToolCall", ...ls }]));
  streaming(stream, 2);
  fact(responded([answer("One file: a.ts.")]));
  return { session, inputs };
};

test("PJ1 PJ2 PJ4 PJ5 PJ6: replay of a recorded turn: the input, the call as it went, then each response's parts", () => {
  const { session } = listing();
  expect(project(session.journal, replay).updates).toEqual([
    user("list the files"),
    announced("c1", "ls", "read"),
    updated("c1", "in_progress"),
    updated("c1", "completed", { content: output('["a.ts"]') }),
    thought("I should list them."),
    said("Listing."),
    said("One file: a.ts."),
  ] as never);
});

test("PJ1 PJ2 PJ4: live with deltas: no echo of the input, each delta as it comes, and nothing again when parts are whole", () => {
  const { session, inputs } = listing((stream, step) =>
    step === 1
      ? stream(
          delta(1, 0, "thinking", "I should "),
          delta(1, 0, "thinking", "list them."),
          arrived(thinking("I should list them.")),
          delta(1, 1, "text", "List"),
          delta(1, 1, "text", "ing."),
          arrived(answer("Listing.")),
          arrived({ _tag: "ToolCall", ...ls }),
        )
      : stream(delta(2, 0, "text", "One file"), delta(2, 0, "text", ": a.ts.")),
  );
  const { updates } = project(inputs, live);
  expect(updates).toEqual([
    thought("I should "),
    thought("list them."),
    said("List"),
    said("ing."),
    announced("c1", "ls", "read"),
    updated("c1", "in_progress"),
    updated("c1", "completed", { content: output('["a.ts"]') }),
    said("One file"),
    said(": a.ts."),
  ] as never);
  // What live sent of the text is what the stored facts give on load.
  const loaded = project(session.journal, replay).updates;
  expect(joined(updates, "agent_message_chunk")).toBe(joined(loaded, "agent_message_chunk"));
  expect(joined(updates, "agent_thought_chunk")).toBe(joined(loaded, "agent_thought_chunk"));
});

test("PJ2: live with no deltas: each part when its stream completes it, or, with no stream, when the response is recorded", () => {
  const streamed = listing((stream, step) => {
    if (step === 1) stream(arrived(thinking("I should list them.")), arrived(answer("Listing.")), arrived({ _tag: "ToolCall", ...ls }));
  });
  expect(project(streamed.inputs, live).updates).toEqual([
    thought("I should list them."),
    said("Listing."),
    announced("c1", "ls", "read"),
    updated("c1", "in_progress"),
    updated("c1", "completed", { content: output('["a.ts"]') }),
    said("One file: a.ts."),
  ] as never);
  const unstreamed = listing();
  expect(project(unstreamed.inputs, live).updates).toEqual(project(unstreamed.session.journal, replay).updates.slice(1));
});

test("PJ3: deltas that stop part way: the rest of the part when it is whole, and no delta after that", () => {
  const { inputs, stream, fact } = recording();
  fact(asked("hello"));
  stream(delta(1, 0, "thinking", "A greet"), delta(1, 1, "text", "Hel"), arrived(thinking("A greeting.")), delta(1, 0, "thinking", "ing."));
  fact(responded([thinking("A greeting."), answer("Hello there.")]));
  stream(delta(1, 1, "text", "lo there."));
  expect(project(inputs, live).updates).toEqual([thought("A greet"), said("Hel"), thought("ing."), said("lo there.")]);
});

test("PJ5 PJ6: a call that fails: failed, with the tool's error as its content", () => {
  const { inputs, fact } = recording();
  fact(asked("remove a.ts"));
  fact(responded([{ _tag: "ToolCall", call: "c1", tool: "rm", input: json({ path: "a.ts" }) }]));
  fact({ _tag: "ToolCallDispatched", call: "c1" });
  fact({ _tag: "ToolEnded", call: "c1", outcome: { _tag: "Failed", reason: { _tag: "Reported", error: json({ error: "no such file" }) } } });
  expect(project(inputs, live).updates).toEqual([
    announced("c1", "rm", "delete"),
    updated("c1", "in_progress"),
    updated("c1", "failed", { content: output('{"error":"no such file"}') }),
  ] as never);
});

test("PJ5 PJ6: a call a policy vetoed: pending while asked, then failed with the reason, and never in progress", () => {
  const { inputs, fact } = recording();
  fact(asked("remove a.ts"));
  fact(responded([{ _tag: "ToolCall", call: "c1", tool: "rm", input: json({ path: "a.ts" }) }]));
  fact({ _tag: "PermissionAsked", call: "c1", asks: json({ tool: "rm" }) });
  fact({ _tag: "PermissionAnswered", call: "c1", answer: json({ optionId: "reject-once" }) });
  fact({ _tag: "ToolEnded", call: "c1", outcome: { _tag: "Failed", reason: { _tag: "Vetoed", reason: { mediaType: "text/plain", body: { _tag: "Text", text: "The user said no." } } } } });
  expect(project(inputs, live).updates).toEqual([
    announced("c1", "rm", "delete"),
    updated("c1", "pending"),
    updated("c1", "failed", { content: output("Not run: The user said no.") }),
  ] as never);
});

test("PJ7: an interrupted turn: what was sent stays, the parts the response holds are made whole, and nothing is sent twice", () => {
  const { session, inputs, fact, stream } = recording();
  fact(asked("plan it"));
  stream(delta(1, 0, "text", "Here is"), delta(1, 0, "text", " the plan."), arrived(answer("Here is the plan.")), delta(1, 1, "text", "Step one: "));
  fact({ _tag: "TurnInterrupted", turn: "turn-1" });
  fact(responded([answer("Here is the plan.")], "Interrupted"));
  expect(project(inputs, live).updates).toEqual([said("Here is"), said(" the plan."), said("Step one: ")]);
  expect(project(session.journal, replay).updates).toEqual([user("plan it"), said("Here is the plan.")]);
});

test("PJ4: a call announced by ToolCallArrived is not announced again by its response, even after it ended", () => {
  const { inputs } = listing();
  const updates = project(inputs, live).updates;
  expect(updates.filter((update) => update.sessionUpdate === "tool_call")).toEqual([announced("c1", "ls", "read")] as never);
  expect(updates.at(-1)).toEqual(said("One file: a.ts."));
});

test("PJ6: a host's presentation is shown in place of the default: title, kind and locations when announced, its content and what changed when ended", () => {
  const present: Present = (call, outcome) => ({
    title: outcome === undefined ? `List ${call.tool}` : "Listed",
    kind: "search",
    locations: [{ path: "/work" }],
    ...(outcome === undefined ? {} : { content: output("1 file") as never }),
  });
  const { inputs } = listing();
  expect(project(inputs, { mode: "live", present }).updates.slice(0, 3)).toEqual([
    { ...announced("c1", "List ls", "search"), locations: [{ path: "/work" }] },
    updated("c1", "in_progress"),
    updated("c1", "completed", { title: "Listed", locations: [{ path: "/work" }], content: output("1 file") }),
  ] as never);
});

test("PJ8: projecting stored facts gives the state to go on from live: a call already shown is not shown again", () => {
  const { session, fact, inputs } = recording();
  fact(asked("list the files"));
  fact({ _tag: "ToolCallArrived", turn: "turn-1", ...ls });
  const loaded = project(session.journal, replay);
  const from = inputs.length;
  fact(responded([answer("Listing."), { _tag: "ToolCall", ...ls }]));
  fact({ _tag: "ToolCallDispatched", call: "c1" });
  expect(project(inputs.slice(from), live, loaded.state).updates).toEqual([said("Listing."), updated("c1", "in_progress")] as never);
});
