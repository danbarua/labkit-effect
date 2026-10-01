/**
 * Telemetry for the harness, through Effect's own tracer, logger and metrics: the spans the loop
 * opens (the session, each turn, each request), Effect's log lines, and Effect metrics such as the
 * tool counters.
 *
 * - `OtlpFromEnv`: when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, spans, log lines and metrics are sent
 *   to it as OTLP over HTTP, in JSON (`effect/observability/Otlp`). When it is not set, nothing is
 *   sent. Effect's own `Otlp.layerFromConfig` also asks for `OTEL_TRACES_EXPORTER=otlp` and its
 *   kin, which this does not.
 * - `SpansTo`: a tracer that makes each span with the tracer already in place (OTLP's, or Effect's
 *   default) and also passes it, as a `SpanLine`, to a function when it ends.
 * - `TelemetryToFiles`: both, writing a run's spans to `<base>.spans.jsonl` and its log lines to
 *   `<base>.logs.jsonl`, one JSON object per line, for reading without a collector.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Cause, Config, Context, Effect, Exit, Layer, Logger, Option, Tracer } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Otlp from "effect/observability/Otlp";

const serviceName = "labkit-effect";

/** Spans, log lines and metrics as OTLP to `OTEL_EXPORTER_OTLP_ENDPOINT`, when it is set; otherwise nothing. */
export const OtlpFromEnv: Layer.Layer<never> = Layer.unwrap(
  Effect.gen(function* () {
    const endpoint = yield* Config.option(Config.String("OTEL_EXPORTER_OTLP_ENDPOINT"));
    return Option.isNone(endpoint)
      ? Layer.empty
      : Otlp.layerJson({ baseUrl: endpoint.value, resource: { serviceName } }).pipe(Layer.provide(FetchHttpClient.layer));
  }).pipe(Effect.orDie),
);

/** One span as it ended. `parentSpanId` is absent on a span with no parent. */
export interface SpanLine {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly start: string;
  readonly end: string;
  readonly durationMs: number;
  readonly attributes: Readonly<Record<string, unknown>>;
  /** `error` carries the cause, as Effect prints it. */
  readonly status: { readonly code: "ok" | "interrupted" | "error"; readonly message?: string };
  readonly events: ReadonlyArray<{ readonly name: string; readonly time: string; readonly attributes: Readonly<Record<string, unknown>> }>;
}

const millisOf = (nanos: bigint): number => Number(nanos) / 1e6;
const isoOf = (nanos: bigint): string => new Date(millisOf(nanos)).toISOString();

const statusOf = (exit: Exit.Exit<unknown, unknown>): SpanLine["status"] => {
  if (Exit.isSuccess(exit)) return { code: "ok" };
  if (Cause.hasInterruptsOnly(exit.cause)) return { code: "interrupted" };
  return { code: "error", message: Cause.pretty(exit.cause) };
};

/** A span made by another tracer, which also passes itself to `ended` as a line when it ends. */
class ReportedSpan implements Tracer.Span {
  readonly _tag = "Span";
  private readonly events: Array<SpanLine["events"][number]> = [];
  constructor(
    private readonly inner: Tracer.Span,
    private readonly ended: (line: SpanLine) => void,
  ) {}
  get name() {
    return this.inner.name;
  }
  get spanId() {
    return this.inner.spanId;
  }
  get traceId() {
    return this.inner.traceId;
  }
  get parent() {
    return this.inner.parent;
  }
  get annotations() {
    return this.inner.annotations;
  }
  get status() {
    return this.inner.status;
  }
  get attributes() {
    return this.inner.attributes;
  }
  get links() {
    return this.inner.links;
  }
  get sampled() {
    return this.inner.sampled;
  }
  get kind() {
    return this.inner.kind;
  }
  end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    const startTime = this.inner.status.startTime;
    this.inner.end(endTime, exit);
    if (!this.inner.sampled) return;
    const parent = Option.getOrUndefined(this.inner.parent);
    this.ended({
      name: this.inner.name,
      traceId: this.inner.traceId,
      spanId: this.inner.spanId,
      ...(parent === undefined ? {} : { parentSpanId: parent.spanId }),
      start: isoOf(startTime),
      end: isoOf(endTime),
      durationMs: millisOf(endTime - startTime),
      attributes: Object.fromEntries(this.inner.attributes),
      status: statusOf(exit),
      events: this.events,
    });
  }
  attribute(key: string, value: unknown): void {
    this.inner.attribute(key, value);
  }
  event(name: string, startTime: bigint, attributes?: Record<string, unknown>): void {
    this.events.push({ name, time: isoOf(startTime), attributes: attributes ?? {} });
    this.inner.event(name, startTime, attributes);
  }
  addLinks(links: ReadonlyArray<Tracer.SpanLink>): void {
    this.inner.addLinks(links);
  }
}

/**
 * Every span, made by the tracer already in place, also passed to `ended` when it ends. Spans the
 * tracer does not sample are not passed on, as OTLP does not send them.
 */
export const SpansTo = (ended: (line: SpanLine) => void): Layer.Layer<never> =>
  Layer.effect(
    Tracer.Tracer,
    Effect.map(Effect.tracer, (inner) =>
      Tracer.make({ span: (options) => new ReportedSpan(inner.span(options), ended), context: inner.context }),
    ),
  );

/** JSON that holds a bigint as its digits, where `JSON.stringify` would throw. */
const json = (value: unknown): string => JSON.stringify(value, (_, each) => (typeof each === "bigint" ? each.toString() : each));

/** Appends `line` to the file at `path` as JSON on a line of its own, making its folder if missing. */
const append = (path: string, line: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${json(line)}\n`);
};

/** Effect's structured log line, with the `traceId` and `spanId` of the span it was written in, if any. */
const logsTo = (path: string) =>
  Logger.layer(
    [
      Logger.make((options) => {
        const span = Context.getOrUndefined(options.fiber.context, Tracer.ParentSpan);
        append(path, {
          ...Logger.formatStructured.log(options),
          ...(span === undefined ? {} : { traceId: span.traceId, spanId: span.spanId }),
        });
      }),
    ],
    { mergeWithExisting: true },
  );

/**
 * Spans to `<base>.spans.jsonl` and log lines to `<base>.logs.jsonl`, each written as it ends or is
 * logged, so a run that stops early leaves what it got to; and, when `OTEL_EXPORTER_OTLP_ENDPOINT`
 * is set, all of it as OTLP too. The session's span ends when the scope it was opened in closes, so
 * this layer is provided outside that scope, or the session's span is never written.
 */
export const TelemetryToFiles = (base: string): Layer.Layer<never> =>
  Layer.mergeAll(SpansTo((line) => append(`${base}.spans.jsonl`, line)), logsTo(`${base}.logs.jsonl`)).pipe(
    Layer.provideMerge(OtlpFromEnv),
  );
