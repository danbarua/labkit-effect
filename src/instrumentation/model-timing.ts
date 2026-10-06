/**
 * How a model's response arrives, on the span of the attempt that received it
 * (`agent.model.attempt`, `agent-session/model-fallback.ts`), and as metrics.
 *
 * `TimedModelClient` wraps any model client, and watches what each request passes on while its
 * response streams (`agent-session/model-stream.ts`):
 *
 * - On the attempt's span, an event marks the first time each of these arrives: the first stream
 *   event (`first event`), the first readable thinking (`first thinking`), the first text of the
 *   answer or of commentary (`first text`). Each tool call is marked when it has been parsed whole
 *   (`tool call parsed`, with the tool's name). The span's attributes hold the same times as
 *   milliseconds from the attempt's start (`first_event_ms`, `first_thinking_ms`, `first_text_ms`,
 *   `ttft_ms` for the first of thinking and text), and the number of tool calls (`tool_calls`).
 * - A response's token use is put on the request's span (`input_tokens`, `output_tokens`,
 *   `thinking_tokens`, `cache_read_tokens`, `cache_write_tokens`) and counted
 *   (`agent.model.tokens`, by provider, model and kind).
 * - The time to the first token is recorded (`agent.model.time_to_first_token`, by provider and
 *   model).
 *
 * A response that does not stream passes nothing on, so its attempt has no such events.
 */

import { Clock, Duration, Effect, Layer, Metric, Ref, type Tracer } from "effect";
import type { Observation } from "../agent-machine/observation.ts";
import { ModelClient } from "../agent-session/contracts.ts";
import { ModelStream, type Streamed } from "../agent-session/model-stream.ts";

export const timeToFirstToken = Metric.timer("agent.model.time_to_first_token", { description: "Time from a model attempt's start to its first thinking or text, by provider and model." });

export const tokens = Metric.counter("agent.model.tokens", { description: "Tokens a model's responses used, by provider, model and kind (input, output, thinking, cache_read, cache_write)." });

/** The moments that are marked once per attempt. */
type First = "first event" | "first thinking" | "first text";

/** Returns the moment that `streamed` is the first of, when it is one; a tool call parsed is marked each time. */
const momentOf = (streamed: Streamed): First | "tool call parsed" | undefined => {
  switch (streamed._tag) {
    case "Chunk":
      return "first event";
    case "Delta":
      return streamed.kind === "Thinking" ? "first thinking" : "first text";
    case "Part":
      return streamed.part._tag === "ToolCall" ? "tool call parsed" : undefined;
    default:
      return streamed satisfies never;
  }
};

/** The span attribute that holds each first moment's time, in milliseconds from the attempt's start. */
const attributeOf: Readonly<Record<First, string>> = { "first event": "first_event_ms", "first thinking": "first_thinking_ms", "first text": "first_text_ms" };

/** What the request has marked so far, by attempt span: the first moments seen, and the tool calls parsed. */
interface Marked {
  readonly firsts: ReadonlySet<string>;
  readonly toolCalls: ReadonlyMap<string, number>;
}

/**
 * Marks `streamed` on `span`, the attempt that received it, when it is a first moment or a tool call,
 * with `now` as its time. Returns what is marked after it, and, when `streamed` is the attempt's
 * first token, the milliseconds from the attempt's start to it.
 */
const mark = (span: Tracer.Span, streamed: Streamed, now: bigint, marked: Marked): { readonly marked: Marked; readonly firstToken?: number } => {
  const moment = momentOf(streamed);
  if (moment === undefined) return { marked };
  if (moment === "tool call parsed") {
    const count = (marked.toolCalls.get(span.spanId) ?? 0) + 1;
    span.event(moment, now, streamed._tag === "Part" && streamed.part._tag === "ToolCall" ? { tool: streamed.part.tool } : {});
    span.attribute("tool_calls", count);
    return { marked: { ...marked, toolCalls: new Map([...marked.toolCalls, [span.spanId, count]]) } };
  }
  const key = `${span.spanId} ${moment}`;
  if (marked.firsts.has(key)) return { marked };
  const since = Number(now - span.status.startTime) / 1e6;
  span.event(moment, now);
  span.attribute(attributeOf[moment], since);
  const firstToken = moment !== "first event" && !marked.firsts.has(`${span.spanId} first thinking`) && !marked.firsts.has(`${span.spanId} first text`);
  if (firstToken) span.attribute("ttft_ms", since);
  return { marked: { ...marked, firsts: new Set([...marked.firsts, key]) }, ...(firstToken ? { firstToken: since } : {}) };
};

/** Records `since`, the time to the attempt `span`'s first token, by its provider and model. */
const recordFirstToken = (span: Tracer.Span, since: number) =>
  Metric.update(Metric.withAttributes(timeToFirstToken, { provider: String(span.attributes.get("provider")), model: String(span.attributes.get("model")) }), Duration.millis(since));

/** Puts a response's token use on the current span (the request's), and counts it by provider, model and kind. */
const recordUsage = (response: Observation) =>
  Effect.gen(function* () {
    if (response._tag !== "ModelResponded" || response.usage === undefined) return;
    const { usage, provider, model } = response;
    const used = { input: usage.input, output: usage.output, thinking: usage.thinking, cache_read: usage.cacheRead, cache_write: usage.cacheWrite };
    yield* Effect.forEach(Object.entries(used), ([kind, count]) =>
      count === undefined
        ? Effect.void
        : Effect.annotateCurrentSpan(`${kind}_tokens`, count).pipe(Effect.andThen(Metric.update(Metric.withAttributes(tokens, { provider, model, kind }), count))),
    );
  });

export const TimedModelClient = <E, R>(inner: Layer.Layer<ModelClient, E, R>): Layer.Layer<ModelClient, E, R> =>
  Layer.effect(
    ModelClient,
    Effect.gen(function* () {
      const client = yield* ModelClient;
      return {
        respond: (target, context, turn) =>
          Effect.gen(function* () {
            const passOn = yield* ModelStream;
            const marked = yield* Ref.make<Marked>({ firsts: new Set(), toolCalls: new Map() });
            // The stream is passed on as the client sends it; each item is marked on the span of the attempt that received it.
            const watched = (streamed: Streamed) =>
              Effect.gen(function* () {
                const span = yield* Effect.option(Effect.currentSpan);
                if (span._tag === "Some") {
                  const now = yield* Clock.currentTimeNanos;
                  const after = mark(span.value, streamed, now, yield* Ref.get(marked));
                  yield* Ref.set(marked, after.marked);
                  if (after.firstToken !== undefined) yield* recordFirstToken(span.value, after.firstToken);
                }
                yield* passOn(streamed);
              });
            const response = yield* client.respond(target, context, turn).pipe(Effect.provideService(ModelStream, watched));
            yield* recordUsage(response);
            return response;
          }),
      };
    }),
  ).pipe(Layer.provide(inner));
