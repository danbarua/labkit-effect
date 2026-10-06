/** `TimedModelClient`, around a client that streams a response inside an attempt's span. */

import { expect } from "bun:test";
import { Effect, Layer, Metric } from "effect";
import { runTest } from "../../tests/support/run.ts";
import { test } from "../../tests/support/test.ts";
import { CallId, ModelName, ModelText, ProviderName, TokenCount, ToolName, TurnId } from "../agent-machine/names.ts";
import { ModelClient } from "../agent-session/contracts.ts";
import { ModelStream } from "../agent-session/model-stream.ts";
import { receivedJson } from "../agent-session/received.ts";
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
