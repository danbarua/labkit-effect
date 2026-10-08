/** The OpenAI-compatible Chat Completions adapter: how the core's types are shaped into its wire format and back. */

import { userInput } from "../../../tests/support/observations.ts";
import { afterAll, expect } from "bun:test";
import { test } from "../../../tests/support/test.ts";
import { Effect, Layer, Logger } from "effect";
import * as IdGenerator from "effect/ai/IdGenerator";
import { CallId, ModelName, ProviderName, ThinkingText, ToolName, TurnId } from "../../agent-machine/names.ts";
import { ModelStream, type Streamed } from "../model-stream.ts";
import { ModelClient, type ModelContext } from "../contracts.ts";
import { logKeys } from "../log-keys.ts";
import { receivedJson } from "../received.ts";
import { BoringModelProvider } from "../../../tests/support/boring.ts";
import { CountingTurns } from "../turns.ts";
import { openSession } from "../loop.ts";
import { EphemeralSessionStore } from "../session-store.ts";
import { OpenAiCompatModelClient } from "./openai-compat-client.ts";
import { SmolToolRunner, smolCatalog } from "../../../tests/support/smol-tools.ts";
import { TurnContextAssembler } from "../turn-context.ts";
import { openAiCompatAt, recordingServer } from "../../../tests/support/providers.ts";
import { json } from "../../../tests/support/received.ts";
import { chatChunks } from "../../../tests/support/streams.ts";
import { runTest } from "../../../tests/support/run.ts";
import { boringOpening } from "../../../tests/support/boring.ts";

const stops: Array<() => unknown> = [];
afterAll(() => {
  for (const stop of stops) stop();
});

/** A logger that keeps each line's level and message. */
function capturing() {
  const logged: Array<{ readonly level: string; readonly message: unknown }> = [];
  const capture = Logger.make((options) => {
    logged.push({ level: options.logLevel, message: options.message });
  });
  return { logged, layer: Logger.layer([capture], { mergeWithExisting: true }) };
}

/** The client's layer for the server at `url`, with `ids` as its `IdGenerator` when given. */
const clientAt = (url: URL, ids?: IdGenerator.Service) =>
  OpenAiCompatModelClient.pipe(Layer.provide(Layer.mergeAll(openAiCompatAt(url), ids === undefined ? Layer.empty : Layer.succeed(IdGenerator.IdGenerator, ids))));

/** The warnings that a call was given an id: each one's details. */
const idsSupplied = (logged: ReadonlyArray<{ readonly level: string; readonly message: unknown }>) =>
  logged.flatMap(({ level, message }) => (Array.isArray(message) && message[0] === logKeys.provider.callIdSupplied ? [{ level, details: message[1] as Record<string, unknown> }] : []));

async function turn(responses: ReadonlyArray<unknown>) {
  const provider = recordingServer(responses);
  stops.push(provider.stop);
  const { logged, layer } = capturing();
  const facts = await runTest(
    Effect.gen(function* () {
      const session = yield* openSession.pipe(Effect.provide(EphemeralSessionStore));
      yield* session.observe(boringOpening(smolCatalog));
      yield* session.idle;
      yield* session.observe(userInput("What is 2 + 3?"));
      yield* session.idle;
      return yield* session.facts;
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          BoringModelProvider,
          TurnContextAssembler,
          clientAt(provider.url),
          CountingTurns,
          SmolToolRunner,
          layer,
        ),
      ),
    ),
  );
  return { provider, facts, logged };
}

const choice = (message: unknown, finish_reason: string) => ({ id: "chatcmpl-1", choices: [{ index: 0, message, finish_reason }] });
const callsAdd = choice(
  { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "add", arguments: '{"a":2,"b":3}' } }] },
  "tool_calls",
);
const answers = choice({ role: "assistant", content: "5." }, "stop");

test("a tool turn sends the catalog, then the call and a tool message with its result", async () => {
  const { provider, facts, logged } = await turn([callsAdd, answers]);
  const tools = smolCatalog.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.input },
  }));
  const question = { role: "user", content: [{ type: "text", text: "What is 2 + 3?" }] };
  expect(provider.paths).toEqual(["/chat/completions", "/chat/completions"]);
  expect(provider.headers[0]).toMatchObject({ authorization: "Bearer test-key" });
  const streaming = { stream: true, stream_options: { include_usage: true } };
  expect(provider.bodies).toEqual([
    { model: "boring-1", messages: [question], tools, ...streaming },
    {
      model: "boring-1",
      messages: [
        question,
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "add", arguments: '{"a":2,"b":3}' } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "5" },
      ],
      tools,
      ...streaming,
    },
  ]);
  expect(facts.at(-1) as unknown).toMatchObject({ decision: { _tag: "TurnEnded", ending: { _tag: "Completed" } } });
  // The server gave the call its id, so none is supplied.
  expect(idsSupplied(logged)).toEqual([]);
});

test("a call that arrives with no id is given one: the facts record it, its result is sent back under it, and a warning says so", async () => {
  const received = { type: "function", function: { name: "add", arguments: '{"a":2,"b":3}' } };
  const { provider, facts, logged } = await turn([choice({ role: "assistant", content: null, tool_calls: [received] }, "tool_calls"), answers]);
  const responded = facts.find((fact) => fact._tag === "Observed" && fact.observation._tag === "ModelResponded");
  const call = responded?._tag === "Observed" && responded.observation._tag === "ModelResponded" ? responded.observation.parts[0] : undefined;
  if (call?._tag !== "ToolCall") throw new Error(`expected a ToolCall, got ${JSON.stringify(call)}`);
  expect(call.call).toMatch(/^call_labkit_[0-9A-Za-z]{16}$/);
  const ended = facts.find((fact) => fact._tag === "Observed" && fact.observation._tag === "ToolEnded");
  expect(ended as unknown).toMatchObject({ observation: { call: call.call, outcome: { _tag: "Succeeded" } } });
  const second = provider.bodies[1] as { readonly messages: ReadonlyArray<unknown> };
  expect(second.messages.slice(1)).toEqual([
    { role: "assistant", content: null, tool_calls: [{ id: call.call, ...received }] },
    { role: "tool", tool_call_id: call.call, content: "5" },
  ]);
  expect(idsSupplied(logged)).toEqual([{ level: "Warn", details: { turn: "turn-1", tool: "add", id: call.call, received: { id: null, ...received } } }]);
});

test("the choice's message becomes parts: thinking, content, calls to any tool name, and other fields kept whole", async () => {
  const { facts } = await turn([
    choice(
      {
        role: "assistant",
        content: "Reading.",
        reasoning_content: "The user wants a file.",
        refusal: "none of it",
        tool_calls: [{ id: "call_9", type: "function", function: { name: "___read_", arguments: '{"path":"a.ts"}' } }],
      },
      "tool_calls",
    ),
    answers,
  ]);
  const responded = facts.find((fact) => fact._tag === "Observed" && fact.observation._tag === "ModelResponded");
  expect(responded as unknown).toMatchObject({
    observation: {
      stop: "tool_calls",
      ending: { _tag: "Complete" },
      parts: [
        { _tag: "Thinking", text: "The user wants a file.", received: json({ reasoning_content: "The user wants a file." }) },
        { _tag: "Text", text: "Reading." },
        { _tag: "Unrecognised", received: json({ refusal: "none of it" }) },
        { _tag: "ToolCall", call: "call_9", tool: "___read_" },
      ],
    },
  });
  const ended = facts.find((fact) => fact._tag === "Observed" && fact.observation._tag === "ToolEnded");
  expect(ended as unknown).toMatchObject({ observation: { call: "call_9", outcome: { _tag: "Failed", reason: { _tag: "NotFound" } } } });
});

test("what a response held besides its text and calls goes back to its provider as it came: the message's fields, and a call's", async () => {
  const signed = { google: { thought_signature: "c2ln" } };
  const { provider, facts } = await turn([
    choice(
      {
        role: "assistant",
        content: null,
        reasoning_content: "Add them.",
        refusal: "none of it",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "add", arguments: '{"a":2,"b":3}' }, extra_content: signed }],
      },
      "tool_calls",
    ),
    answers,
  ]);
  const responded = facts.find((fact) => fact._tag === "Observed" && fact.observation._tag === "ModelResponded");
  expect(responded as unknown).toMatchObject({
    observation: {
      parts: [
        { _tag: "Thinking", text: "Add them." },
        { _tag: "Unrecognised", received: json({ refusal: "none of it" }) },
        { _tag: "ToolCall", call: "call_1", tool: "add" },
        {
          _tag: "Unrecognised",
          received: json({ tool_calls: [{ id: "call_1", type: "function", function: { name: "add", arguments: '{"a":2,"b":3}' }, extra_content: signed }] }),
        },
      ],
    },
  });
  const second = provider.bodies[1] as { readonly messages: ReadonlyArray<unknown> };
  expect(second.messages[1]).toEqual({
    role: "assistant",
    content: null,
    reasoning_content: "Add them.",
    refusal: "none of it",
    tool_calls: [{ id: "call_1", type: "function", function: { name: "add", arguments: '{"a":2,"b":3}' }, extra_content: signed }],
  });
});

/** Mistral's stream: its `content` a list holding a thinking chunk, then the thinking's end and the text's start, then text. */
const mistralStream = () => {
  const chunk = (delta: unknown, finish_reason: string | null = null, more = {}) => ({ id: "m1", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }], ...more });
  const think = (text: string, more = {}) => ({ type: "thinking", thinking: [{ type: "text", text }], ...more });
  return chatChunks([
    chunk({ role: "assistant", content: [think("Two and ")] }),
    chunk({ content: [think("three.")] }),
    chunk({ content: [think("", { closed: true }), { type: "text", text: "Add" }] }),
    chunk({ content: "ing." }),
    chunk({ tool_calls: [{ id: "call_1", index: 0, function: { name: "add", arguments: { a: 2, b: 3 } } }] }),
    chunk({ content: "" }, "tool_calls", { usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 } }),
  ]);
};

test("Mistral's content, a list of chunks that changes shape as it streams, is its thinking and its text, and goes back as it came", async () => {
  const { provider, facts } = await turn([mistralStream, answers]);
  const thought = { type: "thinking", thinking: [{ type: "text", text: "Two and three." }], closed: true };
  const responded = facts.find((fact) => fact._tag === "Observed" && fact.observation._tag === "ModelResponded");
  expect(responded as unknown).toMatchObject({
    observation: {
      parts: [
        { _tag: "Thinking", text: "Two and three.", received: json({ content: [thought] }) },
        { _tag: "Text", text: "Adding." },
        // Arguments sent as an object are its JSON.
        { _tag: "ToolCall", call: "call_1", tool: "add", input: json({ a: 2, b: 3 }) },
      ],
      usage: { input: 40, output: 12 },
    },
  });
  const second = provider.bodies[1] as { readonly messages: ReadonlyArray<unknown> };
  expect(second.messages[1]).toEqual({
    role: "assistant",
    content: [thought, { type: "text", text: "Adding." }],
    tool_calls: [{ id: "call_1", type: "function", function: { name: "add", arguments: '{"a":2,"b":3}' } }],
  });
});

test("a call's name sent whole again as it grows (llama.cpp) is the whole name", async () => {
  const chunk = (delta: unknown, finish_reason: string | null = null) => ({ id: "l1", choices: [{ index: 0, delta, finish_reason }] });
  const call = (fn: unknown, id?: string) => ({ tool_calls: [{ index: 0, ...(id === undefined ? {} : { id, type: "function" }), function: fn }] });
  const llama = () =>
    chatChunks([
      chunk({ role: "assistant", ...call({ name: "a", arguments: "" }, "call_1") }),
      chunk(call({ name: "ad" })),
      chunk(call({ name: "add", arguments: '{"a":2,' })),
      chunk(call({ arguments: '"b":3}' })),
      chunk({}, "tool_calls"),
    ]);
  const { facts } = await turn([llama, answers]);
  const responded = facts.find((fact) => fact._tag === "Observed" && fact.observation._tag === "ModelResponded");
  expect(responded as unknown).toMatchObject({ observation: { parts: [{ _tag: "ToolCall", call: "call_1", tool: "add", input: json({ a: 2, b: 3 }) }] } });
});

test.each([
  ["end_turn", "Complete"],
  ["model_length", "CutShort"],
])("finish_reason %s ends the response %s", async (finish, ending) => {
  const { facts } = await turn([choice({ role: "assistant", content: "5." }, finish)]);
  const responded = facts.find((fact) => fact._tag === "Observed" && fact.observation._tag === "ModelResponded");
  expect(responded as unknown).toMatchObject({ observation: { stop: finish, ending: { _tag: ending } } });
});

test.each([
  ["Groq's error in x_groq", { x_groq: { error: "over capacity" } }, null, 'The stream reported an error: "over capacity"'],
  ["finish_reason error", {}, "error", 'The response ended with finish_reason "error"'],
])("a response that fails: %s", async (_name, more, finish, failure) => {
  const failing = () =>
    chatChunks([
      { id: "e1", choices: [{ index: 0, delta: { role: "assistant", content: "Fi" }, finish_reason: null }] },
      { id: "e1", choices: [{ index: 0, delta: {}, finish_reason: finish }], ...more },
    ]);
  const { provider, facts } = await turn([failing]);
  expect(provider.bodies).toHaveLength(1);
  expect(facts.find((fact) => fact._tag === "Observed" && fact.observation._tag === "ModelFailed") as unknown).toMatchObject({
    observation: { failure: expect.stringContaining(failure) },
  });
});

test.each([
  ["Groq's, in x_groq", { x_groq: { id: "req_1", usage: { prompt_tokens: 40, completion_tokens: 12 } } }, {}, { input: 40, output: 12 }],
  ["SGLang's, its thinking at the top", { usage: { prompt_tokens: 40, completion_tokens: 12, reasoning_tokens: 5 } }, {}, { input: 40, output: 12, thinking: 5 }],
  ["Together's, its cache read at the top", { usage: { prompt_tokens: 40, completion_tokens: 12, cached_tokens: 32 } }, {}, { input: 40, output: 12, cacheRead: 32 }],
  ["in the choice", {}, { usage: { prompt_tokens: 40, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 32, cache_write_tokens: 8 } } }, { input: 40, output: 12, cacheRead: 32, cacheWrite: 8 }],
])("the usage where a back-end puts it: %s", async (_name, onChunk, onChoice, usage) => {
  const usageAt = () =>
    chatChunks([
      { id: "u1", choices: [{ index: 0, delta: { role: "assistant", content: "5." }, finish_reason: null }] },
      { id: "u1", choices: [{ index: 0, delta: {}, finish_reason: "stop", ...onChoice }], ...onChunk },
    ]);
  const { facts } = await turn([usageAt]);
  const responded = facts.flatMap((fact) => (fact._tag === "Observed" && fact.observation._tag === "ModelResponded" ? [fact.observation] : [])).at(0);
  expect(responded?.usage as unknown).toEqual(usage);
});

test("two responses with nothing between them are one message: the later one's field goes back, and the earlier one's is logged as left out", async () => {
  const logged: Array<unknown> = [];
  const capture = Logger.make((options) => {
    logged.push(options.message);
  });
  const provider = recordingServer([answers]);
  stops.push(provider.stop);
  const boring = ProviderName.make("boring");
  const from = { _tag: "Response" as const, model: ModelName.make("boring-1"), turn: TurnId.make("turn-1") };
  const thought = (text: string) => ({ _tag: "Thinking" as const, provider: boring, from, text: ThinkingText.make(text), received: receivedJson({ reasoning_content: text }) });
  const context: ModelContext = {
    system: undefined,
    tools: [],
    messages: [
      { role: "user", parts: [{ _tag: "Text", text: "Hello" }] },
      { role: "assistant", parts: [thought("First."), { _tag: "Text", text: "Wait." }, thought("Second."), { _tag: "Text", text: "Done." }] },
      { role: "user", parts: [{ _tag: "Text", text: "Again" }] },
    ],
  };
  await runTest(
    Effect.gen(function* () {
      const client = yield* ModelClient;
      yield* client.respond({ provider: boring, model: ModelName.make("boring-1") }, context, TurnId.make("turn-2"));
    }).pipe(Effect.provide(Layer.mergeAll(OpenAiCompatModelClient.pipe(Layer.provide(openAiCompatAt(provider.url))), Logger.layer([capture], { mergeWithExisting: true })))),
  );
  expect((provider.bodies[0] as { readonly messages: ReadonlyArray<unknown> }).messages[1]).toEqual({
    role: "assistant",
    content: [
      { type: "text", text: "Wait." },
      { type: "text", text: "Done." },
    ],
    reasoning_content: "Second.",
  });
  const lines = logged.filter((line) => Array.isArray(line) && line[0] === logKeys.provider.partsOmitted) as Array<[string, Record<string, unknown>]>;
  expect(lines[0]?.[1]["parts"]).toMatchObject([{ part: "Thinking", start: "First.", reason: "a later response in the same message holds reasoning_content too" }]);
});

test("the response streams: its usage comes in the last chunk, and a tool call is run once its response has it", async () => {
  const { facts } = await turn([{ ...callsAdd, usage: { prompt_tokens: 40, completion_tokens: 12, completion_tokens_details: { reasoning_tokens: 5 } } }, answers]);
  const observed = facts.flatMap((fact) => (fact._tag === "Observed" ? [fact.observation] : []));
  expect(observed.find((each) => each._tag === "ModelResponded") as unknown).toMatchObject({ usage: { input: 40, output: 12, thinking: 5 } });
  // The call is passed on as it is complete, and recorded as arrived, before the response is recorded whole.
  const tags = observed.map((each) => each._tag);
  expect(tags.indexOf("ToolCallArrived")).toBeGreaterThan(-1);
  expect(tags.indexOf("ToolCallArrived")).toBeLessThan(tags.indexOf("ModelResponded"));
});

test("a stream that ends with no finish_reason was cut short: the request fails, and is not made again", async () => {
  const chunk = (delta: unknown) => `data: ${JSON.stringify({ id: "c", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    fetch: () => {
      requests += 1;
      return new Response([chunk({ role: "assistant" }), chunk({ content: "Hal" })].join(""), { headers: { "content-type": "text/event-stream" } });
    },
  });
  stops.push(() => server.stop(true));
  const facts = await runTest(
    Effect.gen(function* () {
      const session = yield* openSession.pipe(Effect.provide(EphemeralSessionStore));
      yield* session.observe(boringOpening());
      yield* session.observe(userInput("hi"));
      yield* session.idle;
      return yield* session.facts;
    }).pipe(
      Effect.provide(
        Layer.mergeAll(BoringModelProvider, TurnContextAssembler, OpenAiCompatModelClient.pipe(Layer.provide(openAiCompatAt(server.url))), CountingTurns, SmolToolRunner),
      ),
    ),
  );
  expect(requests).toBe(1);
  expect(facts.find((fact) => fact._tag === "Observed" && fact.observation._tag === "ModelFailed") as unknown).toMatchObject({
    observation: { failure: expect.stringContaining("The stream ended with no finish_reason") },
  });
});

const boringTarget = { provider: ProviderName.make("boring"), model: ModelName.make("boring-1") };
const hello: ModelContext = { system: undefined, tools: [], messages: [{ role: "user", parts: [{ _tag: "Text", text: "Hello" }] }] };
const streamedChunk = (delta: unknown, finish_reason: string | null = null) => ({ id: "c1", choices: [{ index: 0, delta, finish_reason }] });
const callDelta = (call: Record<string, unknown>) => ({ tool_calls: [call] });

/**
 * One request whose response is `chunks`, with `ids` as the client's `IdGenerator` when given: what the
 * client passed on as it streamed, the observation it made, and what it logged.
 */
async function streamed(chunks: ReadonlyArray<unknown>, ids?: IdGenerator.Service) {
  const provider = recordingServer([() => chatChunks(chunks)]);
  stops.push(provider.stop);
  const passed: Array<Streamed> = [];
  const { logged, layer } = capturing();
  const responded = await runTest(
    Effect.gen(function* () {
      const client = yield* ModelClient;
      return yield* client.respond(boringTarget, hello, TurnId.make("turn-1"));
    }).pipe(
      Effect.provideService(ModelStream, (each) =>
        Effect.sync(() => {
          passed.push(each);
        }),
      ),
      Effect.provide(Layer.mergeAll(clientAt(provider.url, ids), layer)),
    ),
  );
  if (responded._tag !== "ModelResponded") throw new Error(`expected ModelResponded, got ${responded._tag}`);
  return {
    parts: responded.parts,
    passedCalls: passed.flatMap((each) => (each._tag === "Part" && each.part._tag === "ToolCall" ? [String(each.part.call)] : [])),
    logged,
  };
}

const add = (id: string, index: number | undefined, a: number) => ({
  ...(index === undefined ? {} : { index }),
  id,
  type: "function",
  function: { name: "add", arguments: JSON.stringify({ a, b: a }) },
});

test("a streamed call whose deltas carry no id is one call with one id, from the IdGenerator provided; a call with no name gets none", async () => {
  let made = 0;
  const ids: IdGenerator.Service = { generateId: () => Effect.sync(() => `call_test_${++made}`) };
  const { parts, passedCalls, logged } = await streamed(
    [
      streamedChunk({ role: "assistant", ...callDelta({ index: 0, type: "function", function: { name: "add", arguments: '{"a":2,' } }) }),
      streamedChunk(callDelta({ index: 0, function: { arguments: '"b":3}' } })),
      streamedChunk(callDelta({ index: 1, type: "function", function: { name: "add", arguments: '{"a":1,"b":1}' } })),
      streamedChunk(callDelta({ index: 2, function: { arguments: "{}" } })),
      streamedChunk({}, "tool_calls"),
    ],
    ids,
  );
  // The first call is passed on once the second begins; the second once the third does.
  expect(passedCalls).toEqual(["call_test_1", "call_test_2"]);
  expect(parts as unknown).toMatchObject([
    { _tag: "ToolCall", call: "call_test_1", tool: "add", input: json({ a: 2, b: 3 }) },
    { _tag: "ToolCall", call: "call_test_2", tool: "add", input: json({ a: 1, b: 1 }) },
    { _tag: "Unrecognised", received: json({ tool_calls: [{ id: null, type: "function", function: { name: null, arguments: "{}" } }] }) },
  ]);
  expect(made).toBe(2);
  expect(idsSupplied(logged).map(({ level, details }) => [level, details["id"], details["received"]])).toEqual([
    ["Warn", "call_test_1", { id: null, type: "function", function: { name: "add", arguments: '{"a":2,"b":3}' } }],
    ["Warn", "call_test_2", { id: null, type: "function", function: { name: "add", arguments: '{"a":1,"b":1}' } }],
  ]);
});

test("two calls of one response whose id is empty are two calls, each given an id of its own", async () => {
  let made = 0;
  const ids: IdGenerator.Service = { generateId: () => Effect.sync(() => `call_test_${++made}`) };
  const { parts, logged } = await streamed(
    [
      streamedChunk({ role: "assistant", ...callDelta({ index: 0, id: "", type: "function", function: { name: "add", arguments: '{"a":2,"b":3}' } }) }),
      streamedChunk(callDelta({ index: 1, id: "", type: "function", function: { name: "add", arguments: '{"a":1,"b":1}' } })),
      streamedChunk({}, "tool_calls"),
    ],
    ids,
  );
  expect(parts as unknown).toMatchObject([
    { _tag: "ToolCall", call: "call_test_1", tool: "add", input: json({ a: 2, b: 3 }) },
    { _tag: "ToolCall", call: "call_test_2", tool: "add", input: json({ a: 1, b: 1 }) },
  ]);
  expect(idsSupplied(logged).map(({ details }) => details["id"])).toEqual(["call_test_1", "call_test_2"]);
});

test("calls are passed on once each: those a later call completes in the order they arrived, those left at the end in index order; the message holds them in index order", async () => {
  const { parts, passedCalls } = await streamed([
    streamedChunk({ role: "assistant", ...callDelta(add("call_b", 1, 2)) }),
    streamedChunk(callDelta(add("call_a", 0, 1))),
    streamedChunk(callDelta(add("call_d", 3, 4))),
    streamedChunk(callDelta(add("call_c", 2, 3))),
    streamedChunk({}, "tool_calls"),
  ]);
  expect(passedCalls).toEqual(["call_b", "call_a", "call_c", "call_d"]);
  expect(parts.flatMap((part) => (part._tag === "ToolCall" ? [String(part.call)] : []))).toEqual(["call_a", "call_b", "call_c", "call_d"]);
});

test("a call's delta with no index is the call its id names; the call keeps its first id; arguments of null add nothing", async () => {
  const { parts } = await streamed([
    streamedChunk({ role: "assistant", ...callDelta({ index: 0, id: "call_1", type: "function", function: { name: "add", arguments: '{"a":2,' } }) }),
    streamedChunk(callDelta({ id: "call_1", function: { arguments: '"b":3}' } })),
    streamedChunk(callDelta({ index: 0, id: "call_2", function: { arguments: null } })),
    streamedChunk({}, "tool_calls"),
  ]);
  expect(parts.filter((part) => part._tag === "ToolCall") as unknown).toMatchObject([{ _tag: "ToolCall", call: "call_1", tool: "add", input: json({ a: 2, b: 3 }) }]);
});

test("a field's delta of null adds nothing to it, and text before a list of chunks is the list's first text chunk", async () => {
  const { parts } = await streamed([
    streamedChunk({ role: "assistant", reasoning_content: "Add them.", content: "Hel" }),
    streamedChunk({ reasoning_content: null, content: [{ type: "text", text: "lo." }] }),
    streamedChunk({}, "stop"),
  ]);
  expect(parts as unknown).toMatchObject([
    { _tag: "Thinking", text: "Add them." },
    { _tag: "Text", text: "Hello." },
  ]);
});

test("what a response held for a call not in its message is logged as left out, and not sent", async () => {
  const logged: Array<unknown> = [];
  const capture = Logger.make((options) => {
    logged.push(options.message);
  });
  const provider = recordingServer([answers]);
  stops.push(provider.stop);
  const from = { _tag: "Response" as const, model: ModelName.make("boring-1"), turn: TurnId.make("turn-1") };
  const context: ModelContext = {
    system: undefined,
    tools: [],
    messages: [
      { role: "user", parts: [{ _tag: "Text", text: "Hello" }] },
      {
        role: "assistant",
        parts: [
          { _tag: "ToolCall", call: CallId.make("call_1"), tool: ToolName.make("add"), input: receivedJson({ a: 2, b: 3 }) },
          { _tag: "Unrecognised", provider: ProviderName.make("boring"), from, received: receivedJson({ tool_calls: [{ id: "call_9", extra_content: { google: { thought_signature: "c2ln" } } }] }) },
        ],
      },
    ],
  };
  await runTest(
    Effect.gen(function* () {
      const client = yield* ModelClient;
      yield* client.respond(boringTarget, context, TurnId.make("turn-2"));
    }).pipe(Effect.provide(Layer.mergeAll(OpenAiCompatModelClient.pipe(Layer.provide(openAiCompatAt(provider.url))), Logger.layer([capture], { mergeWithExisting: true })))),
  );
  expect((provider.bodies[0] as { readonly messages: ReadonlyArray<unknown> }).messages[1]).toEqual({
    role: "assistant",
    content: null,
    tool_calls: [{ id: "call_1", type: "function", function: { name: "add", arguments: '{"a":2,"b":3}' } }],
  });
  const lines = logged.filter((line) => Array.isArray(line) && line[0] === logKeys.provider.partsOmitted) as Array<[string, Record<string, unknown>]>;
  expect(lines[0]?.[1]["parts"]).toMatchObject([{ part: "Unrecognised", reason: "its call is not in the message" }]);
});

test("a required tool choice and a constrained tool are not sent, and a warning names each", async () => {
  const logged: Array<{ readonly level: string; readonly message: unknown }> = [];
  const capture = Logger.make((options) => {
    logged.push({ level: options.logLevel, message: options.message });
  });
  const provider = recordingServer([answers]);
  stops.push(provider.stop);
  const [add, ...rest] = smolCatalog;
  if (add === undefined) throw new Error("the smol catalog has no tools");
  const context: ModelContext = {
    system: undefined,
    tools: [{ ...add, constrained: true }, ...rest],
    messages: [{ role: "user", parts: [{ _tag: "Text", text: "Add 2 and 3." }] }],
    toolChoice: "required",
  };
  await runTest(
    Effect.gen(function* () {
      yield* (yield* ModelClient).respond({ provider: ProviderName.make("boring"), model: ModelName.make("boring-1") }, context, TurnId.make("turn-1"));
    }).pipe(Effect.provide(Layer.mergeAll(OpenAiCompatModelClient.pipe(Layer.provide(openAiCompatAt(provider.url))), Logger.layer([capture], { mergeWithExisting: true })))),
  );
  const sent = provider.bodies[0] as { readonly tools: ReadonlyArray<{ readonly function: Record<string, unknown> }> };
  expect(sent).not.toHaveProperty("tool_choice");
  expect(sent.tools.map((tool) => tool.function["strict"])).toEqual(sent.tools.map(() => undefined));
  const warnings = logged.filter(({ message }) => Array.isArray(message) && message[0] === logKeys.provider.notTranslated);
  expect(warnings.map(({ level, message }) => [level, (message as [string, Record<string, unknown>])[1]])).toEqual([
    ["Warn", expect.objectContaining({ field: "toolChoice", value: "required", without: "the model chooses whether to call a tool" })],
    ["Warn", expect.objectContaining({ field: "constrained", tools: ["add"], without: "the model's tool input is checked only when the tool runs" })],
  ]);
});
