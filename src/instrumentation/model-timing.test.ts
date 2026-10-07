/** `TimedModelClient`, around a client that streams a response inside an attempt's span; and each attempt's outcome on its span (`observedAttempts`). */

import { afterAll, beforeAll, expect } from "bun:test";
import { OpenAiClient as OpenAiCompatClient } from "@effect/ai-openai-compat";
import { Effect, Layer, Metric, Redacted } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { TestClock } from "effect/testing";
import { runTest } from "../../tests/support/run.ts";
import { test } from "../../tests/support/test.ts";
import { chatChunks } from "../../tests/support/streams.ts";
import { anthropicAtMock, startVidaiMock, type VidaiMock } from "../../tests/support/vidaimock.ts";
import { CallId, ModelName, ModelText, ProviderName, StopReason, TokenCount, ToolName, TurnId } from "../agent-machine/names.ts";
import type { Usage } from "../agent-machine/observation.ts";
import { ModelClient, type ProviderRequest, type Target } from "../agent-session/contracts.ts";
import { FallbackModelClient } from "../agent-session/model-fallback.ts";
import { ModelStream } from "../agent-session/model-stream.ts";
import { anthropicRequests } from "../agent-session/providers/anthropic-client.ts";
import { openAiCompatRequests } from "../agent-session/providers/openai-compat-client.ts";
import { receivedJson } from "../agent-session/received.ts";
import { Report } from "../agent-session/report.ts";
import { observedAttempts } from "./model-attempts.ts";
import { TimedModelClient } from "./model-timing.ts";
import { type SpanLine, SpansTo } from "./telemetry.ts";

const provider = ProviderName.make("scripted");
const model = ModelName.make("streamer");

/** A client that streams an event, thinking, text in two deltas and a tool call, in an attempt's span, and responds with its token use. */
const streaming = Layer.succeed(ModelClient, {
  respond: (_target, _context, turn) =>
    Effect.gen(function* () {
      const passOn = yield* ModelStream;
      yield* passOn({ _tag: "Chunk", chunk: receivedJson({ type: "message_start" }) });
      yield* passOn({ _tag: "Delta", kind: "Thinking", text: "Let me see." });
      yield* passOn({ _tag: "Delta", kind: "Text", text: "Hello" });
      yield* passOn({ _tag: "Delta", kind: "Text", text: " there" });
      yield* passOn({ _tag: "Part", part: { _tag: "ToolCall", call: CallId.make("call-1"), tool: ToolName.make("read_file"), input: receivedJson({ path: "a.ts" }) } });
      return {
        _tag: "ModelResponded" as const,
        turn,
        provider,
        model,
        parts: [{ _tag: "Text" as const, text: ModelText.make("Hello there") }],
        ending: { _tag: "Complete" as const },
        usage: { input: TokenCount.make(120), output: TokenCount.make(30), cacheRead: TokenCount.make(100) },
        metadata: receivedJson({}),
      };
    }).pipe(Effect.withSpan("agent.model.attempt", { attributes: { provider, model } })),
});

test("an attempt's span marks its first event, first thinking, first text and each tool call parsed; the request's span holds the token use; time to first token and tokens are counted by model", async () => {
  const spans: Array<SpanLine> = [];
  const { snapshot, passedOn } = await runTest(
    Effect.gen(function* () {
      const passedOn: Array<string> = [];
      const client = yield* ModelClient;
      yield* client
        .respond({ provider, model }, { system: undefined, tools: [], messages: [] }, TurnId.make("turn-1"))
        .pipe(
          Effect.provideService(ModelStream, (streamed) => Effect.sync(() => void passedOn.push(streamed._tag))),
          Effect.withSpan("agent.model.request"),
        );
      return { snapshot: yield* Metric.snapshot, passedOn };
    }).pipe(Effect.provide(Layer.mergeAll(TimedModelClient(streaming), SpansTo((line) => void spans.push(line)))), Effect.provideService(Metric.MetricRegistry, new Map())),
  );
  // What the client streams is still passed on, in order.
  expect(passedOn).toEqual(["Chunk", "Delta", "Delta", "Delta", "Part"]);
  const attempt = spans.find((span) => span.name === "agent.model.attempt");
  expect(attempt?.events.map((event) => [event.name, event.attributes])).toEqual([
    ["first event", {}],
    ["first thinking", {}],
    ["first text", {}],
    ["tool call parsed", { tool: "read_file" }],
  ]);
  expect(Object.keys(attempt?.attributes ?? {})).toEqual(expect.arrayContaining(["first_event_ms", "first_thinking_ms", "first_text_ms", "ttft_ms", "tool_calls"]));
  expect(attempt?.attributes["ttft_ms"]).toBe(attempt?.attributes["first_thinking_ms"]);
  expect(attempt?.attributes["tool_calls"]).toBe(1);
  expect(spans.find((span) => span.name === "agent.model.request")?.attributes).toMatchObject({ provider: "scripted", model: "streamer", input_tokens: 120, output_tokens: 30, cache_read_tokens: 100 });
  const counted = (id: string) => snapshot.filter((metric) => metric.id === id).map((metric) => ({ attributes: metric.attributes, state: metric.state }));
  expect(counted("agent.model.time_to_first_token")).toEqual([{ attributes: expect.objectContaining({ provider: "scripted", model: "streamer" }), state: expect.objectContaining({ count: 1 }) }]);
  expect(counted("agent.model.tokens").map((metric) => [metric.attributes?.["kind"], Number((metric.state as { readonly count: number }).count)])).toEqual(
    expect.arrayContaining([
      ["input", 120],
      ["output", 30],
      ["cache_read", 100],
    ]),
  );
});

const state: { mock?: VidaiMock } = {};
beforeAll(async () => {
  state.mock = await startVidaiMock();
});
afterAll(() => state.mock?.stop());

/** A provider's request that answers as `target` with `usage`: its first token 200ms after it starts, and its answer one second after that. */
const answering =
  (usage: Usage): ProviderRequest =>
  (target, _context, turn) =>
    Effect.gen(function* () {
      const passOn = yield* ModelStream;
      yield* TestClock.adjust("200 millis");
      yield* passOn({ _tag: "Delta", kind: "Text", text: "Hello" });
      yield* TestClock.adjust("1 second");
      return {
        _tag: "ModelResponded" as const,
        turn,
        provider: target.provider,
        model: target.model,
        parts: [{ _tag: "Text" as const, text: ModelText.make("Hello") }],
        stop: StopReason.make("end_turn"),
        ending: { _tag: "Complete" as const },
        usage,
        metadata: receivedJson({}),
      };
    });

/**
 * Asks `target` once, through `TimedModelClient` over a chain whose only provider is `request`, with
 * each attempt observed, inside a request's span; on the test clock unless `clock` is `live`.
 * Returns the request's and the attempt's span attributes, and each metric's attributes and count.
 */
const askOnce = async (target: Target, request: Effect.Effect<ProviderRequest>, clock: "test" | "live" = "test") => {
  const spans: Array<SpanLine> = [];
  const chain = Layer.unwrap(Effect.map(request, (each) => FallbackModelClient({ requests: new Map([[target.provider, observedAttempts(each)]]), fallbacks: [] })));
  const snapshot = await runTest(
    Effect.gen(function* () {
      const client = yield* ModelClient;
      const context = { system: undefined, tools: [], messages: [{ role: "user" as const, parts: [{ _tag: "Text" as const, text: "hi" }] }] };
      yield* client.respond(target, context, TurnId.make("turn-1")).pipe(Effect.provideService(ModelStream, () => Effect.void), Effect.withSpan("agent.model.request"));
      return yield* Metric.snapshot;
    }).pipe(
      Effect.provide(Layer.mergeAll(TimedModelClient(chain), SpansTo((line) => void spans.push(line)), ...(clock === "test" ? [TestClock.layer()] : []))),
      Effect.provideService(Metric.MetricRegistry, new Map()),
      Effect.provideService(Report, () => Effect.void),
    ),
  );
  const attributesOf = (name: string) => spans.find((span) => span.name === name)?.attributes ?? {};
  const counted = (id: string) =>
    snapshot.filter((metric) => metric.id === id).map((metric) => ({ attributes: metric.attributes, count: "count" in metric.state ? Number(metric.state.count) : undefined }));
  return { request: attributesOf("agent.model.request"), attempt: attributesOf("agent.model.attempt"), counted };
};

test("a priced model's response: its request's span has priced=true, the cost and each component; the cost is counted by component; the attempt and the request have the attempt's tokens per second after its first token", async () => {
  const target = { provider: ProviderName.make("anthropic"), model: ModelName.make("claude-sonnet-5-5") };
  const usage: Usage = { input: TokenCount.make(6000), cacheRead: TokenCount.make(3000), cacheWrite: TokenCount.make(2000), cacheWrite1h: TokenCount.make(1000), output: TokenCount.make(100) };
  const { request, attempt, counted } = await askOnce(target, Effect.succeed(answering(usage)));
  // 100 tokens in the one second after the first token, which came 200ms after the attempt started.
  expect(attempt).toMatchObject({ outcome: "responded", ending: "Complete", stop: "end_turn", output_tokens: 100, ttft_ms: 200, tokens_per_second: 100 });
  // 1,000 uncached at $2, 100 out at $10, 3,000 read at $0.20, 1,000 written for five minutes at $2.50 and 1,000 for an hour at $4, per million.
  const components = { input: 0.002, output: 0.001, cache_read: 0.0006, cache_write: 0.0065 };
  expect(request).toMatchObject({
    outcome: "responded",
    ending: "Complete",
    stop: "end_turn",
    uncached_input_tokens: 1000,
    ttft_ms: 200,
    tokens_per_second: 100,
    priced: true,
    cost_usd: expect.closeTo(0.0101, 12),
    cost_input_usd: expect.closeTo(components.input, 12),
    cost_output_usd: expect.closeTo(components.output, 12),
    cost_cache_read_usd: expect.closeTo(components.cache_read, 12),
    cost_cache_write_usd: expect.closeTo(components.cache_write, 12),
  });
  expect(counted("agent.model.cost").map(({ attributes, count }) => [attributes?.["component"], count])).toEqual(
    Object.entries(components).map(([component, usd]) => [component, expect.closeTo(usd, 12)]),
  );
  expect(counted("agent.model.responses")).toEqual([{ attributes: expect.objectContaining({ provider: "anthropic", model: "claude-sonnet-5-5", outcome: "responded", priced: "true" }), count: 1 }]);
});

test("a model with no price (a local one): its request's span has priced=false and no cost attribute, and no cost is counted", async () => {
  const target = { provider: ProviderName.make("localhost"), model: ModelName.make("qwen3.5-9b-8bit") };
  const { request, counted } = await askOnce(target, Effect.succeed(answering({ input: TokenCount.make(900), output: TokenCount.make(100) })));
  expect(request).toMatchObject({ outcome: "responded", priced: false, input_tokens: 900 });
  expect(Object.keys(request).filter((key) => key.startsWith("cost"))).toEqual([]);
  expect(counted("agent.model.cost")).toEqual([]);
  expect(counted("agent.model.responses")).toEqual([{ attributes: expect.objectContaining({ provider: "localhost", outcome: "responded", priced: "false" }), count: 1 }]);
});

test("an attempt that fails (the key refused, HTTP 401) has its failure, error kind, signature and HTTP status on its span; its request's span has the failure, kind and signature, and neither priced nor a cost, having no response", async () => {
  const mock = state.mock;
  if (mock === undefined) throw new Error("VidaiMock did not start");
  const target = { provider: ProviderName.make("anthropic"), model: ModelName.make("claude-sonnet-5-5") };
  const { request, attempt, counted } = await askOnce(target, anthropicRequests({ times: 0, firstWait: "1 millis" }).pipe(Effect.provide(anthropicAtMock(mock, 401))), "live");
  expect(attempt).toMatchObject({ outcome: "failed", error_kind: "AuthenticationError", http_status: 401, failure: expect.stringContaining("AnthropicModelClient.respond") });
  expect(attempt["error_signature"]).toBeString();
  expect(request).toMatchObject({
    outcome: "failed",
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    failure: attempt["failure"],
    error_kind: "AuthenticationError",
    error_signature: attempt["error_signature"],
  });
  expect(Object.keys(request).filter((key) => key === "priced" || key.startsWith("cost"))).toEqual([]);
  expect(counted("agent.model.responses")).toEqual([{ attributes: { provider: "anthropic", model: "claude-sonnet-5-5", outcome: "failed" }, count: 1 }]);
});

test("an attempt whose first try is answered 529 and whose retry is answered 200 responded, and has no HTTP status on its span", async () => {
  let asked = 0;
  // The first request is answered 529; every later one streams a short answer.
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      asked++ === 0
        ? new Response("Overloaded", { status: 529 })
        : chatChunks([{ choices: [{ index: 0, delta: { role: "assistant", content: "Hi" } }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }]),
  });
  try {
    const target = { provider: ProviderName.make("localhost"), model: ModelName.make("qwen3.5-9b-8bit") };
    const client = OpenAiCompatClient.layer({ apiUrl: server.url.origin, apiKey: Redacted.make("test-key") }).pipe(Layer.provide(FetchHttpClient.layer));
    const { attempt } = await askOnce(target, openAiCompatRequests({ times: 1, firstWait: "1 millis" }).pipe(Effect.provide(client)), "live");
    expect(asked).toBe(2);
    expect(attempt["outcome"]).toBe("responded");
    expect("http_status" in attempt).toBe(false);
  } finally {
    await server.stop(true);
  }
});
