/**
 * Telemetry: a FizzBuzz session's spans reach the tracer, each under the span it belongs to, and a
 * file; with an OTLP endpoint set, its spans, log lines and tool metrics reach that too.
 */

import { readFileSync, rmSync } from "node:fs";
import { expect } from "bun:test";
import { test } from "./support/test.ts";
import { ConfigProvider, Effect, Layer, Metric } from "effect";
import { ModelName, ProviderName } from "../src/agent-machine/names.ts";
import { ModelClient, type ProviderRequest } from "../src/agent-session/contracts.ts";
import { FallbackModelClient } from "../src/agent-session/model-fallback.ts";
import { scriptedFizzBuzzModel } from "../src/examples/fizzbuzz/model.ts";
import { advanced, play } from "../src/examples/fizzbuzz/scenario.ts";
import { FizzBuzzToolRunner } from "../src/examples/fizzbuzz/tools.ts";
import { type SpanLine, SpansTo, TelemetryToFiles } from "../src/instrumentation/telemetry.ts";
import { CountedToolRunner } from "../src/instrumentation/tool-metrics.ts";
import { runTest } from "./support/run.ts";

test("each request is a span with the session, turn, call and tool", async () => {
  const ended: Array<SpanLine> = [];
  await runTest(
    play(["1", "3", "7"], { ...advanced, session: "carol" }).pipe(Effect.provide(SpansTo((line) => ended.push(line)))),
  );
  expect(ended.filter((span) => span.name === "agent.tool.run").map(({ name, attributes }) => ({ name, attributes }))).toEqual([
    { name: "agent.tool.run", attributes: { session: "carol", turn: "turn-2", call: "call-1", tool: "classify" } },
    { name: "agent.tool.run", attributes: { session: "carol", turn: "turn-3", call: "call-2", tool: "report_error" } },
  ]);
  expect(ended.filter((span) => span.name === "agent.model.request").length).toBe(5);
});

const readLines = <A>(path: string): ReadonlyArray<A> =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as A);

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
  const lines = readLines<SpanLine>(`${base}.spans.jsonl`);
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

test("with OTEL_EXPORTER_OTLP_ENDPOINT set, the spans go to it and to the file, and log lines and tool metrics go to it", async () => {
  const received: Array<{ readonly path: string; readonly body: unknown }> = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      received.push({ path: new URL(request.url).pathname, body: await request.json() });
      return Response.json({});
    },
  });
  try {
    const base = "logs/telemetry-test/otlp";
    rmSync(`${base}.spans.jsonl`, { force: true });
    rmSync(`${base}.logs.jsonl`, { force: true });
    await runTest(
      play(["1", "3", "7"], { ...advanced, session: "erin", tools: CountedToolRunner(FizzBuzzToolRunner) }).pipe(
        Effect.provide(TelemetryToFiles(base)),
        Effect.provideService(Metric.MetricRegistry, new Map()),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnvRecord({ OTEL_EXPORTER_OTLP_ENDPOINT: `http://localhost:${server.port}` }),
        ),
      ),
    );
    const at = (path: string) => received.filter((each) => each.path === path).map((each) => each.body as Record<string, any>);
    const sent: ReadonlyArray<{ readonly name: string; readonly spanId: string }> = at("/v1/traces").flatMap((body) =>
      body["resourceSpans"].flatMap((resource: any) => resource.scopeSpans.flatMap((scope: any) => scope.spans)),
    );
    const written = readLines<SpanLine>(`${base}.spans.jsonl`);
    expect(written.length).toBeGreaterThan(0);
    expect(new Set(sent.map((span) => `${span.name} ${span.spanId}`))).toEqual(
      new Set(written.map((span) => `${span.name} ${span.spanId}`)),
    );
    expect(sent.filter((span) => span.name === "agent.session").length).toBe(1);

    const metrics = at("/v1/metrics").flatMap((body) =>
      body["resourceMetrics"].flatMap((resource: any) => resource.scopeMetrics.flatMap((scope: any) => scope.metrics)),
    );
    expect(metrics.some((metric: any) => metric.name === "agent.tool.runs")).toBe(true);
    const logs = at("/v1/logs").flatMap((body) =>
      body["resourceLogs"].flatMap((resource: any) => resource.scopeLogs.flatMap((scope: any) => scope.logRecords)),
    );
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.length).toBe(readLines(`${base}.logs.jsonl`).length);
  } finally {
    await server.stop(true);
  }
});
