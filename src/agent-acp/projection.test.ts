/** The projection of a session's facts and streamed items to ACP's `session/update`, live and on load. */

import { expect } from "bun:test";
import { Effect, Logger, References, Schema } from "effect";
import { boringOpening } from "../../tests/support/boring.ts";
import { observe, open } from "../../tests/support/drive.ts";
import { json } from "../../tests/support/received.ts";
import { test } from "../../tests/support/test.ts";
import { MessageId, type SessionUpdate } from "effective-acp/schema/v1";
import type { Fact } from "../agent-machine/fact.ts";
import { CallId, ToolName } from "../agent-machine/names.ts";
import { CapturedObservation } from "../agent-machine/observation.ts";
import type { ToolSpec } from "../agent-session/contracts.ts";
import { receivedJson } from "../agent-session/received.ts";
import { jsonSchemaOf } from "../agent-session/tool-input.ts";
import { described } from "../agent-tools/described.ts";
import { anyTool, type Tool } from "../agent-tools/tool.ts";
import { next as nextIn, type Present, presentFrom, type ProjectionContext, type ProjectionInput, type ProjectionState, project as projectIn, start, changedFiles } from "./projection.ts";
import { logKeys } from "./log-keys.ts";

/** `project` and `next`, run: the presentations here read nothing. `next` drops its log: the tests that read a log use `projectLogged`. */
const project = (...given: Parameters<typeof projectIn>) => Effect.runSync(projectIn(...given));
const next = (...given: Parameters<typeof nextIn>) => Effect.runSync(nextIn(...given).pipe(Effect.provide(Logger.layer([]))));

/** `project`, run with its log taken: each line's level, key, details and annotations. */
const projectLogged = (...given: Parameters<typeof projectIn>) => {
  const logged: Array<{ readonly level: string; readonly key: unknown; readonly details: unknown; readonly annotations: Readonly<Record<string, unknown>> }> = [];
  const capture = Logger.make((log) => {
    const [key, details] = Array.isArray(log.message) ? log.message : [log.message];
    logged.push({ level: log.logLevel, key, details, annotations: { ...log.fiber.getRef(References.CurrentLogAnnotations) } });
  });
  return { ...Effect.runSync(projectIn(...given).pipe(Effect.provide(Logger.layer([capture])))), logged };
};

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

/** A tool call as a test writes it: its id, its tool, and its input as JSON content. */
type TestCall = { readonly call: string; readonly tool: string; readonly input: { readonly body: { readonly text: string } } };

/** A text chunk of `sessionUpdate`; with `id`, the id of the message it belongs to. */
const chunk = (sessionUpdate: "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk", text: string, id: string | undefined) =>
  ({ sessionUpdate, content: { type: "text", text }, ...(id === undefined ? {} : { messageId: MessageId.make(id) }) }) as SessionUpdate;
const user = (text: string, id?: string) => chunk("user_message_chunk", text, id);
const said = (text: string, id?: string) => chunk("agent_message_chunk", text, id);
const thought = (text: string, id?: string) => chunk("agent_thought_chunk", text, id);
const output = (text: string) => [{ type: "content", content: { type: "text", text } }];
/** `call` announced: its title and kind as presented, its tool's name, and its input as given. */
const announced = (call: TestCall, title: string, kind?: string) => ({
  sessionUpdate: "tool_call",
  toolCallId: call.call,
  title,
  name: call.tool,
  status: "pending",
  ...(kind === undefined ? {} : { kind }),
  rawInput: JSON.parse(call.input.body.text),
});
const updated = (call: string, status: string, more: object = {}) => ({ sessionUpdate: "tool_call_update", toolCallId: call, status, ...more });

/** The updates without their message ids: for what a test defends of text and order, which the ids do not change. */
const unnamed = (updates: ReadonlyArray<SessionUpdate>): ReadonlyArray<SessionUpdate> =>
  updates.map((update) => {
    if (!("messageId" in update)) return update;
    const { messageId: _named, ...rest } = update;
    return rest as SessionUpdate;
  });

/** The seq of each of `facts` that observes `tag`, in order: what names a message (`InputArrived`, `ModelRequestDispatched`). */
const seqsOf = (facts: ReadonlyArray<Fact>, tag: string): ReadonlyArray<number> =>
  facts.flatMap((fact) => (fact._tag === "Observed" && fact.observation._tag === tag ? [fact.seq] : []));

/** Each model message's text, by its kind and its id, in the order they began: what a client that keeps one message per id shows. */
const messages = (updates: ReadonlyArray<SessionUpdate>): ReadonlyArray<readonly [string, string]> => {
  const found = new Map<string, string>();
  for (const update of updates)
    if ((update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") && update.content.type === "text") {
      const key = `${update.sessionUpdate} ${update.messageId}`;
      found.set(key, (found.get(key) ?? "") + update.content.text);
    }
  return [...found];
};

/** All the text of the updates of `kind`, joined. */
const joined = (updates: ReadonlyArray<SessionUpdate>, kind: "agent_message_chunk" | "agent_thought_chunk") =>
  updates.flatMap((update) => (update.sessionUpdate === kind && update.content.type === "text" ? [update.content.text] : [])).join("");

/** The updates as sorted JSON: which were sent, whatever their order. */
const encoded = (updates: ReadonlyArray<SessionUpdate>) => updates.map((update) => JSON.stringify(update)).sort();

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

test("replay of a recorded turn sends the input, then each response's parts, then each call as it went; each message names its input or its request and its place in the response", () => {
  const { session } = listing();
  const [input] = seqsOf(session.journal, "InputArrived");
  const [first, second] = seqsOf(session.journal, "ModelRequestDispatched");
  expect(project(session.journal, replay).updates).toEqual([
    user("list the files", `${input}`),
    thought("I should list them.", `${first}:0`),
    said("Listing.", `${first}:1`),
    announced(ls, "ls", "read"),
    updated("c1", "in_progress"),
    updated("c1", "completed", { content: output('["a.ts"]'), rawOutput: ["a.ts"] }),
    said("One file: a.ts.", `${second}:0`),
  ] as never);
});

test("on replay only the user's inputs are echoed: what a turn-end hook gave, from the system, is not", () => {
  const { session, fact } = recording();
  fact(asked("list the files"));
  fact(dispatched());
  fact(responded([thinking("The files are a.ts.")]));
  fact({ _tag: "InputArrived", from: { _tag: "System" }, text: "Your last response had no answer. Give it now." });
  fact(dispatched());
  fact(responded([answer("One file: a.ts.")]));
  const updates = project(session.journal, replay).updates;
  expect(updates.filter((update) => update.sessionUpdate === "user_message_chunk")).toEqual([user("list the files", `${seqsOf(session.journal, "InputArrived")[0]}`)] as never);
  expect(joined(updates, "agent_thought_chunk")).toBe("The files are a.ts.");
  expect(joined(updates, "agent_message_chunk")).toBe("One file: a.ts.");
});

test("live with deltas, each request's end item before its ModelResponded: no echo of the input, each delta once as it comes with the id that replay gives its message, and nothing at ModelResponded", () => {
  const { inputs, session } = listing(deltas);
  const [first, second] = seqsOf(session.journal, "ModelRequestDispatched");
  expect(project(inputs, live).updates).toEqual([
    thought("I should ", `${first}:0`),
    thought("list them.", `${first}:0`),
    said("List", `${first}:1`),
    said("ing.", `${first}:1`),
    announced(ls, "ls", "read"),
    updated("c1", "in_progress"),
    updated("c1", "completed", { content: output('["a.ts"]'), rawOutput: ["a.ts"] }),
    said("One file", `${second}:0`),
    said(": a.ts.", `${second}:0`),
  ] as never);
});

test("ModelResponded taken before its end item and before the last deltas: the rest of the text from it, in the message its deltas began, and the late deltas dropped", () => {
  const { inputs, stream, fact, session } = recording();
  fact(asked("hello"));
  fact(dispatched());
  stream(delta("Thinking", "A greet"), delta("Text", "Hel"));
  fact(responded([thinking("A greeting."), answer("Hello there.")]));
  stream(delta("Thinking", "ing."), delta("Text", "lo there."), ended());
  const [request] = seqsOf(session.journal, "ModelRequestDispatched");
  expect(project(inputs, live).updates).toEqual([thought("A greet", `${request}:0`), said("Hel", `${request}:1`), thought("ing.", `${request}:0`), said("lo there.", `${request}:1`)]);
});

test("two requests in a turn, the first's ModelResponded taken after the second's deltas began: each is reconciled against its own deltas", () => {
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
  expect(unnamed(updates.filter((update) => update.sessionUpdate !== "tool_call_update"))).toEqual([
    announced(ls, "ls", "read"),
    thought("I should "),
    thought("list them."),
    said("List"),
    said("ing."),
    said("One file"),
    said(": a.ts."),
  ] as never);
});

test("live with no deltas, from a scripted client or a whole answer: each part whole when ModelResponded is taken, the same updates as on replay, which takes the response before its call", () => {
  const scripted = listing();
  expect(encoded(project(scripted.inputs, live).updates)).toEqual(encoded(project(scripted.session.journal, replay).updates.slice(1)));
  expect(project(scripted.inputs, live).updates.at(-1)).toEqual(said("One file: a.ts.", `${seqsOf(scripted.session.journal, "ModelRequestDispatched")[1]}:0`));
  const whole = listing((stream, step) => (step === 1 ? stream(arrived(thinking("I should list them.")), arrived(answer("Listing."))) : stream(arrived(answer("One file: a.ts.")))));
  expect(encoded(project(whole.inputs, live).updates)).toEqual(encoded(project(whole.session.journal, replay).updates.slice(1)));
  expect(joined(project(whole.inputs, live).updates, "agent_message_chunk")).toBe("Listing.One file: a.ts.");
});

test("text of only whitespace is sent with the next text of its kind, and not at all when a call or the response's end comes first: no blank message", () => {
  const call = { _tag: "ToolCall", ...ls };
  const live1 = recording();
  live1.fact(asked("hi"));
  live1.fact(dispatched());
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

test("several Text parts in one response, each with its deltas: the deltas cover the parts in order, and ModelResponded sends only what none sent", () => {
  const parts = [answer("Hello. "), answer("Bye.")];
  const streamed = [delta("Text", "Hel"), delta("Text", "lo. "), arrived(answer("Hello. ")), delta("Text", "By"), delta("Text", "e."), arrived(answer("Bye.")), ended()];
  const usual = recording();
  usual.fact(asked("hi"));
  usual.fact(dispatched());
  usual.stream(...streamed);
  usual.fact(responded(parts));
  expect(unnamed(project(usual.inputs, live).updates)).toEqual([said("Hel"), said("lo. "), said("By"), said("e.")]);
  // Taken after "By": the rest of the second part from ModelResponded, and the late delta dropped.
  const early = recording();
  early.fact(asked("hi"));
  early.fact(dispatched());
  early.stream(...streamed.slice(0, 4));
  early.fact(responded(parts));
  early.stream(...streamed.slice(4));
  expect(unnamed(project(early.inputs, live).updates)).toEqual([said("Hel"), said("lo. "), said("By"), said("e.")]);
});

test("a stopped response: what was streamed stays, nothing is sent again, and the parts its ModelResponded holds are not lost", () => {
  const { session, inputs, items, fact, stream } = recording();
  fact(asked("plan it"));
  fact(dispatched());
  stream(delta("Text", "Here is"), delta("Text", " the plan."), arrived(answer("Here is the plan.")), delta("Text", "Step one: "));
  fact({ _tag: "TurnInterrupted", turn: "turn-1" });
  stream(ended());
  fact(responded([answer("Here is the plan.")], "Interrupted"));
  expect(unnamed(project(inputs, live).updates)).toEqual([said("Here is"), said(" the plan."), said("Step one: ")]);
  // The facts taken after the first delta only: the rest of the whole part from ModelResponded, the
  // late deltas dropped, and the cut part, never streamed here, not on screen, as on replay.
  const interrupted = session.journal.findIndex((input) => input._tag === "Observed" && input.observation._tag === "TurnInterrupted");
  const early = [...session.journal.slice(0, interrupted), ...items.slice(0, 1), ...session.journal.slice(interrupted), ...items.slice(1)];
  expect(unnamed(project(early, live).updates)).toEqual([said("Here is"), said(" the plan.")]);
  expect(unnamed(project(session.journal, replay).updates)).toEqual([user("plan it"), said("Here is the plan.")]);
});

test("a failed request, its turn's end and the next turn: the failed request's deltas stay, and the next turn's text is sent once", () => {
  const { session, inputs, items, fact, stream } = recording();
  fact(asked("hello"));
  fact(dispatched());
  stream(delta("Text", "Hal"), ended());
  fact({ _tag: "ModelFailed", turn: "turn-1", failure: "overloaded", error: json({ reason: "overloaded" }) });
  fact(asked("try again"));
  fact(dispatched("turn-2"));
  stream(delta("Text", "Hel", "turn-2"), delta("Text", "lo.", "turn-2"), ended("turn-2"));
  fact(responded([answer("Hello.")], "Complete", "turn-2"));
  expect(unnamed(project(inputs, live).updates)).toEqual([said("Hal"), said("Hel"), said("lo.")]);
  // The feed of items a turn ahead: the failed request's delta stays, and the next turn's is sent once.
  const failed = session.journal.findIndex((input) => input._tag === "Observed" && input.observation._tag === "ModelFailed");
  expect(unnamed(project([...session.journal.slice(0, failed), ...items, ...session.journal.slice(failed)], live).updates)).toEqual([said("Hal"), said("Hel"), said("lo.")]);
  // The facts a turn ahead: what is captured of an ended turn is dropped, and its text comes from its facts.
  expect(joined(project([...session.journal, ...items], live).updates, "agent_message_chunk")).toBe("Hello.");
});

test("what is captured of a turn after its TurnEnded is dropped: its text was sent from its facts", () => {
  const { session, items } = listing(deltas);
  const updates = project([...session.journal, ...items], live).updates;
  expect(unnamed(updates.filter((update) => update.sessionUpdate !== "tool_call_update"))).toEqual([
    announced(ls, "ls", "read"),
    thought("I should list them."),
    said("Listing."),
    said("One file: a.ts."),
  ] as never);
});

test("a captured item that overtakes its turn's TurnStarted is not lost, and its text is not sent again", () => {
  const { session, inputs, items, fact, stream } = recording();
  const opening = inputs.length;
  fact(asked("hello"));
  fact(dispatched());
  stream(delta("Text", "Hel"), delta("Text", "lo."), ended());
  fact(responded([answer("Hello.")]));
  expect(unnamed(project([...session.journal.slice(0, opening), ...items, ...session.journal.slice(opening)], live).updates)).toEqual([said("Hel"), said("lo.")]);
});

test("replay of the stored facts and live with deltas send the same text, joined", () => {
  const { session, inputs } = listing(deltas);
  const sent = project(inputs, live).updates;
  const loaded = project(session.journal, replay).updates;
  expect(joined(sent, "agent_message_chunk")).toBe(joined(loaded, "agent_message_chunk"));
  expect(joined(sent, "agent_thought_chunk")).toBe(joined(loaded, "agent_thought_chunk"));
  expect(joined(loaded, "agent_message_chunk")).toBe("Listing.One file: a.ts.");
});

test("a thinking summary whose blank-line separator is a delta of its own joins to the part's text", () => {
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

test("every merge of one response's facts and its streamed items sends the same text, once, in the messages that replay names", () => {
  const { session, fact, stream } = recording();
  fact(asked("hi"));
  const from = session.journal.findIndex((input) => input._tag === "Observed" && input.observation._tag === "TurnStarted");
  const items = [delta("Thinking", "I should "), delta("Thinking", "greet."), delta("Text", "Hel"), delta("Text", "lo."), ended()];
  fact(dispatched());
  stream(...items);
  fact(responded([thinking("I should greet."), answer("Hello.")]));
  const [request] = seqsOf(session.journal, "ModelRequestDispatched");
  const loaded = messages(project(session.journal, replay).updates);
  expect(loaded).toEqual([
    [`agent_thought_chunk ${request}:0`, "I should greet."],
    [`agent_message_chunk ${request}:1`, "Hello."],
  ]);
  const all = everyMerge(session.journal.slice(0, from), session.journal.slice(from), items);
  expect(all).toHaveLength(1287);
  for (const updates of all) expect(messages(updates)).toEqual(loaded);
});

test("every merge of a two-request turn's facts and its streamed items sends the same text once, in the messages that replay names, and announces the call once", () => {
  const { session, items } = listing((stream, step) =>
    step === 1 ? stream(delta("Thinking", "I should list them."), delta("Text", "List"), delta("Text", "ing.")) : stream(delta("Text", "One file: a.ts.")),
  );
  const from = session.journal.findIndex((input) => input._tag === "Observed" && input.observation._tag === "TurnStarted");
  const loaded = messages(project(session.journal, replay).updates);
  expect(loaded.map(([, text]) => text)).toEqual(["I should list them.", "Listing.", "One file: a.ts."]);
  for (const updates of everyMerge(session.journal.slice(0, from), session.journal.slice(from), items)) {
    expect(messages(updates)).toEqual(loaded);
    expect(updates.filter((update) => update.sessionUpdate === "tool_call")).toHaveLength(1);
  }
});

test("every merge of two turns' facts and their streamed items sends each turn's text once, in the messages that replay names, either feed a turn ahead", () => {
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
  const loaded = messages(project(session.journal, replay).updates);
  expect(loaded.map(([, text]) => text)).toEqual(["Hello.", "Hi again."]);
  for (const updates of everyMerge(session.journal.slice(0, from), session.journal.slice(from), items)) expect(messages(updates)).toEqual(loaded);
});

test("a call that fails: failed, with the tool's error as its content and, as recorded, its raw output", () => {
  const rm = { call: "c1", tool: "rm", input: json({ path: "a.ts" }) };
  const { inputs, fact } = recording();
  fact(asked("remove a.ts"));
  fact(dispatched());
  fact(responded([{ _tag: "ToolCall", ...rm }]));
  fact({ _tag: "ToolCallDispatched", call: "c1" });
  fact({ _tag: "ToolEnded", call: "c1", outcome: { _tag: "Failed", reason: { _tag: "Reported", error: json({ error: "no such file" }) } } });
  expect(project(inputs, live).updates).toEqual([
    announced(rm, "rm", "delete"),
    updated("c1", "in_progress"),
    updated("c1", "failed", { content: output('{"error":"no such file"}'), rawOutput: { error: "no such file" } }),
  ] as never);
});

test("a call a policy vetoed: pending while asked, then failed with the reason, as its content and its raw output, and never in progress", () => {
  const rm = { call: "c1", tool: "rm", input: json({ path: "a.ts" }) };
  const { inputs, fact } = recording();
  fact(asked("remove a.ts"));
  fact(dispatched());
  fact(responded([{ _tag: "ToolCall", ...rm }]));
  fact({ _tag: "PermissionAsked", call: "c1", asks: json({ tool: "rm" }) });
  fact({ _tag: "PermissionAnswered", call: "c1", answer: json({ optionId: "reject-once" }) });
  fact({ _tag: "ToolEnded", call: "c1", outcome: { _tag: "Failed", reason: { _tag: "Vetoed", reason: { mediaType: "text/plain", body: { _tag: "Text", text: "The user said no." } } } } });
  expect(project(inputs, live).updates).toEqual([
    announced(rm, "rm", "delete"),
    updated("c1", "pending"),
    updated("c1", "failed", { content: output("Not run: The user said no."), rawOutput: "The user said no." }),
  ] as never);
});

test("a call announced by ToolCallArrived is not announced again by its part or its response, even after it ended", () => {
  const { inputs } = listing();
  const updates = project(inputs, live).updates;
  expect(updates.filter((update) => update.sessionUpdate === "tool_call")).toEqual([announced(ls, "ls", "read")] as never);
  expect(updates.at(-1)).toMatchObject(said("One file: a.ts."));
});

test("a host's presentation is shown in place of the default: title, kind and locations when announced, its content and what changed when ended", () => {
  const present: Present = (call, outcome) =>
    Effect.succeed({
      title: outcome === undefined ? `List ${call.tool}` : "Listed",
      kind: outcome === undefined ? "search" : "read",
      locations: [{ path: "/work" }],
      content: (outcome === undefined ? output("listing /work") : output("1 file")) as never,
    });
  const { inputs } = listing();
  expect(project(inputs, { mode: "live", present }).updates.slice(0, 3)).toEqual([
    { ...announced(ls, "List ls", "search"), locations: [{ path: "/work" }], content: output("listing /work") },
    updated("c1", "in_progress"),
    updated("c1", "completed", { title: "Listed", kind: "read", locations: [{ path: "/work" }], content: output("1 file"), rawOutput: ["a.ts"] }),
  ] as never);
});

test("projecting stored facts gives the state to go on from live: a call already shown is not shown again, and the next turn's deltas are sent once", () => {
  const { session, fact, stream, inputs } = recording();
  fact(asked("list the files"));
  fact(dispatched());
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
  expect(unnamed(project(inputs.slice(from), live, loaded.state).updates)).toEqual([
    said("Listing."),
    updated("c1", "in_progress"),
    updated("c1", "completed", { content: output('["a.ts"]'), rawOutput: ["a.ts"] }),
    said("One "),
    said("file."),
  ] as never);
});

/** The updates of `inputs` in the order given, each through `next`: what a replay gave without `inLiveOrder`. */
const inStoredOrder = (inputs: ReadonlyArray<ProjectionInput>, context: ProjectionContext) =>
  inputs.reduce<{ state: ProjectionState; updates: Array<SessionUpdate> }>(
    (done, input) => {
      const step = next(done.state, input, context);
      return { state: step.state, updates: [...done.updates, ...step.updates] };
    },
    { state: start, updates: [] },
  );

/** Each update's kind, a call update's with its status; consecutive chunks of one kind count once, since deltas split text. */
const kinds = (updates: ReadonlyArray<SessionUpdate>) =>
  updates
    .map((update) => (update.sessionUpdate === "tool_call_update" ? `${update.sessionUpdate}:${update.status}` : update.sessionUpdate))
    .filter((kind, index, all) => !(kind.endsWith("_chunk") && all[index - 1] === kind));

const withoutInputs = (updates: ReadonlyArray<SessionUpdate>) => updates.filter((update) => update.sessionUpdate !== "user_message_chunk");

/** Whether `before` comes ahead of `after` among `facts`, by the observations' tags. */
const ahead = (facts: ReadonlyArray<Fact>, before: string, after: string) => {
  const at = (tag: string) => facts.findIndex((input) => input._tag === "Observed" && input.observation._tag === tag);
  return at(before) !== -1 && at(before) < at(after);
};

test("a call that arrived, ran and ended before its response was recorded is replayed after the response's thinking and text, as live sent them", () => {
  const { session, inputs } = listing(deltas);
  // As the loop records them: the call's facts, its end included, before the ModelResponded that holds it.
  expect(ahead(session.journal, "ToolEnded", "ModelResponded")).toBe(true);
  const loaded = project(session.journal, replay).updates;
  expect(unnamed(loaded.slice(1, 6))).toEqual([
    thought("I should list them."),
    said("Listing."),
    announced(ls, "ls", "read"),
    updated("c1", "in_progress"),
    updated("c1", "completed", { content: output('["a.ts"]'), rawOutput: ["a.ts"] }),
  ] as never);
  expect(kinds(withoutInputs(loaded))).toEqual(kinds(project(inputs, live).updates));
  expect(kinds(withoutInputs(inStoredOrder(session.journal, replay).updates))).not.toEqual(kinds(project(inputs, live).updates));
});

test("several requests in a turn: each response is taken before its own request's first call, and each text is sent once, in order", () => {
  const cat = { call: "c2", tool: "ls", input: json({ path: "src" }) };
  const { session, fact } = recording();
  fact(asked("list the files"));
  fact(dispatched());
  fact({ _tag: "ToolCallArrived", turn: "turn-1", ...ls });
  fact({ _tag: "ToolCallDispatched", call: "c1" });
  fact({ _tag: "ToolEnded", call: "c1", outcome: { _tag: "Succeeded", output: json(["a.ts"]) } });
  fact(responded([thinking("I should list them."), answer("Listing."), { _tag: "ToolCall", ...ls }]));
  fact(dispatched());
  fact({ _tag: "ToolCallArrived", turn: "turn-1", ...cat });
  fact({ _tag: "ToolCallDispatched", call: "c2" });
  fact({ _tag: "ToolEnded", call: "c2", outcome: { _tag: "Succeeded", output: json(["b.ts"]) } });
  fact(responded([answer("And src."), { _tag: "ToolCall", ...cat }]));
  fact(dispatched());
  fact(responded([answer("Two files.")]));
  const loaded = project(session.journal, replay);
  expect(unnamed(loaded.updates)).toEqual([
    user("list the files"),
    thought("I should list them."),
    said("Listing."),
    announced(ls, "ls", "read"),
    updated("c1", "in_progress"),
    updated("c1", "completed", { content: output('["a.ts"]'), rawOutput: ["a.ts"] }),
    said("And src."),
    announced(cat, "ls", "read"),
    updated("c2", "in_progress"),
    updated("c2", "completed", { content: output('["b.ts"]'), rawOutput: ["b.ts"] }),
    said("Two files."),
  ] as never);
  expect(loaded.state).toEqual(inStoredOrder(session.journal, replay).state);
});

test("a response with two calls and text between them: each call is announced at its place among the parts, and the calls' status updates follow all of the response", () => {
  const rm = { call: "c2", tool: "rm", input: json({ path: "a.ts" }) };
  const { session, fact } = recording();
  fact(asked("list, then remove a.ts"));
  fact(dispatched());
  fact({ _tag: "ToolCallArrived", turn: "turn-1", ...ls });
  fact({ _tag: "ToolCallDispatched", call: "c1" });
  fact({ _tag: "ToolCallArrived", turn: "turn-1", ...rm });
  fact({ _tag: "ToolCallDispatched", call: "c2" });
  fact({ _tag: "ToolEnded", call: "c1", outcome: { _tag: "Succeeded", output: json(["a.ts"]) } });
  fact({ _tag: "ToolEnded", call: "c2", outcome: { _tag: "Succeeded", output: json("removed") } });
  fact(responded([answer("Listing."), { _tag: "ToolCall", ...ls }, answer("Removing."), { _tag: "ToolCall", ...rm }]));
  // The whole response comes first, its calls announced in part order; then the calls' facts as recorded,
  // whose ToolCallArrived announce nothing more.
  expect(unnamed(project(session.journal, replay).updates)).toEqual([
    user("list, then remove a.ts"),
    said("Listing."),
    announced(ls, "ls", "read"),
    said("Removing."),
    announced(rm, "rm", "delete"),
    updated("c1", "in_progress"),
    updated("c2", "in_progress"),
    updated("c1", "completed", { content: output('["a.ts"]'), rawOutput: ["a.ts"] }),
    updated("c2", "completed", { content: output('"removed"'), rawOutput: "removed" }),
  ] as never);
});

test("what has no call in its request is left in place: a request without calls, a request with no response, and a response with no request, whose messages its own seq names, with a warning", () => {
  const rm = { call: "c2", tool: "rm", input: json({ path: "a.ts" }) };
  const { session, fact } = recording();
  fact(asked("hi"));
  fact(dispatched());
  fact(responded([thinking("Greet."), answer("Hello.")]));
  fact(asked("remove a.ts"));
  // No ModelRequestDispatched: the response is not paired with a request, and stays after the call.
  fact({ _tag: "ToolCallArrived", turn: "turn-2", ...rm });
  fact(responded([answer("Removing.")], "Complete", "turn-2"));
  fact(dispatched("turn-2"));
  const loaded = projectLogged(session.journal, replay);
  const [hi, remove] = seqsOf(session.journal, "InputArrived");
  const [request] = seqsOf(session.journal, "ModelRequestDispatched");
  const [, unpaired] = seqsOf(session.journal, "ModelResponded");
  expect(loaded.updates).toEqual(inStoredOrder(session.journal, replay).updates);
  expect(loaded.updates).toEqual([
    user("hi", `${hi}`),
    thought("Greet.", `${request}:0`),
    said("Hello.", `${request}:1`),
    user("remove a.ts", `${remove}`),
    announced(rm, "rm", "delete"),
    said("Removing.", `${unpaired}:0`),
  ] as never);
  expect(loaded.logged).toEqual([{ level: "Warn", key: logKeys.update.noDispatch, details: { response: unpaired }, annotations: { turn: "turn-2" } }]);
  expect(loaded.state).toEqual(inStoredOrder(session.journal, replay).state);
});

test("a request the harness answered as interrupted, as the core records it: the call announced once, by the response's part, and then failed", () => {
  const rm = { call: "c1", tool: "rm", input: json({ path: "a.ts" }) };
  const { session, fact } = recording();
  fact(asked("remove a.ts"));
  fact(dispatched());
  fact({ _tag: "ToolCallArrived", turn: "turn-1", ...rm });
  fact({ _tag: "ToolCallDispatched", call: "c1" });
  // What `endTurnLeftRunning` records once the process running them has ended (agent-machine `notObserved`): the end of each call
  // still running, then the request's response, which carries the calls that had arrived as its parts.
  fact({ _tag: "TurnInterrupted", turn: "turn-1" });
  fact({ _tag: "ToolEnded", call: "c1", outcome: { _tag: "Failed", reason: { _tag: "Indeterminate" } } });
  fact(responded([{ _tag: "ToolCall", ...rm }], "Indeterminate"));
  expect(ahead(session.journal, "ToolEnded", "ModelResponded")).toBe(true);
  const loaded = project(session.journal, replay);
  // The response moves before the arrival and announces the call from its part; the arrival then announces nothing, as a call is announced once, so the updates are those of the stored order.
  expect(loaded.updates).toEqual(inStoredOrder(session.journal, replay).updates);
  expect(unnamed(loaded.updates)).toEqual([
    user("remove a.ts"),
    announced(rm, "rm", "delete"),
    updated("c1", "in_progress"),
    updated("c1", "failed", { content: output("How it ended was not observed") }),
  ] as never);
  expect(loaded.updates.filter((update) => update.sessionUpdate === "tool_call")).toHaveLength(1);
  expect(loaded.state).toEqual(inStoredOrder(session.journal, replay).state);
});

test("a request the harness answered as interrupted whose call had ended before the process did: the call is announced once, by the response's part, and completed", () => {
  const rm = { call: "c1", tool: "rm", input: json({ path: "a.ts" }) };
  const { session, fact } = recording();
  fact(asked("remove a.ts"));
  fact(dispatched());
  fact({ _tag: "ToolCallArrived", turn: "turn-1", ...rm });
  fact({ _tag: "ToolCallDispatched", call: "c1" });
  fact({ _tag: "ToolEnded", call: "c1", outcome: { _tag: "Succeeded", output: json(["a.ts"]) } });
  // The request was still streaming: the harness gives it the calls that had arrived, and records no end for one that had ended.
  fact({ _tag: "TurnInterrupted", turn: "turn-1" });
  fact(responded([{ _tag: "ToolCall", ...rm }], "Indeterminate"));
  const loaded = project(session.journal, replay);
  expect(loaded.updates).toEqual(inStoredOrder(session.journal, replay).updates);
  expect(unnamed(loaded.updates)).toEqual([
    user("remove a.ts"),
    announced(rm, "rm", "delete"),
    updated("c1", "in_progress"),
    updated("c1", "completed", { content: output('["a.ts"]'), rawOutput: ["a.ts"] }),
  ] as never);
  expect(loaded.updates.filter((update) => update.sessionUpdate === "tool_call")).toHaveLength(1);
  expect(loaded.state).toEqual(inStoredOrder(session.journal, replay).state);
});

test("captured items mixed into a replay keep their place and change nothing it sends; the reorder only reorders, and leaves the same state", () => {
  const { session, inputs } = listing();
  expect(inputs.some((input) => input._tag !== "Observed" && input._tag !== "Decided")).toBe(true);
  expect(project(inputs, replay).updates).toEqual(project(session.journal, replay).updates);
  const loaded = project(session.journal, replay);
  // Live does not reorder, and without captured items it echoes no input: the same updates as a replay, in the stored order.
  expect(encoded(withoutInputs(loaded.updates))).toEqual(encoded(project(session.journal, live).updates));
  expect(loaded.state).toEqual(inStoredOrder(session.journal, replay).state);
});

test("live does not reorder: a call recorded before its response is sent at its fact", () => {
  const { session } = listing();
  const updates = project(session.journal, live).updates;
  expect(unnamed(updates.slice(0, 4))).toEqual([
    announced(ls, "ls", "read"),
    updated("c1", "in_progress"),
    updated("c1", "completed", { content: output('["a.ts"]'), rawOutput: ["a.ts"] }),
    thought("I should list them."),
  ] as never);
});

test("a part its deltas sent only some of: the rest of it is sent, and each part of that kind after it whole", () => {
  const { inputs, stream, fact } = recording();
  fact(asked("hello"));
  fact(dispatched());
  stream(delta("Text", "Hel"));
  fact(responded([answer("Hello."), answer("Bye.")]));
  expect(unnamed(project(inputs, live).updates)).toEqual([said("Hel"), said("lo."), said("Bye.")]);
});

test("a turn that ended keeps no text in the state", () => {
  const { inputs, stream, fact, session } = recording();
  fact(asked("hello"));
  fact(dispatched());
  stream(delta("Text", "Hel"));
  fact(responded([answer("Hello.")]));
  stream(ended());
  expect(session.journal.some((each) => each._tag === "Decided" && each.decision._tag === "TurnEnded")).toBe(true);
  const { state } = project(inputs, live);
  expect([...state.texts.keys()]).toEqual([]);
  expect([...state.ended].map(String)).toEqual(["turn-1"]);
});

test("a request ends at its response: a second response with no request between is left in place", () => {
  const rm = (call: string) => ({ call, tool: "rm", input: json({ path: "a.ts" }) });
  const { session, fact } = recording();
  fact(asked("remove a.ts"));
  fact(dispatched());
  fact({ _tag: "ToolCallArrived", turn: "turn-1", ...rm("c1") });
  fact(responded([{ _tag: "ToolCall", ...rm("c1") }]));
  fact({ _tag: "ToolCallArrived", turn: "turn-1", ...rm("c2") });
  fact(responded([answer("Removed.")]));
  // The second response has no request, which logs a warning: taken here, not printed.
  expect(unnamed(projectLogged(session.journal, replay).updates)).toEqual([user("remove a.ts"), announced(rm("c1"), "rm", "delete"), announced(rm("c2"), "rm", "delete"), said("Removed.")] as never);
});

test("a call whose part arrives on the streamed feed before its ToolCallArrived is announced at its place, before the text that streams after it", () => {
  const { inputs, fact, stream } = recording();
  fact(asked("list the files"));
  fact(dispatched());
  stream(arrived({ _tag: "ToolCall", ...ls }), delta("Text", "Listing."));
  fact({ _tag: "ToolCallArrived", turn: "turn-1", ...ls });
  expect(unnamed(project(inputs, live).updates)).toEqual([announced(ls, "ls", "read"), said("Listing.")] as never);
});

test("after a request answered before its end item, the next request of the turn sends its deltas as they come", () => {
  const { session, items } = listing(deltas);
  const facts = session.journal;
  const firstResponded = facts.findIndex((fact) => fact._tag === "Observed" && fact.observation._tag === "ModelResponded");
  const secondDispatched = facts.findIndex((fact, at) => at > firstResponded && fact._tag === "Observed" && fact.observation._tag === "ModelRequestDispatched");
  const firstEnd = items.findIndex((item) => item._tag === "ModelResponseEnded");
  // The first request's items but its end item; its response; then its end item, and the second request.
  const inputs: ReadonlyArray<ProjectionInput> = [
    ...facts.slice(0, firstResponded),
    ...items.slice(0, firstEnd),
    ...facts.slice(firstResponded, secondDispatched + 1),
    ...items.slice(firstEnd),
    ...facts.slice(secondDispatched + 1),
  ];
  const updates = project(inputs, live).updates;
  expect(unnamed(updates.filter((update) => update.sessionUpdate === "agent_message_chunk"))).toEqual([said("List"), said("ing."), said("One file"), said(": a.ts.")] as never);
});

test("whitespace that ends a request's text is sent in that request's message, from its response, and not with the next request's text", () => {
  const { session, inputs, fact, stream } = recording();
  fact(asked("list the files"));
  fact(dispatched());
  stream(delta("Text", "Listing."), delta("Text", "\n"), ended());
  fact(responded([answer("Listing.\n"), { _tag: "ToolCall", ...ls }]));
  fact({ _tag: "ToolCallDispatched", call: "c1" });
  fact({ _tag: "ToolEnded", call: "c1", outcome: { _tag: "Succeeded", output: json(["a.ts"]) } });
  fact(dispatched());
  stream(delta("Text", "Done."), ended());
  fact(responded([answer("Done.")]));
  const [first, second] = seqsOf(session.journal, "ModelRequestDispatched");
  const updates = project(inputs, live).updates;
  expect(updates.filter((update) => update.sessionUpdate === "agent_message_chunk")).toEqual([said("Listing.", `${first}:0`), said("\n", `${first}:0`), said("Done.", `${second}:0`)] as never);
  expect(messages(updates)).toEqual(messages(project(session.journal, replay).updates));
});

test("a thought streamed with a trailing newline as a delta of its own, then a call: the thought's message has the newline, in every merge of the feeds and on replay, its part passed on before the call or after it", () => {
  const call = { _tag: "ToolCall", ...ls };
  // As the Anthropic adapter passes them on, each part when it is whole; and as the Chat Completions adapter does, a call when it is whole and the text's parts after the last delta.
  const orders = [
    [delta("Thinking", "Plan."), delta("Thinking", "\n"), arrived(thinking("Plan.\n")), arrived(call), ended()],
    [delta("Thinking", "Plan."), delta("Thinking", "\n"), arrived(call), arrived(thinking("Plan.\n")), ended()],
  ];
  for (const items of orders) {
    const { session, fact, stream } = recording();
    fact(asked("list the files"));
    const from = session.journal.findIndex((input) => input._tag === "Observed" && input.observation._tag === "TurnStarted");
    fact(dispatched());
    stream(...items);
    fact({ _tag: "ToolCallArrived", turn: "turn-1", ...ls });
    fact(responded([thinking("Plan.\n"), call]));
    const [request] = seqsOf(session.journal, "ModelRequestDispatched");
    const loaded = messages(project(session.journal, replay).updates);
    expect(loaded).toEqual([[`agent_thought_chunk ${request}:0`, "Plan.\n"]]);
    for (const updates of everyMerge(session.journal.slice(0, from), session.journal.slice(from), items)) expect(messages(updates)).toEqual(loaded);
  }
});

test("the default presentation titles a call to a described tool by its intent, on one line; a call to any other tool, or with no intent, by its tool's name", () => {
  const look: Tool<{ readonly path: typeof Schema.String }> = { name: ToolName.make("look"), kind: "read", replay: "safe", description: "Looks.", input: Schema.Struct({ path: Schema.String }), run: () => Effect.succeed("") };
  const issue: ToolSpec = {
    name: ToolName.make("create_issue"),
    description: "Creates an issue.",
    input: jsonSchemaOf(Schema.Struct({ intent: Schema.String.annotate({ description: "Why the issue is filed." }) })),
    kind: "edit",
    replay: "unsafe",
  };
  const catalog = [anyTool(described(look)).spec, issue];
  const titled = (tool: string, input: object) => Effect.runSync(presentFrom(catalog)({ call: CallId.make("c1"), tool: ToolName.make(tool), input: receivedJson(input as never) })).title;
  expect(titled("look", { path: ".", intent: "Look at\n  the working folder." })).toBe("Look at the working folder.");
  expect(titled("look", { path: "." })).toBe("look");
  expect(titled("create_issue", { intent: "A reason of several paragraphs." })).toBe("create_issue");
});

/** A call's announcement and its end: the updates that carry its name, its input and its raw output. */
const announcedAndEnded = (updates: ReadonlyArray<SessionUpdate>) =>
  updates.filter((update) => update.sessionUpdate === "tool_call" || (update.sessionUpdate === "tool_call_update" && (update.status === "completed" || update.status === "failed")));

test("a call's tool_call carries its tool's name and its input; its end, what it returned as recorded: JSON parsed, text as text, a failure's reason, and for bytes no rawOutput but a link to them; replay sends the same", () => {
  const cat = { call: "c2", tool: "cat", input: json({ path: "a.ts" }) };
  const rm = { call: "c3", tool: "rm", input: json({ path: "a.ts" }) };
  const shot = { call: "c4", tool: "screenshot", input: json({}) };
  const blob = "ab".repeat(32);
  const plain = (text: string) => ({ mediaType: "text/plain", body: { _tag: "Text", text } });
  const outcomes = [
    { call: "c1", outcome: { _tag: "Succeeded", output: json(["a.ts"]) } },
    { call: "c2", outcome: { _tag: "Succeeded", output: plain("export {};\n") } },
    { call: "c3", outcome: { _tag: "Failed", reason: { _tag: "Reported", error: plain("a.ts is read-only") } } },
    { call: "c4", outcome: { _tag: "Succeeded", output: { mediaType: "image/png", body: { _tag: "Stored", id: blob, size: 70000 } } } },
  ];
  const { session, inputs, fact } = recording();
  fact(asked("look at a.ts"));
  fact(dispatched());
  for (const call of [ls, cat, rm, shot]) fact({ _tag: "ToolCallArrived", turn: "turn-1", ...call });
  for (const { call } of outcomes) fact({ _tag: "ToolCallDispatched", call });
  for (const ended of outcomes) fact({ _tag: "ToolEnded", ...ended });
  fact(responded([ls, cat, rm, shot].map((call) => ({ _tag: "ToolCall", ...call }))));
  const sent = announcedAndEnded(project(inputs, live).updates);
  expect(sent).toEqual([
    announced(ls, "ls", "read"),
    announced(cat, "cat"),
    announced(rm, "rm", "delete"),
    announced(shot, "screenshot"),
    updated("c1", "completed", { content: output('["a.ts"]'), rawOutput: ["a.ts"] }),
    updated("c2", "completed", { content: output("export {};\n"), rawOutput: "export {};\n" }),
    updated("c3", "failed", { content: output("a.ts is read-only"), rawOutput: "a.ts is read-only" }),
    // The bytes are in the blob store: the content names them and links to them, and JSON cannot carry them.
    updated("c4", "completed", {
      content: [
        ...output(`[70000 bytes of image/png: blob://${blob}.png]`),
        { type: "content", content: { type: "resource_link", uri: `blob://${blob}.png`, name: `${blob}.png`, mimeType: "image/png", size: 70000 } },
      ],
    }),
  ] as never);
  expect(announcedAndEnded(project(session.journal, replay).updates)).toEqual(sent);
});

test("a call announced again with another input than the client has: a tool_call_update carries that input as rawInput, once", () => {
  const src = { ...ls, input: json({ path: "src" }) };
  const { inputs, fact, stream } = recording();
  fact(asked("list the files"));
  fact(dispatched());
  stream(arrived({ _tag: "ToolCall", ...ls }));
  fact({ _tag: "ToolCallArrived", turn: "turn-1", ...src });
  fact(responded([{ _tag: "ToolCall", ...src }]));
  expect(project(inputs, live).updates).toEqual([announced(ls, "ls", "read"), { sessionUpdate: "tool_call_update", toolCallId: "c1", rawInput: { path: "src" } }] as never);
});

test("a call's input and output that claim JSON and do not parse: rawInput and rawOutput carry their text, and a warning says so", () => {
  const broken = (text: string) => ({ mediaType: "application/json", body: { _tag: "Text", text } });
  const { inputs, fact } = recording();
  fact(asked("list the files"));
  fact(dispatched());
  fact({ _tag: "ToolCallArrived", turn: "turn-1", call: "c1", tool: "ls", input: broken('{"path": ') });
  fact({ _tag: "ToolCallDispatched", call: "c1" });
  fact({ _tag: "ToolEnded", call: "c1", outcome: { _tag: "Succeeded", output: broken("a.ts") } });
  const { updates, logged } = projectLogged(inputs, live);
  expect(announcedAndEnded(updates)).toMatchObject([{ sessionUpdate: "tool_call", rawInput: '{"path": ' }, { sessionUpdate: "tool_call_update", rawOutput: "a.ts" }]);
  const warned = (field: string, text: string) => ({
    level: "Warn",
    key: logKeys.update.rawNotJson,
    details: { field, tool: "ls", mediaType: "application/json", cause: expect.stringContaining("not JSON"), text: { chars: text.length, start: text } },
    annotations: { call: "c1" },
  });
  expect(logged).toEqual([warned("rawInput", '{"path": '), warned("rawOutput", "a.ts")]);
});

test("a response's thinking, its text, a call and its text after the call are three messages, live from deltas, parts and the response's rest, and on replay", () => {
  const { session, inputs, items, fact, stream } = recording();
  fact(asked("list the files"));
  fact(dispatched());
  stream(delta("Thinking", "Plan."), arrived(thinking("Plan.")), delta("Text", "Listing."), arrived(answer("Listing.")), arrived({ _tag: "ToolCall", ...ls }));
  fact({ _tag: "ToolCallArrived", turn: "turn-1", ...ls });
  stream(delta("Text", "Do"), delta("Text", "ne."), arrived(answer("Done.")), ended());
  fact(responded([thinking("Plan."), answer("Listing."), { _tag: "ToolCall", ...ls }, answer("Done.")]));
  const [request] = seqsOf(session.journal, "ModelRequestDispatched");
  const expected: ReadonlyArray<readonly [string, string]> = [
    [`agent_thought_chunk ${request}:0`, "Plan."],
    [`agent_message_chunk ${request}:1`, "Listing."],
    [`agent_message_chunk ${request}:2`, "Done."],
  ];
  expect(messages(project(inputs, live).updates)).toEqual(expected);
  expect(messages(project(session.journal, replay).updates)).toEqual(expected);
  // The response taken after "Do": the rest of the part from it goes in the message that "Do" began.
  const at = session.journal.findIndex((input) => input._tag === "Observed" && input.observation._tag === "ModelResponded");
  const early = [...session.journal.slice(0, at), ...items.slice(0, 6), session.journal[at] as Fact, ...items.slice(6), ...session.journal.slice(at + 1)];
  expect(project(early, live).updates.filter((update) => update.sessionUpdate === "agent_message_chunk").slice(-2)).toEqual([said("Do", `${request}:2`), said("ne.", `${request}:2`)] as never);
});

test("two responses of only text with nothing between them, the second asked after the first was unfinished, are two messages, live and on replay", () => {
  const { session, inputs, fact, stream } = recording();
  fact(asked("check the files"));
  fact(dispatched());
  stream(delta("Text", "Let me check."), ended());
  fact(responded([answer("Let me check.")], "Unfinished"));
  fact(dispatched());
  stream(delta("Text", "Done."), ended());
  fact(responded([answer("Done.")]));
  const [first, second] = seqsOf(session.journal, "ModelRequestDispatched");
  expect(project(inputs, live).updates).toEqual([said("Let me check.", `${first}:0`), said("Done.", `${second}:0`)]);
  expect(withoutInputs(project(session.journal, replay).updates)).toEqual([said("Let me check.", `${first}:0`), said("Done.", `${second}:0`)] as never);
});

test("a fallback that answers after the first provider failed with 503: the request's first dispatch names its messages, in every merge of the feeds and on replay", () => {
  const { session, fact, stream, items } = recording();
  fact(asked("hi"));
  const from = session.journal.findIndex((input) => input._tag === "Observed" && input.observation._tag === "TurnStarted");
  fact(dispatched());
  fact({ _tag: "ModelAttemptFailed", turn: "turn-1", provider: "boring", model: "boring-1", failure: "HTTP 503: overloaded", error: json({ status: 503 }) });
  fact({ _tag: "ModelRequestDispatched", turn: "turn-1", provider: "fallback", model: "fallback-1", sent: json({}) });
  stream(delta("Text", "Hel"), delta("Text", "lo."), ended());
  fact({ ...responded([answer("Hello.")]), provider: "fallback", model: "fallback-1" });
  const [first] = seqsOf(session.journal, "ModelRequestDispatched");
  const loaded = messages(project(session.journal, replay).updates);
  expect(loaded).toEqual([[`agent_message_chunk ${first}:0`, "Hello."]]);
  for (const updates of everyMerge(session.journal.slice(0, from), session.journal.slice(from), items)) expect(messages(updates)).toEqual(loaded);
});

test("a session loaded and gone on with: the replay names each message as live did, and a later turn's messages take ids that no earlier message has", () => {
  const { session, inputs, fact, stream } = recording();
  fact(asked("one"));
  fact(dispatched());
  stream(delta("Text", "One."), ended());
  fact(responded([answer("One.")]));
  const loaded = project(session.journal, replay);
  expect(messages(loaded.updates)).toEqual(messages(project(inputs, live).updates));
  const from = inputs.length;
  fact(asked("two"));
  fact(dispatched("turn-2"));
  stream(delta("Text", "Two.", "turn-2"), ended("turn-2"));
  fact(responded([answer("Two.")], "Complete", "turn-2"));
  const later = project(inputs.slice(from), live, loaded.state).updates;
  const [one, two] = seqsOf(session.journal, "InputArrived");
  const [first, second] = seqsOf(session.journal, "ModelRequestDispatched");
  expect(loaded.updates).toEqual([user("one", `${one}`), said("One.", `${first}:0`)]);
  expect(later).toEqual([said("Two.", `${second}:0`)]);
  // A second load sends the ids that the first load and the live turn after it sent.
  expect(project(session.journal, replay).updates).toEqual([...loaded.updates, user("two", `${two}`), ...later]);
});

test("a call's changed files are diffs from its details: a created file from no text, an update as one diff per hunk, and a cut patch followed by how much was left out", () => {
  const text = (value: string) => ({ mediaType: "text/plain", body: { _tag: "Text", text: value } }) as never;
  const patch = ["--- /w/a.txt", "+++ /w/a.txt", "@@ -1,1 +1,1 @@", "-one", "+two", "@@ -20,1 +20,1 @@", "-x", "+y"].join("\n");
  expect(
    changedFiles({
      _tag: "Succeeded",
      output: text("done"),
      details: [
        { _tag: "FileChanged", path: "/w/new.txt" as never, change: "created", patch: text("hi\n") },
        { _tag: "FileChanged", path: "/w/a.txt" as never, change: "updated", patch: text(patch), cut: 120 as never },
      ],
    }) as unknown,
  ).toEqual([
    { type: "diff", path: "/w/new.txt", oldText: null, newText: "hi\n" },
    { type: "diff", path: "/w/a.txt", oldText: "one\n", newText: "two\n" },
    { type: "diff", path: "/w/a.txt", oldText: "x\n", newText: "y\n" },
    { type: "content", content: { type: "text", text: "The diff of /w/a.txt was cut at 32 KiB: 120 more bytes are not shown." } },
  ]);
  expect(changedFiles({ _tag: "Failed", reason: { _tag: "NotRun" } })).toEqual([]);
});
