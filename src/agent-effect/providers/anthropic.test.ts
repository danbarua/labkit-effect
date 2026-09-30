/** The Anthropic Messages adapter: how the core's types are shaped into its wire format. */

import { afterAll, expect } from "bun:test";
import { test } from "../../../tests/support/test.ts";
import { anthropicAt } from "../../../tests/support/providers.ts";
import { Effect, Layer, Logger } from "effect";
import { ModelName, ProviderName, ThinkingText, TurnId } from "../../agent-core/names.ts";
import { ModelClient } from "../contracts.ts";
import { logKeys } from "../log-keys.ts";
import { json } from "../../../tests/support/received.ts";
import { receivedJson } from "../received.ts";
import type { Observation } from "../../agent-core/observation.ts";
import { BoringModelProvider } from "../../../tests/support/boring.ts";
import { CountingTurns, NoTurnEndHooks } from "../turns.ts";
import { AnthropicModelClient } from "./anthropic-client.ts";
import { openSession } from "../loop.ts";
import { SmolToolRunner, smolCatalog } from "../../../tests/support/smol-tools.ts";
import { TurnContextAssembler } from "../turn-context.ts";
import { anthropicStream } from "../../../tests/support/streams.ts";
import { runTest } from "../../../tests/support/run.ts";
import { boringOpening } from "../../../tests/support/boring.ts";

/** A provider that makes one scripted tool call, then answers; it keeps every request it is sent. */
function scripted(call: { name: string; input: unknown }) {
  const received: Array<{ messages: Array<{ role: string; content: Array<Record<string, unknown>> }> }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      received.push((await request.json()) as (typeof received)[number]);
      return anthropicStream(
        received.length === 1
          ? { content: [{ type: "tool_use", id: "toolu_1", ...call }], stop_reason: "tool_use" }
          : { content: [{ type: "text", text: "Understood." }], stop_reason: "end_turn" },
      );
    },
  });
  return { server, received };
}

const servers: Array<{ stop: (force: boolean) => unknown }> = [];
afterAll(() => {
  for (const server of servers) server.stop(true);
});

/** Runs one turn against the scripted provider and returns the tool result the model was sent. */
async function toolResultSent(call: { name: string; input: unknown }) {
  const provider = scripted(call);
  servers.push(provider.server);
  await runTest(
    Effect.gen(function* () {
      const session = yield* openSession;
      yield* session.observe(boringOpening(smolCatalog));
      yield* session.idle;
      yield* session.observe({ _tag: "InputArrived", from: { _tag: "User" }, text: "go" } as unknown as Observation);
      yield* session.idle;
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          BoringModelProvider,
          TurnContextAssembler,
          AnthropicModelClient.pipe(Layer.provide(anthropicAt(provider.server.url))),
          CountingTurns,
          NoTurnEndHooks,
          SmolToolRunner,
        ),
      ),
    ),
  );
  const result = provider.received[1]?.messages.at(-1)?.content[0];
  if (result === undefined) throw new Error("the model was not sent a tool result");
  return { ...result, content: JSON.parse(result["content"] as string) } as unknown;
}

test("a failed call to a tool that does not exist is sent as the tools that do", async () => {
  expect(await toolResultSent({ name: "___read_", input: { path: "a.ts" } })).toEqual({
    type: "tool_result",
    tool_use_id: "toolu_1",
    is_error: true,
    content: {
      code: "tool_not_found",
      message: 'No tool is named "___read_".',
      tools: smolCatalog.map((tool) => ({ name: tool.name, input_schema: tool.input })),
    },
  });
});

test("a failed call with input that does not fit is sent as the tool's schema and what was given", async () => {
  expect(await toolResultSent({ name: "add", input: { a: "2" } })).toEqual({
    type: "tool_result",
    tool_use_id: "toolu_1",
    is_error: true,
    content: {
      code: "invalid_input",
      message: "add needs two numbers, a and b.",
      tool: "add",
      input_schema: smolCatalog[0]?.input,
      given: { a: "2" },
    },
  });
});

test("the max_tokens the Messages API requires is supplied and logged, with the reason", async () => {
  const logged: Array<{ level: string; message: unknown }> = [];
  const capture = Logger.make((options) => {
    logged.push({ level: options.logLevel, message: options.message });
  });
  const provider = scripted({ name: "add", input: { a: 1, b: 2 } });
  servers.push(provider.server);
  await runTest(
    Effect.gen(function* () {
      const client = yield* ModelClient;
      yield* client.respond(
        {
          provider: ProviderName.make("boring"),
          model: ModelName.make("boring-1"),
        },
        { system: undefined, tools: [], messages: [{ role: "user", parts: [{ _tag: "Text", text: "hi" }] }] },
        TurnId.make("turn-1"),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(AnthropicModelClient.pipe(Layer.provide(anthropicAt(provider.server.url))), Logger.layer([capture])),
      ),
    ),
  );
  expect(logged).toContainEqual({
    level: "Info",
    message: [
      logKeys.anthropic.maxTokensSupplied,
      {
        max_tokens: 32_768,
        reason: "the Messages API requires max_tokens and the session's settings give no output limit",
      },
    ],
  });
});

/** A provider that answers each request with the next scripted response, keeping each request's body. */
function recording(responses: ReadonlyArray<unknown>) {
  const bodies: Array<unknown> = [];
  const headers: Array<Record<string, string>> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      headers.push(Object.fromEntries(request.headers));
      bodies.push(await request.json());
      return anthropicStream(responses[bodies.length - 1]);
    },
  });
  servers.push(server);
  return { url: new URL("/v1/messages", server.url), bodies, headers };
}

const target = {
  provider: ProviderName.make("boring"),
  model: ModelName.make("boring-1"),
};

test("a request is the model, the default max_tokens, and the context's messages as Messages blocks", async () => {
  const provider = recording([{ content: [{ type: "text", text: "Hello back." }], stop_reason: "end_turn" }]);
  await runTest(
    Effect.gen(function* () {
      yield* (yield* ModelClient).respond(
        target,
        { system: undefined, tools: [], messages: [{ role: "user", parts: [{ _tag: "Text", text: "Hello" }] }] },
        TurnId.make("turn-1"),
      );
    }).pipe(Effect.provide(AnthropicModelClient.pipe(Layer.provide(anthropicAt(provider.url))))),
  );
  expect(provider.bodies).toEqual([
    { model: "boring-1", max_tokens: 32_768, stream: true, messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }] },
  ]);
});

test("a response's text is a Text part, stop_reason is the stop, and everything else is metadata", async () => {
  const provider = recording([
    {
      id: "msg_1",
      type: "message",
      content: [{ type: "text", text: "Hello back." }],
      stop_reason: "end_turn",
      usage: { input_tokens: 3, output_tokens: 3 },
    },
  ]);
  const observed = await runTest(
    Effect.gen(function* () {
      return yield* (yield* ModelClient).respond(
        target,
        { system: undefined, tools: [], messages: [{ role: "user", parts: [{ _tag: "Text", text: "Hello" }] }] },
        TurnId.make("turn-1"),
      );
    }).pipe(Effect.provide(AnthropicModelClient.pipe(Layer.provide(anthropicAt(provider.url))))),
  );
  expect(observed as unknown).toEqual({
    _tag: "ModelResponded",
    turn: "turn-1",
    provider: "boring",
    model: "boring-1",
    parts: [{ _tag: "Text", text: "Hello back." }],
    stop: "end_turn",
    ending: { _tag: "Complete" },
    metadata: json({ id: "msg_1", type: "message", usage: { input_tokens: 3, output_tokens: 3 } }),
  });
});

test("a tool turn sends the catalog, then the call and its result, as Messages blocks", async () => {
  const provider = recording([
    {
      content: [
        { type: "text", text: "I'll add them." },
        { type: "tool_use", id: "toolu_1", name: "add", input: { a: 2, b: 3 } },
      ],
      stop_reason: "tool_use",
    },
    { content: [{ type: "text", text: "2 + 3 = 5." }], stop_reason: "end_turn" },
  ]);
  await runTest(
    Effect.gen(function* () {
      const session = yield* openSession;
      yield* session.observe(boringOpening(smolCatalog));
      yield* session.idle;
      yield* session.observe({ _tag: "InputArrived", from: { _tag: "User" }, text: "What is 2 + 3?" } as unknown as Observation);
      yield* session.idle;
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          BoringModelProvider,
          TurnContextAssembler,
          AnthropicModelClient.pipe(Layer.provide(anthropicAt(provider.url))),
          CountingTurns,
          NoTurnEndHooks,
          SmolToolRunner,
        ),
      ),
    ),
  );
  const tools = smolCatalog.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.input }));
  const question = { role: "user", content: [{ type: "text", text: "What is 2 + 3?" }] };
  expect(provider.bodies).toEqual([
    { model: "boring-1", max_tokens: 32_768, stream: true, tools, messages: [question] },
    {
      model: "boring-1",
      max_tokens: 32_768, stream: true,
      tools,
      messages: [
        question,
        {
          role: "assistant",
          content: [
            { type: "text", text: "I'll add them." },
            { type: "tool_use", id: "toolu_1", name: "add", input: { a: 2, b: 3 } },
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "5" }] },
      ],
    },
  ]);
});

const respondWith = (provider: ReturnType<typeof recording>) =>
  runTest(
    Effect.gen(function* () {
      return yield* (yield* ModelClient).respond(
        target,
        { system: undefined, tools: [], messages: [{ role: "user", parts: [{ _tag: "Text", text: "Hello" }] }] },
        TurnId.make("turn-1"),
      );
    }).pipe(Effect.provide(AnthropicModelClient.pipe(Layer.provide(anthropicAt(provider.url))))),
  );

test("a thinking block becomes Thinking, its text and the block as received; a block type nobody knows is kept whole", async () => {
  const future = { type: "future_block", payload: { any: "thing" } };
  const provider = recording([
    {
      content: [{ type: "thinking", thinking: "Check the file first.", signature: "sig-abc" }, future],
      stop_reason: "end_turn",
    },
  ]);
  const observed = await respondWith(provider);
  expect(observed as unknown).toMatchObject({
    _tag: "ModelResponded",
    parts: [
      { _tag: "Thinking", text: "Check the file first.", received: json({ type: "thinking", thinking: "Check the file first.", signature: "sig-abc" }) },
      { _tag: "Unrecognised", received: json(future) },
    ],
  });
});

test("thinking, an empty one included, and blocks nobody knows go back to the provider unchanged and in place", async () => {
  const thinking = { type: "thinking", thinking: "", signature: "sig-abc" };
  const redacted = { type: "redacted_thinking", data: "opaque" };
  const call = { type: "tool_use", id: "toolu_1", name: "add", input: { a: 2, b: 3 } };
  const provider = recording([
    { content: [thinking, redacted, call], stop_reason: "tool_use" },
    { content: [{ type: "text", text: "5." }], stop_reason: "end_turn" },
  ]);
  await runTest(
    Effect.gen(function* () {
      const session = yield* openSession;
      yield* session.observe(boringOpening(smolCatalog));
      yield* session.idle;
      yield* session.observe({ _tag: "InputArrived", from: { _tag: "User" }, text: "What is 2 + 3?" } as unknown as Observation);
      yield* session.idle;
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          BoringModelProvider,
          TurnContextAssembler,
          AnthropicModelClient.pipe(Layer.provide(anthropicAt(provider.url))),
          CountingTurns,
          NoTurnEndHooks,
          SmolToolRunner,
        ),
      ),
    ),
  );
  expect((provider.bodies[1] as { messages: ReadonlyArray<unknown> }).messages[1]).toEqual({
    role: "assistant",
    content: [thinking, redacted, call],
  });
});

test("another provider's thinking and blocks are left out and logged; a message left empty is not sent", async () => {
  const logged: Array<unknown> = [];
  const capture = Logger.make((options) => {
    logged.push(options.message);
  });
  const provider = recording([{ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }]);
  const other = ProviderName.make("other");
  await runTest(
    Effect.gen(function* () {
      yield* (yield* ModelClient).respond(
        target,
        {
          system: undefined,
          tools: [],
          messages: [
            { role: "user", parts: [{ _tag: "Text", text: "Hello" }] },
            {
              role: "assistant",
              parts: [
                { _tag: "Thinking", provider: other, text: ThinkingText.make(""), received: receivedJson({ type: "reasoning", summary: [] }) },
                { _tag: "Unrecognised", provider: other, received: receivedJson({ type: "reasoning" }) },
              ],
            },
            { role: "user", parts: [{ _tag: "Text", text: "Again" }] },
          ],
        },
        TurnId.make("turn-1"),
      );
    }).pipe(
      Effect.provide(Layer.mergeAll(AnthropicModelClient.pipe(Layer.provide(anthropicAt(provider.url))), Logger.layer([capture]))),
    ),
  );
  expect((provider.bodies[0] as { messages: unknown }).messages).toEqual([
    { role: "user", content: [{ type: "text", text: "Hello" }] },
    { role: "user", content: [{ type: "text", text: "Again" }] },
  ]);
  const reason = "produced by other, not boring";
  expect(logged).toContainEqual([logKeys.provider.partLeftOut, { part: "Thinking", reason }]);
  expect(logged).toContainEqual([logKeys.provider.partLeftOut, { part: "Unrecognised", reason }]);
});

test("requests go to /v1/messages with the client's key and API version", async () => {
  const provider = recording([{ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }]);
  await respondWith(provider);
  expect(provider.headers[0]).toMatchObject({ "x-api-key": "test-key", "anthropic-version": "2023-06-01" });
});
