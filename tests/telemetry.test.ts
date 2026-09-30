/**
 * OpenTelemetry: a FizzBuzz session's spans and tool metrics reach in-memory OpenTelemetry outputs,
 * and its spans reach a file, each under the span it belongs to.
 */

import { readFileSync, rmSync } from "node:fs";
import { expect } from "bun:test";
import { test } from "./support/test.ts";
import { MetricReader } from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { Effect, Layer, Metric } from "effect";
import { ModelName, ProviderName } from "../src/agent-machine/names.ts";
import { ModelClient, type ProviderRequest } from "../src/agent-session/contracts.ts";
import { FallbackModelClient } from "../src/agent-session/model-fallback.ts";
import { scriptedFizzBuzzModel } from "../src/examples/fizzbuzz/model.ts";
import { advanced, play } from "../src/examples/fizzbuzz/scenario.ts";
import { FizzBuzzToolRunner } from "../src/examples/fizzbuzz/tools.ts";
import { AgentTelemetry, TelemetryToFiles } from "../src/instrumentation/telemetry.ts";
import { CountedToolRunner } from "../src/instrumentation/tool-metrics.ts";
import { runTest } from "./support/run.ts";

/** A metric reader collected by hand. */
class ReadOnDemand extends MetricReader {
  protected override onForceFlush(): Promise<void> {
    return Promise.resolve();
  }
  protected override onShutdown(): Promise<void> {
    return Promise.resolve();
  }
}

test("each request is a span with the session, turn, call and tool; tool runs are counted per session", async () => {
  const spans = new InMemorySpanExporter();
  const metrics = new ReadOnDemand();
  // Read before the telemetry layer is released: shutting it down clears the in-memory exporter.
  const { finished, collected } = await runTest(
    Effect.gen(function* () {
      yield* play(["1", "3", "7"], { ...advanced, session: "carol", tools: CountedToolRunner(FizzBuzzToolRunner) });
      return {
        finished: spans.getFinishedSpans().map((span) => ({ name: span.name, attributes: span.attributes })),
        collected: yield* Effect.promise(() => metrics.collect()),
      };
    }).pipe(
      Effect.provide(AgentTelemetry({ spans: new SimpleSpanProcessor(spans), metrics })),
      Effect.provideService(Metric.MetricRegistry, new Map()),
    ),
  );
  expect(finished.filter((span) => span.name === "agent.tool.run")).toEqual([
    { name: "agent.tool.run", attributes: { session: "carol", turn: "turn-2", call: "call-1", tool: "classify" } },
    { name: "agent.tool.run", attributes: { session: "carol", turn: "turn-3", call: "call-2", tool: "report_error" } },
  ]);
  expect(finished.filter((span) => span.name === "agent.model.request").length).toBe(5);
  const runs = collected.resourceMetrics.scopeMetrics
    .flatMap((scope) => scope.metrics)
    .filter((metric) => metric.descriptor.name === "agent.tool.runs")
    .flatMap((metric) => metric.dataPoints.map((point) => ({ attributes: point.attributes, value: point.value })));
  expect(runs).toEqual([
    { attributes: { session: "carol", tool: "classify", outcome: "Succeeded" }, value: 1 },
    { attributes: { session: "carol", tool: "report_error", outcome: "Succeeded" }, value: 1 },
  ]);
});

interface SpanLine {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly attributes: Record<string, unknown>;
}

test("the file holds the session's span, each turn's under it, each request's under its turn, and each attempt under its request", async () => {
  const base = "logs/telemetry-test/spans-tree";
  rmSync(`${base}.spans.jsonl`, { force: true });
  rmSync(`${base}.logs.jsonl`, { force: true });
  const target = { provider: ProviderName.make("scripted"), model: ModelName.make("fizzbuzz-1") };
  // The scripted model as a provider's request, behind the fallback chain, so each request makes an attempt.
  const client = Layer.unwrap(
    Effect.gen(function* () {
      const scripted = yield* ModelClient;
      const request: ProviderRequest = (to, context, turn) =>
        scripted.respond(to, context, turn).pipe(
          Effect.filterOrElse(
            (outcome): outcome is Extract<typeof outcome, { _tag: "ModelResponded" }> => outcome._tag === "ModelResponded",
            (outcome) => Effect.die(outcome),
          ),
        );
      return FallbackModelClient({ requests: new Map([[target.provider, request]]), fallbacks: [] });
    }),
  ).pipe(Layer.provide(scriptedFizzBuzzModel().layer));
  await runTest(
    play(["1", "3", "7"], { ...advanced, session: "dave", model: { target, client } }).pipe(Effect.provide(TelemetryToFiles(base))),
  );
  const lines = readFileSync(`${base}.spans.jsonl`, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as SpanLine);
  const named = (name: string) => lines.filter((span) => span.name === name);
  const [session, ...more] = named("agent.session");
  expect(more).toEqual([]);
  if (session === undefined) throw new Error("no agent.session span was written");
  expect(session.parentSpanId).toBeUndefined();
  expect(session.attributes).toEqual({ session: "dave" });
  expect(new Set(lines.map((span) => span.traceId))).toEqual(new Set([session.traceId]));

  const turns = named("agent.turn");
  expect(turns.map((span) => span.attributes)).toEqual([
    { session: "dave", turn: "turn-1", ending: "Answered" },
    { session: "dave", turn: "turn-2", ending: "Answered" },
    { session: "dave", turn: "turn-3", ending: "Answered" },
  ]);
  expect(turns.filter((span) => span.parentSpanId !== session.spanId)).toEqual([]);
  const turnOf = new Map(turns.map((span) => [span.attributes["turn"], span.spanId]));

  const requests = named("agent.model.request");
  expect(requests.length).toBe(5);
  expect(named("agent.tool.run").length).toBe(2);
  expect(named("agent.turn.review").length).toBe(3);
  const underTurns = [...requests, ...named("agent.tool.run"), ...named("agent.turn.review")];
  expect(
    underTurns.filter((span) => !turnOf.has(span.attributes["turn"]) || span.parentSpanId !== turnOf.get(span.attributes["turn"])),
  ).toEqual([]);

  const attempts = named("agent.model.attempt");
  expect(attempts.length).toBe(5);
  expect(new Set(attempts.map((span) => span.parentSpanId))).toEqual(new Set(requests.map((span) => span.spanId)));
});
