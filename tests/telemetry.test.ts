/** OpenTelemetry: a FizzBuzz session's spans and tool metrics reach in-memory OpenTelemetry outputs. */

import { expect, test } from "bun:test";
import { MetricReader } from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { Effect, Metric } from "effect";
import { advanced, play } from "../src/fizzbuzz/scenario.ts";
import { FizzBuzzToolRunner } from "../src/fizzbuzz/tools.ts";
import { AgentTelemetry } from "../src/instrumentation/telemetry.ts";
import { CountedToolRunner } from "../src/instrumentation/tool-metrics.ts";

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
  const { finished, collected } = await Effect.runPromise(
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
