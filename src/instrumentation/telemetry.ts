/**
 * Telemetry for the harness, through Effect's own tracer, logger and metrics: the spans the loop
 * opens (the session, each turn, each request), Effect's log lines, and Effect metrics such as the
 * tool counters.
 *
 * - When `OTEL_EXPORTER_OTLP_ENDPOINT` is set, spans, log lines and metrics are sent to it as OTLP
 *   over HTTP, in JSON (`effect/observability`). When it is not set, nothing is sent. Effect's own
 *   `Otlp.layerFromConfig` also asks for `OTEL_TRACES_EXPORTER=otlp` and its kin, which this does not.
 *   - The service is named `OTEL_SERVICE_NAME` when it is set, else the name its caller gives
 *     (`labkit-cli`, `labkit-acp`, `labkit-tests`); `OTEL_RESOURCE_ATTRIBUTES` adds attributes.
 *     Each process is an instance of its service (`service.instance.id`, a random id).
 *   - A log line's body is one JSON object: its text parts joined as `message`, and the fields of
 *     the objects logged with it (`Effect.logInfo(logKeys.x, { … })`), so that Loki shows the fields.
 *   - A log line is sent without the environment's secrets (`agent-host/redaction.ts`) in its
 *     message, its annotations or its cause, as the log files are written.
 *   - `OtlpSpansAndMetrics` sends spans and metrics. `otlpLogger` is the logger that sends log lines:
 *     a host adds it to the loggers it installs, because `Logger.layer` replaces the loggers in
 *     place. `OtlpFromEnv` is both, for a program that installs no loggers of its own.
 * - `SpansTo`: a tracer that makes each span with the tracer already in place (OTLP's, or Effect's
 *   default) and also passes it, as a `SpanLine`, to a function when it ends.
 * - `TelemetryToFiles`: both, writing a run's spans to `<base>.spans.jsonl` and its log lines to
 *   `<base>.logs.jsonl`, one JSON object per line, for reading without a collector.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Cause, Config, Context, Effect, Exit, type Fiber, Layer, Logger, Option, References, type Scope, Tracer } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { OtlpExporter, OtlpLogger, OtlpMetrics, OtlpSerialization, OtlpTracer } from "effect/observability";
import { redactedValue, redactorOf, secretsOf } from "../agent-host/redaction.ts";

/** This process's instance of its service (`service.instance.id`). */
const instance = randomUUID();

/** Where OTLP goes and as which service: undefined when `OTEL_EXPORTER_OTLP_ENDPOINT` is not set. */
const otlpTarget = (service: string) =>
  Effect.gen(function* () {
    const endpoint = yield* Config.option(Config.String("OTEL_EXPORTER_OTLP_ENDPOINT"));
    if (Option.isNone(endpoint)) return undefined;
    const named = yield* Config.option(Config.String("OTEL_SERVICE_NAME"));
    const base = endpoint.value.replace(/\/$/, "");
    // Each process is an instance of its service, so that the counts of two runs are two series, not one that restarts.
    return { url: (path: string) => `${base}${path}`, resource: { serviceName: Option.getOrElse(named, () => service), attributes: { "service.instance.id": instance } } };
  }).pipe(Effect.orDie);

/** What the OTLP exporters need besides their options: an HTTP client, JSON, and a flusher. */
const otlpServices = Layer.mergeAll(FetchHttpClient.layer, OtlpSerialization.layerJson, OtlpExporter.layerFlusher);

/** Spans and metrics as OTLP to `OTEL_EXPORTER_OTLP_ENDPOINT`, when it is set; otherwise nothing. */
export const OtlpSpansAndMetrics = (service: string): Layer.Layer<never> =>
  Layer.unwrap(
    Effect.map(otlpTarget(service), (target) =>
      target === undefined
        ? Layer.empty
        : Layer.mergeAll(OtlpTracer.layer({ url: target.url("/v1/traces"), resource: target.resource }), OtlpMetrics.layer({ url: target.url("/v1/metrics"), resource: target.resource })).pipe(
            Layer.provide(otlpServices),
          ),
    ),
  );

/**
 * `fiber`, whose log annotations read with the environment's secrets redacted. The OTLP logger reads
 * a log line's annotations from its fiber, so they are redacted where it reads them.
 */
const withRedactedAnnotations = (fiber: Fiber.Fiber<unknown, unknown>, redact: (text: string) => string): Fiber.Fiber<unknown, unknown> =>
  new Proxy(fiber, {
    get: (target, key) => {
      if (key === "getRef")
        return (reference: Context.Reference<unknown>) => (reference === References.CurrentLogAnnotations ? redactedValue(target.getRef(reference), redact) : target.getRef(reference));
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

/** JSON that holds a bigint as its digits, where `JSON.stringify` would throw. */
const json = (value: unknown): string => JSON.stringify(value, (_, each) => (typeof each === "bigint" ? each.toString() : each));

const isFields = (part: unknown): part is Readonly<Record<string, unknown>> => typeof part === "object" && part !== null && !Array.isArray(part);

/**
 * Returns a log line's message as one JSON object: its text parts joined by spaces as `message`, and
 * the fields of its objects. Another kind of part (an array) is listed under `values`. When an
 * object has a field named `message`, the objects' fields are under `fields` instead.
 */
const jsonBody = (message: unknown): string => {
  const parts: ReadonlyArray<unknown> = Array.isArray(message) ? message : [message];
  const text = parts.filter((part) => !isFields(part) && !Array.isArray(part)).map(String).join(" ");
  const fields = Object.assign({}, ...parts.filter(isFields)) as Readonly<Record<string, unknown>>;
  const values = parts.filter((part) => Array.isArray(part));
  return json({ message: text, ...(Object.hasOwn(fields, "message") ? { fields } : fields), ...(values.length === 0 ? {} : { values }) });
};

/**
 * The logger that sends each log line as OTLP to `OTEL_EXPORTER_OTLP_ENDPOINT`, without the
 * environment's secrets in its message, its annotations or its cause; when the variable is not set,
 * a logger that does nothing.
 */
export const otlpLogger = (service: string): Effect.Effect<Logger.Logger<unknown, void>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const target = yield* otlpTarget(service);
    if (target === undefined) return Logger.make(() => undefined);
    const inner = yield* OtlpLogger.make({ url: target.url("/v1/logs"), resource: target.resource }).pipe(Effect.provide(otlpServices));
    const redact = redactorOf(secretsOf(process.env).values);
    return Logger.make((options) =>
      inner.log({
        ...options,
        message: jsonBody(redactedValue(options.message, redact)),
        cause: options.cause.reasons.length === 0 ? options.cause : Cause.fail(redact(Cause.pretty(options.cause))),
        fiber: withRedactedAnnotations(options.fiber, redact),
      }),
    );
  });

/** Spans, log lines and metrics as OTLP to `OTEL_EXPORTER_OTLP_ENDPOINT`, when it is set, for a program that installs no loggers of its own; otherwise nothing. */
export const OtlpFromEnv = (service: string): Layer.Layer<never> => Layer.mergeAll(OtlpSpansAndMetrics(service), Logger.layer([otlpLogger(service)], { mergeWithExisting: true }));

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
export const TelemetryToFiles = (base: string, service = "labkit-probe"): Layer.Layer<never> =>
  Layer.mergeAll(SpansTo((line) => append(`${base}.spans.jsonl`, line)), logsTo(`${base}.logs.jsonl`)).pipe(
    Layer.provideMerge(OtlpFromEnv(service)),
  );
