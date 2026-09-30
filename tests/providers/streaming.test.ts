/**
 * Responses as streams: the Messages stream assembled into a message, what a response cut short
 * records, and what is passed on while a response arrives.
 */

import { afterAll, expect } from "bun:test";
import { Effect, Layer, PubSub } from "effect";
import { Notices } from "../../src/agent-context/assemble.ts";
import { AgentContextAssembler, WholeConversation } from "../../src/agent-context/assembler.ts";
import { Millis, TurnId } from "../../src/agent-core/names.ts";
import type { Observation } from "../../src/agent-core/observation.ts";
import { openSession } from "../../src/agent-effect/loop.ts";
import { ModelStreamInterval } from "../../src/agent-effect/model-stream.ts";
import { AnthropicModelClient } from "../../src/agent-effect/providers/anthropic-client.ts";
import { assemble, assembled, cut, nothingYet } from "../../src/agent-effect/providers/anthropic-stream.ts";
import { OpenAiModelClient } from "../../src/agent-effect/providers/openai-client.ts";
import { receivedJson } from "../../src/agent-effect/received.ts";
import { ToolRunner } from "../../src/agent-effect/contracts.ts";
import { TurnContextAssembler } from "../../src/agent-effect/turn-context.ts";
import { CountingTurns, NoTurnEndHooks } from "../../src/agent-effect/turns.ts";
import { BoringModelProvider, boringOpening } from "../support/boring.ts";
import { anthropicAt, openAiAt } from "../support/providers.ts";
import { json } from "../support/received.ts";
import { runTest } from "../support/run.ts";
import { SmolToolRunner, smolCatalog } from "../support/smol-tools.ts";
import { anthropicStream, openAiStream } from "../support/streams.ts";
import { test } from "../support/test.ts";

const fold = (events: ReadonlyArray<unknown>) =>
  events.reduce<{ state: typeof nothingYet; completed: Array<unknown>; failed: Array<unknown>; notApplied: Array<string> }>(
    (done, event) => {
      const next = assemble(done.state, event as never);
      return {
        state: next.state,
        completed: next.completed === undefined ? done.completed : [...done.completed, next.completed],
        failed: next.failed === undefined ? done.failed : [...done.failed, next.failed],
        notApplied: next.notApplied === undefined ? done.notApplied : [...done.notApplied, next.notApplied],
      };
    },
    { state: nothingYet, completed: [], failed: [], notApplied: [] },
  );

const started = { type: "message_start", message: { id: "msg_1", role: "assistant", content: [], stop_reason: null, usage: { input_tokens: 9, output_tokens: 1 } } };

test("a Messages stream is assembled into the message a request without streaming returns", () => {
  const { state, completed } = fold([
    started,
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Add " } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "them." } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-abc" } },
    { type: "content_block_stop", index: 0 },
    { type: "ping" },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Adding." } },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "add", input: {} } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"a":2,' } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '"b":3}' } },
    { type: "content_block_stop", index: 2 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 40 } },
    { type: "message_stop" },
  ]);
  const content = [
    { type: "thinking", thinking: "Add them.", signature: "sig-abc" },
    { type: "text", text: "Adding." },
    { type: "tool_use", id: "toolu_1", name: "add", input: { a: 2, b: 3 } },
  ];
  expect(completed).toEqual(content);
  expect(assembled(state) as unknown).toEqual({
    id: "msg_1",
    role: "assistant",
    stop_reason: "tool_use",
    usage: { input_tokens: 9, output_tokens: 40 },
    content,
  });
});

test("a block still arriving when the stream ends is not part of the message", () => {
  const { state, completed } = fold([
    started,
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Adding." } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "add", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"a":' } },
    { type: "message_delta", delta: { stop_reason: "max_tokens" } },
    { type: "message_stop" },
  ]);
  expect(completed).toEqual([{ type: "text", text: "Adding." }]);
  expect((assembled(state) as { content: unknown }).content).toEqual([{ type: "text", text: "Adding." }]);
  expect(cut(state)).toEqual(["tool_use"]);
});

test("the stream's own error, and a delta of a type not known, are reported by the machine", () => {
  const { failed, notApplied, state } = fold([
    started,
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "future_delta", value: 1 } },
    { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
  ]);
  expect(notApplied).toEqual(["future_delta"]);
  expect(failed).toEqual([{ type: "overloaded_error", message: "Overloaded" }]);
  expect(assembled(nothingYet)).toBeUndefined();
  expect(cut(state)).toEqual(["text"]);
});

const stops: Array<() => unknown> = [];
afterAll(() => {
  for (const stop of stops) stop();
});

const serving = (respond: (request: number) => Response) => {
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      await request.json();
      return respond(++requests);
    },
  });
  stops.push(() => server.stop(true));
  return server.url;
};

const input = { _tag: "InputArrived", from: { _tag: "User" }, text: "What is 2 + 3?" } as unknown as Observation;

const parts = (facts: ReadonlyArray<{ _tag: string; observation?: Observation }>) =>
  facts.flatMap((fact) => (fact.observation?._tag === "ModelResponded" ? [fact.observation.parts.map((part) => part._tag)] : []));

test("Anthropic: a response cut short records the parts that were completed, and the turn ends as cut short", async () => {
  const url = serving(() =>
    anthropicStream(
      {
        content: [
          { type: "text", text: "Adding." },
          { type: "tool_use", id: "toolu_1", name: "add", input: { a: 2, b: 3 } },
        ],
        stop_reason: "max_tokens",
      },
      { cut: true },
    ),
  );
  const facts = await runTest(
    Effect.gen(function* () {
      const session = yield* openSession;
      yield* session.observe(boringOpening(smolCatalog));
      yield* session.observe(input);
      yield* session.idle;
      return yield* session.facts;
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          BoringModelProvider,
          TurnContextAssembler,
          AnthropicModelClient.pipe(Layer.provide(anthropicAt(new URL("/v1/messages", url)))),
          CountingTurns,
          NoTurnEndHooks,
          SmolToolRunner,
        ),
      ),
    ),
  );
  expect(parts(facts)).toEqual([["Text"]]);
  expect(facts.at(-1) as unknown).toMatchObject({ decision: { _tag: "TurnEnded", ending: { _tag: "CutShort" } } });
});

test("OpenAI: an item still arriving when the response ended is not recorded", async () => {
  const url = serving(() =>
    openAiStream({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [
        { type: "message", role: "assistant", status: "completed", phase: "commentary", content: [{ type: "output_text", text: "Adding." }] },
        { type: "function_call", status: "incomplete", call_id: "call_1", name: "add", arguments: '{"a":' },
      ],
    }),
  );
  const facts = await runTest(
    Effect.gen(function* () {
      const session = yield* openSession;
      yield* session.observe(boringOpening(smolCatalog));
      yield* session.observe(input);
      yield* session.idle;
      return yield* session.facts;
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          BoringModelProvider,
          TurnContextAssembler,
          OpenAiModelClient.pipe(Layer.provide(openAiAt(url))),
          CountingTurns,
          NoTurnEndHooks,
          SmolToolRunner,
        ),
      ),
    ),
  );
  expect(parts(facts)).toEqual([["Commentary"]]);
  expect(facts.at(-1) as unknown).toMatchObject({ decision: { _tag: "TurnEnded", ending: { _tag: "CutShort" } } });
});

test("while a response arrives, its events and each completed part are passed on; none of it is recorded", async () => {
  const url = serving((request) =>
    anthropicStream(
      request === 1
        ? { content: [{ type: "text", text: "Adding." }, { type: "tool_use", id: "toolu_1", name: "add", input: { a: 2, b: 3 } }], stop_reason: "tool_use" }
        : { content: [{ type: "text", text: "5." }], stop_reason: "end_turn" },
    ),
  );
  const { passed, facts } = await runTest(
    Effect.gen(function* () {
      const session = yield* openSession;
      const streamed = yield* session.streamed;
      yield* session.observe(boringOpening(smolCatalog));
      yield* session.observe(input);
      yield* session.idle;
      return { passed: yield* PubSub.takeAll(streamed), facts: yield* session.facts };
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          BoringModelProvider,
          TurnContextAssembler,
          AnthropicModelClient.pipe(Layer.provide(anthropicAt(new URL("/v1/messages", url)))),
          CountingTurns,
          NoTurnEndHooks,
          SmolToolRunner,
        ),
      ),
      Effect.provideService(ModelStreamInterval, Millis.make(0)),
    ),
  );
  const arrived = passed.flatMap((each) => (each._tag === "ModelPartArrived" ? [each.part] : []));
  expect(arrived as unknown).toMatchObject([
    { _tag: "Text", text: "Adding." },
    { _tag: "ToolCall", call: "toolu_1", tool: "add", input: json({ a: 2, b: 3 }) },
    { _tag: "Text", text: "5." },
  ]);
  const chunks = passed.filter((each) => each._tag === "ModelStreamed");
  // message_start, three events for each block, message_delta and message_stop, for each response.
  expect(chunks).toHaveLength(9 + 6);
  expect(passed.every((each) => each.turn === "turn-1")).toBe(true);
  expect(parts(facts)).toEqual([["Text", "ToolCall"], ["Text"]]);
});

test("a tool call is run as soon as it is complete in the stream, before the response has ended; its result follows the response", async () => {
  const toolRan = Promise.withResolvers<void>();
  const bodies: Array<{ messages: ReadonlyArray<unknown> }> = [];
  const event = (data: Record<string, unknown>) => new TextEncoder().encode(`event: ${String(data["type"])}\ndata: ${JSON.stringify(data)}\n\n`);
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      bodies.push((await request.json()) as (typeof bodies)[number]);
      if (bodies.length > 1) return anthropicStream({ content: [{ type: "text", text: "5." }], stop_reason: "end_turn" });
      // The call's block is complete; the stream stays open until the tool has run, then ends.
      return new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(event({ type: "message_start", message: { id: "msg_1" } }));
            controller.enqueue(event({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "add", input: {} } }));
            controller.enqueue(event({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"a":2,"b":3}' } }));
            controller.enqueue(event({ type: "content_block_stop", index: 0 }));
            await toolRan.promise;
            controller.enqueue(event({ type: "message_delta", delta: { stop_reason: "tool_use" } }));
            controller.enqueue(event({ type: "message_stop" }));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  stops.push(() => server.stop(true));
  const tools = Layer.succeed(ToolRunner, {
    run: () =>
      Effect.sync(() => {
        toolRan.resolve();
        return { _tag: "Succeeded" as const, output: receivedJson(5) };
      }),
  });
  const facts = await runTest(
    Effect.gen(function* () {
      const session = yield* openSession;
      yield* session.observe(boringOpening(smolCatalog));
      yield* session.observe(input);
      yield* session.idle;
      return yield* session.facts;
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          BoringModelProvider,
          TurnContextAssembler,
          AnthropicModelClient.pipe(Layer.provide(anthropicAt(new URL("/v1/messages", server.url)))),
          CountingTurns,
          NoTurnEndHooks,
          tools,
        ),
      ),
    ),
  );
  const recorded = facts.map((fact) => (fact._tag === "Observed" ? fact.observation._tag : fact.decision._tag));
  expect(recorded.slice(4)).toEqual([
    "ModelAsked",
    "ToolCallArrived",
    "ToolCallDispatched",
    "ToolEnded",
    "ModelResponded",
    "ModelAsked",
    "ModelResponded",
    "TurnEndReviewed",
    "TurnEnded",
  ]);
  expect(bodies[1]?.messages.slice(1)).toEqual([
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "add", input: { a: 2, b: 3 } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "5" }] },
  ]);
});

test("interrupted while a response streams and its tool runs: both are stopped and recorded as far as they got, and the conversation goes on", async () => {
  const toolBegan = Promise.withResolvers<void>();
  const bodies: Array<{ messages: ReadonlyArray<unknown> }> = [];
  const event = (data: Record<string, unknown>) => new TextEncoder().encode(`event: ${String(data["type"])}\ndata: ${JSON.stringify(data)}\n\n`);
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      bodies.push((await request.json()) as (typeof bodies)[number]);
      if (bodies.length > 1) return anthropicStream({ content: [{ type: "text", text: "Understood." }], stop_reason: "end_turn" });
      // One text block and one call are complete, a second text block is arriving, and the stream never ends.
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(event({ type: "message_start", message: { id: "msg_1" } }));
            controller.enqueue(event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
            controller.enqueue(event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Adding." } }));
            controller.enqueue(event({ type: "content_block_stop", index: 0 }));
            controller.enqueue(event({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "add", input: {} } }));
            controller.enqueue(event({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"a":2,"b":3}' } }));
            controller.enqueue(event({ type: "content_block_stop", index: 1 }));
            controller.enqueue(event({ type: "content_block_start", index: 2, content_block: { type: "text", text: "" } }));
            controller.enqueue(event({ type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "Then I will" } }));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  stops.push(() => server.stop(true));
  const tools = Layer.succeed(ToolRunner, {
    run: () => Effect.sync(() => toolBegan.resolve()).pipe(Effect.andThen(Effect.never)),
  });
  const facts = await runTest(
    Effect.gen(function* () {
      const session = yield* openSession;
      yield* session.observe(boringOpening(smolCatalog));
      yield* session.observe(input);
      yield* Effect.promise(() => toolBegan.promise);
      yield* session.observe({ _tag: "TurnInterrupted", turn: TurnId.make("turn-1") });
      yield* session.idle;
      yield* session.observe({ _tag: "InputArrived", from: { _tag: "User" }, text: "Stop adding." } as unknown as Observation);
      yield* session.idle;
      return yield* session.facts;
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          BoringModelProvider,
          AgentContextAssembler.pipe(Layer.provide(Layer.mergeAll(WholeConversation, Layer.succeed(Notices, [])))),
          AnthropicModelClient.pipe(Layer.provide(anthropicAt(new URL("/v1/messages", server.url)))),
          CountingTurns,
          NoTurnEndHooks,
          tools,
        ),
      ),
    ),
  );
  const recorded = facts.map((fact) => (fact._tag === "Observed" ? fact.observation._tag : fact.decision._tag));
  expect(recorded.slice(4, 8)).toEqual(["ModelAsked", "ToolCallArrived", "ToolCallDispatched", "TurnInterrupted"]);
  // The response and the tool are stopped together; which is heard from first is not fixed.
  expect(recorded.slice(8, 10).sort() as ReadonlyArray<string>).toEqual(["ModelResponded", "ToolEnded"]);
  expect(recorded[10]).toBe("TurnEnded");
  expect(recorded).not.toContain("ObservationNotExpected");
  const observed = facts.flatMap((fact) => (fact._tag === "Observed" ? [fact.observation] : []));
  expect(observed.find((each) => each._tag === "ModelResponded") as unknown).toMatchObject({
    parts: [{ _tag: "Text", text: "Adding." }, { _tag: "ToolCall", call: "toolu_1" }],
    ending: { _tag: "Interrupted" },
  });
  expect(observed.find((each) => each._tag === "ToolEnded") as unknown).toMatchObject({
    outcome: { _tag: "Failed", reason: { _tag: "Indeterminate" } },
  });
  // The next turn's request holds the call, a result for it, and the new input.
  expect(bodies[1]?.messages.slice(1) as unknown).toMatchObject([
    { role: "assistant", content: [{ type: "text", text: "Adding." }, { type: "tool_use", id: "toolu_1" }] },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_1", is_error: true },
        { type: "text", text: "Stop adding." },
      ],
    },
  ]);
});
