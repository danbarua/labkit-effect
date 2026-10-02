/** The projection of a session's facts and streamed items to ACP's `session/update`, live and on load. */

import { expect } from "bun:test";
import { Schema } from "effect";
import { boringOpening } from "../../tests/support/boring.ts";
import { observe, open } from "../../tests/support/drive.ts";
import { json } from "../../tests/support/received.ts";
import { test } from "../../tests/support/test.ts";
import type { SessionUpdate } from "../acp/schema/v1.gen.ts";
import type { Fact } from "../agent-machine/fact.ts";
import { ToolName } from "../agent-machine/names.ts";
import { CapturedObservation } from "../agent-machine/observation.ts";
import type { ToolSpec } from "../agent-session/contracts.ts";
import { type Present, presentFrom, type ProjectionContext, type ProjectionInput, project } from "./projection.ts";

const tools: ReadonlyArray<ToolSpec> = [
  { name: ToolName.make("ls"), description: "Lists files.", input: { type: "object" }, kind: "read", replay: "safe" },
  { name: ToolName.make("rm"), description: "Removes a file.", input: { type: "object" }, kind: "delete", replay: "unsafe" },
];

const live: ProjectionContext = { mode: "live", present: presentFrom(tools) };
const replay: ProjectionContext = { mode: "replay", present: presentFrom(tools) };

/**
 * A session driven as the loop would. A live host is fed two feeds: the facts as they are recorded
 * (`fact`, kept in `session.journal`) and what model requests pass on (`stream`, kept in `items`).
 * `inputs` keeps both in the order they happened.
 */
const recording = () => {
  const session = open();
  const inputs: Array<ProjectionInput> = [];
  const items: Array<CapturedObservation> = [];
  const fact = (raw: unknown) => {
    const from = session.journal.length;
    observe(session, raw);
    inputs.push(...session.journal.slice(from));
  };
  const stream = (...streamed: ReadonlyArray<CapturedObservation>) => {
    inputs.push(...streamed);
    items.push(...streamed);
  };
  fact(boringOpening(tools));
  return { session, inputs, items, fact, stream };
};

type Stream = (...streamed: ReadonlyArray<CapturedObservation>) => void;

const captured = (raw: unknown) => Schema.decodeUnknownSync(CapturedObservation)(raw);
const delta = (kind: "Text" | "Commentary" | "Thinking", text: string, turn = "turn-1") => captured({ _tag: "ModelDelta", turn, kind, text });
const arrived = (part: unknown, turn = "turn-1") => captured({ _tag: "ModelPartArrived", turn, part });
const ended = (turn = "turn-1") => captured({ _tag: "ModelResponseEnded", turn });

const dispatched = (turn = "turn-1") => ({ _tag: "ModelRequestDispatched", turn, provider: "boring", model: "boring-1", sent: json({}) });
const responded = (parts: ReadonlyArray<unknown>, ending = "Complete", turn = "turn-1") => ({
  _tag: "ModelResponded",
  turn,
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

/** Every merge of `a` and `b` that keeps each one's own order. */
function* merges<A>(a: ReadonlyArray<A>, b: ReadonlyArray<A>): Generator<ReadonlyArray<A>> {
  if (a.length === 0 || b.length === 0) {
    yield [...a, ...b];
    return;
  }
  for (const rest of merges(a.slice(1), b)) yield [a[0] as A, ...rest];
  for (const rest of merges(a, b.slice(1))) yield [b[0] as A, ...rest];
}

/**
 * A turn that lists the files: it thinks, says so and calls `ls`; told the result, it answers. Each
 * request streams what `streaming` gives for its step, then its tool call (step 1) and its end item.
 */
const listing = (streaming: (stream: Stream, step: 1 | 2) => void = () => {}) => {
  const recorded = recording();
  const { fact, stream } = recorded;
  fact(asked("list the files"));
  fact(dispatched());
  streaming(stream, 1);
  fact({ _tag: "ToolCallArrived", turn: "turn-1", ...ls });
  stream(arrived({ _tag: "ToolCall", ...ls }), ended());
  fact({ _tag: "ToolCallDispatched", call: "c1" });
  fact({ _tag: "ToolEnded", call: "c1", outcome: { _tag: "Succeeded", output: json(["a.ts"]) } });
  fact(responded([thinking("I should list them."), answer("Listing."), { _tag: "ToolCall", ...ls }]));
  fact(dispatched());
  streaming(stream, 2);
  stream(ended());
  fact(responded([answer("One file: a.ts.")]));
  return recorded;
};

/** The listing turn, streamed as a provider does: each part's deltas, then the part. */
const deltas = (stream: Stream, step: 1 | 2) =>
  step === 1
    ? stream(
        delta("Thinking", "I should "),
        delta("Thinking", "list them."),
        arrived(thinking("I should list them.")),
        delta("Text", "List"),
        delta("Text", "ing."),
        arrived(answer("Listing.")),
      )
    : stream(delta("Text", "One file"), delta("Text", ": a.ts."), arrived(answer("One file: a.ts.")));

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

test("PJ1: on replay only the user's inputs are echoed: what a turn-end hook gave, from the system, is not", () => {
  const { session, fact } = recording();
  fact(asked("list the files"));
  fact(dispatched());
  fact(responded([thinking("The files are a.ts.")]));
  fact({ _tag: "InputArrived", from: { _tag: "System" }, text: "Your last response had no answer. Give it now." });
  fact(dispatched());
  fact(responded([answer("One file: a.ts.")]));
  const updates = project(session.journal, replay).updates;
  expect(updates.filter((update) => update.sessionUpdate === "user_message_chunk")).toEqual([user("list the files")] as never);
  expect(joined(updates, "agent_thought_chunk")).toBe("The files are a.ts.");
  expect(joined(updates, "agent_message_chunk")).toBe("One file: a.ts.");
});

test("PJ1 PJ2 PJ3 PJ4: live with deltas, each request's end item before its ModelResponded: no echo of the input, each delta once as it comes, and nothing at ModelResponded", () => {
  const { inputs } = listing(deltas);
  expect(project(inputs, live).updates).toEqual([
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
});

test("PJ3 PJ9: ModelResponded taken before its end item and before the last deltas: the rest of the text from it, and the late deltas dropped", () => {
  const { inputs, stream, fact } = recording();
  fact(asked("hello"));
  fact(dispatched());
  stream(delta("Thinking", "A greet"), delta("Text", "Hel"));
  fact(responded([thinking("A greeting."), answer("Hello there.")]));
  stream(delta("Thinking", "ing."), delta("Text", "lo there."), ended());
  expect(project(inputs, live).updates).toEqual([thought("A greet"), said("Hel"), thought("ing."), said("lo there.")]);
});

test("PJ3 PJ9: two requests in a turn, the first's ModelResponded taken after the second's deltas began: each is reconciled against its own deltas", () => {
  const { session, items } = listing(deltas);
  const facts = session.journal;
  const firstResponded = facts.findIndex((fact) => fact._tag === "Observed" && fact.observation._tag === "ModelResponded");
  const secondDispatched = facts.findIndex((fact, at) => at > firstResponded && fact._tag === "Observed" && fact.observation._tag === "ModelRequestDispatched");
  const firstEnd = items.findIndex((item) => item._tag === "ModelResponseEnded");
  // The facts up to the first response, but for it; the first request's items and the second's first
  // delta; then the first response, the second request, and the rest.
  const inputs: ReadonlyArray<ProjectionInput> = [
    ...facts.slice(0, firstResponded),
    ...items.slice(0, firstEnd + 2),
    ...facts.slice(firstResponded, secondDispatched + 1),
    ...items.slice(firstEnd + 2),
    ...facts.slice(secondDispatched + 1),
  ];
  const updates = project(inputs, live).updates;
  expect(updates.filter((update) => update.sessionUpdate !== "tool_call_update")).toEqual([
    announced("c1", "ls", "read"),
    thought("I should "),
    thought("list them."),
    said("List"),
    said("ing."),
    said("One file"),
    said(": a.ts."),
  ] as never);
});

test("PJ2: live with no deltas, from a scripted client or a whole answer: each part whole when ModelResponded is taken, as on replay", () => {
  const scripted = listing();
  expect(project(scripted.inputs, live).updates).toEqual(project(scripted.session.journal, replay).updates.slice(1));
  const whole = listing((stream, step) => (step === 1 ? stream(arrived(thinking("I should list them.")), arrived(answer("Listing."))) : stream(arrived(answer("One file: a.ts.")))));
  expect(project(whole.inputs, live).updates).toEqual(project(whole.session.journal, replay).updates.slice(1));
});

test("PJ10: text of only whitespace is sent with the next text of its kind, and not at all when a call or the response's end comes first: no blank message", () => {
  const call = { _tag: "ToolCall", ...ls };
  const live1 = recording();
  live1.fact(asked("hi"));
  live1.stream(delta("Text", "\n\n"), arrived(answer("\n\n")), arrived(call), delta("Text", "\n"), delta("Text", "Done."), arrived(answer("\nDone.")), ended());
  live1.fact(responded([answer("\n\n"), call, answer("\nDone.")], "Complete"));
  const updates = project(live1.inputs, live).updates;
  expect(joined(updates, "agent_message_chunk")).toEqual("\nDone.");
  expect(updates.filter((update) => update.sessionUpdate === "agent_message_chunk").map((update) => ("content" in update ? update.content : undefined))).toEqual([
    { type: "text", text: "\nDone." },
  ]);
  // On replay, a part of only whitespace is not sent either.
  expect(joined(project(live1.session.journal, replay).updates, "agent_message_chunk")).toEqual("\nDone.");
});

test("PJ3: several Text parts in one response, each with its deltas: the deltas cover the parts in order, and ModelResponded sends only what none sent", () => {
  const parts = [answer("Hello. "), answer("Bye.")];
  const streamed = [delta("Text", "Hel"), delta("Text", "lo. "), arrived(answer("Hello. ")), delta("Text", "By"), delta("Text", "e."), arrived(answer("Bye.")), ended()];
  const usual = recording();
  usual.fact(asked("hi"));
  usual.stream(...streamed);
  usual.fact(responded(parts));
  expect(project(usual.inputs, live).updates).toEqual([said("Hel"), said("lo. "), said("By"), said("e.")]);
  // Taken after "By": the rest of the second part from ModelResponded, and the late delta dropped.
  const early = recording();
  early.fact(asked("hi"));
  early.stream(...streamed.slice(0, 4));
  early.fact(responded(parts));
  early.stream(...streamed.slice(4));
  expect(project(early.inputs, live).updates).toEqual([said("Hel"), said("lo. "), said("By"), said("e.")]);
});

test("PJ7: a stopped response: what was streamed stays, nothing is sent again, and the parts its ModelResponded holds are not lost", () => {
  const { session, inputs, items, fact, stream } = recording();
  fact(asked("plan it"));
  fact(dispatched());
  stream(delta("Text", "Here is"), delta("Text", " the plan."), arrived(answer("Here is the plan.")), delta("Text", "Step one: "));
  fact({ _tag: "TurnInterrupted", turn: "turn-1" });
  stream(ended());
  fact(responded([answer("Here is the plan.")], "Interrupted"));
  expect(project(inputs, live).updates).toEqual([said("Here is"), said(" the plan."), said("Step one: ")]);
  // The facts taken after the first delta only: the rest of the whole part from ModelResponded, the
  // late deltas dropped, and the cut part, never streamed here, not on screen, as on replay.
  const interrupted = session.journal.findIndex((input) => input._tag === "Observed" && input.observation._tag === "TurnInterrupted");
  const early = [...session.journal.slice(0, interrupted), ...items.slice(0, 1), ...session.journal.slice(interrupted), ...items.slice(1)];
  expect(project(early, live).updates).toEqual([said("Here is"), said(" the plan.")]);
  expect(project(session.journal, replay).updates).toEqual([user("plan it"), said("Here is the plan.")]);
});

test("PJ7 PJ9: a failed request, its turn's end and the next turn: the failed request's deltas stay, and the next turn's text is sent once", () => {
  const { session, inputs, items, fact, stream } = recording();
  fact(asked("hello"));
  fact(dispatched());
  stream(delta("Text", "Hal"), ended());
  fact({ _tag: "ModelFailed", turn: "turn-1", failure: "overloaded", error: json({ reason: "overloaded" }) });
  fact(asked("try again"));
  fact(dispatched("turn-2"));
  stream(delta("Text", "Hel", "turn-2"), delta("Text", "lo.", "turn-2"), ended("turn-2"));
  fact(responded([answer("Hello.")], "Complete", "turn-2"));
  expect(project(inputs, live).updates).toEqual([said("Hal"), said("Hel"), said("lo.")]);
  // The feed of items a turn ahead: the failed request's delta stays, and the next turn's is sent once.
  const failed = session.journal.findIndex((input) => input._tag === "Observed" && input.observation._tag === "ModelFailed");
  expect(project([...session.journal.slice(0, failed), ...items, ...session.journal.slice(failed)], live).updates).toEqual([said("Hal"), said("Hel"), said("lo.")]);
  // The facts a turn ahead: what is captured of an ended turn is dropped, and its text comes from its facts.
  expect(joined(project([...session.journal, ...items], live).updates, "agent_message_chunk")).toBe("Hello.");
});

test("PJ9: what is captured of a turn after its TurnEnded is dropped: its text was sent from its facts", () => {
  const { session, items } = listing(deltas);
  const updates = project([...session.journal, ...items], live).updates;
  expect(updates.filter((update) => update.sessionUpdate !== "tool_call_update")).toEqual([
    announced("c1", "ls", "read"),
    thought("I should list them."),
    said("Listing."),
    said("One file: a.ts."),
  ] as never);
});

test("PJ9: a captured item that overtakes its turn's TurnStarted is not lost, and its text is not sent again", () => {
  const { session, inputs, items, fact, stream } = recording();
  const opening = inputs.length;
  fact(asked("hello"));
  fact(dispatched());
  stream(delta("Text", "Hel"), delta("Text", "lo."), ended());
  fact(responded([answer("Hello.")]));
  expect(project([...session.journal.slice(0, opening), ...items, ...session.journal.slice(opening)], live).updates).toEqual([said("Hel"), said("lo.")]);
});

test("PJ2 PJ8: replay of the stored facts and live with deltas send the same text, joined", () => {
  const { session, inputs } = listing(deltas);
  const sent = project(inputs, live).updates;
  const loaded = project(session.journal, replay).updates;
  expect(joined(sent, "agent_message_chunk")).toBe(joined(loaded, "agent_message_chunk"));
  expect(joined(sent, "agent_thought_chunk")).toBe(joined(loaded, "agent_thought_chunk"));
  expect(joined(loaded, "agent_message_chunk")).toBe("Listing.One file: a.ts.");
});

test("PJ2: a thinking summary whose blank-line separator is a delta of its own joins to the part's text", () => {
  const summary = "Read the files.\n\nThen answer.";
  const { session, inputs, fact, stream } = recording();
  fact(asked("go"));
  fact(dispatched());
  stream(delta("Thinking", "Read the files."), delta("Thinking", "\n\n"), delta("Thinking", "Then answer."), arrived(thinking(summary)), ended());
  fact(responded([thinking(summary), answer("Done.")]));
  const updates = project(inputs, live).updates;
  expect(joined(updates, "agent_thought_chunk")).toBe(summary);
  expect(joined(updates, "agent_message_chunk")).toBe("Done.");
  expect(joined(project(session.journal, replay).updates, "agent_thought_chunk")).toBe(summary);
});

/** The facts of `session` from `from` on, merged in every way with `items`; each merge projected live after `before`. */
const everyMerge = (before: ReadonlyArray<Fact>, facts: ReadonlyArray<Fact>, items: ReadonlyArray<CapturedObservation>) =>
  Array.from(merges<ProjectionInput>(facts, items), (merged) => project([...before, ...merged], live).updates);

test("PJ9: every merge of one response's facts and its streamed items sends the same text, once", () => {
  const { session, fact, stream } = recording();
  fact(asked("hi"));
  const from = session.journal.findIndex((input) => input._tag === "Observed" && input.observation._tag === "TurnStarted");
  const items = [delta("Thinking", "I should "), delta("Thinking", "greet."), delta("Text", "Hel"), delta("Text", "lo."), ended()];
  fact(dispatched());
  stream(...items);
  fact(responded([thinking("I should greet."), answer("Hello.")]));
  const all = everyMerge(session.journal.slice(0, from), session.journal.slice(from), items);
  expect(all).toHaveLength(1287);
  for (const updates of all) {
    expect(joined(updates, "agent_thought_chunk")).toBe("I should greet.");
    expect(joined(updates, "agent_message_chunk")).toBe("Hello.");
  }
});

test("PJ4 PJ9: every merge of a two-request turn's facts and its streamed items sends the same text once, and announces the call once", () => {
  const { session, items } = listing((stream, step) =>
    step === 1 ? stream(delta("Thinking", "I should list them."), delta("Text", "List"), delta("Text", "ing.")) : stream(delta("Text", "One file: a.ts.")),
  );
  const from = session.journal.findIndex((input) => input._tag === "Observed" && input.observation._tag === "TurnStarted");
  for (const updates of everyMerge(session.journal.slice(0, from), session.journal.slice(from), items)) {
    expect(joined(updates, "agent_thought_chunk")).toBe("I should list them.");
    expect(joined(updates, "agent_message_chunk")).toBe("Listing.One file: a.ts.");
    expect(updates.filter((update) => update.sessionUpdate === "tool_call")).toHaveLength(1);
  }
});

test("PJ9: every merge of two turns' facts and their streamed items sends each turn's text once, either feed a turn ahead", () => {
  const { session, fact, stream, items } = recording();
  const from = session.journal.length;
  fact(asked("hi"));
  fact(dispatched());
  stream(delta("Text", "Hel"), delta("Text", "lo."), ended());
  fact(responded([answer("Hello.")]));
  fact(asked("again"));
  fact(dispatched("turn-2"));
  stream(delta("Text", "Hi", "turn-2"), delta("Text", " again.", "turn-2"), ended("turn-2"));
  fact(responded([answer("Hi again.")], "Complete", "turn-2"));
  for (const updates of everyMerge(session.journal.slice(0, from), session.journal.slice(from), items))
    expect(joined(updates, "agent_message_chunk")).toBe("Hello.Hi again.");
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

test("PJ4: a call announced by ToolCallArrived is not announced again by its part or its response, even after it ended", () => {
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

test("PJ8: projecting stored facts gives the state to go on from live: a call already shown is not shown again, and the next turn's deltas are sent once", () => {
  const { session, fact, stream, inputs } = recording();
  fact(asked("list the files"));
  fact({ _tag: "ToolCallArrived", turn: "turn-1", ...ls });
  const loaded = project(session.journal, replay);
  const from = inputs.length;
  stream(ended());
  fact(responded([answer("Listing."), { _tag: "ToolCall", ...ls }]));
  fact({ _tag: "ToolCallDispatched", call: "c1" });
  fact({ _tag: "ToolEnded", call: "c1", outcome: { _tag: "Succeeded", output: json(["a.ts"]) } });
  fact(dispatched());
  stream(delta("Text", "One "), delta("Text", "file."), ended());
  fact(responded([answer("One file.")]));
  expect(project(inputs.slice(from), live, loaded.state).updates).toEqual([
    said("Listing."),
    updated("c1", "in_progress"),
    updated("c1", "completed", { content: output('["a.ts"]') }),
    said("One "),
    said("file."),
  ] as never);
});
