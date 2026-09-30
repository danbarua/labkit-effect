/**
 * OpenTelemetry for the harness, through Effect's OpenTelemetry package: the spans the loop opens
 * (the session, each turn, each request), Effect metrics such as the tool counters, and Effect's log
 * lines go to the span processor, metric reader and log processor given. Which exporter they feed
 * (a file, the console, memory) is the caller's choice.
 *
 * `TelemetryToFiles` is the one for reading without a collector: a run's spans and log lines, one
 * JSON object per line, in two files.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as NodeSdk from "@effect/opentelemetry/NodeSdk";
import type { HrTime } from "@opentelemetry/api";
import {
  type LogRecordExporter,
  type LogRecordProcessor,
  type ReadableLogRecord,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import type { MetricReader } from "@opentelemetry/sdk-metrics";
import { type ReadableSpan, SimpleSpanProcessor, type SpanExporter, type SpanProcessor } from "@opentelemetry/sdk-trace-base";

export const AgentTelemetry = (outputs: {
  readonly spans: SpanProcessor;
  readonly metrics?: MetricReader;
  readonly logs?: LogRecordProcessor;
}) =>
  NodeSdk.layer(() => ({
    resource: { serviceName: "labkit-effect" },
    spanProcessor: outputs.spans,
    metricReader: outputs.metrics,
    logRecordProcessor: outputs.logs,
  }));

const millisOf = ([seconds, nanos]: HrTime): number => seconds * 1000 + nanos / 1e6;
const isoOf = (time: HrTime): string => new Date(millisOf(time)).toISOString();

/** Appends each of `lines` to the file at `path` as JSON on a line of its own, making its folder if missing. */
const append = (path: string, lines: ReadonlyArray<unknown>): void => {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
};

/** One span as a line. `parentSpanId` is absent on a span with no parent. */
export const spanLine = (span: ReadableSpan) => ({
  name: span.name,
  traceId: span.spanContext().traceId,
  spanId: span.spanContext().spanId,
  parentSpanId: span.parentSpanContext?.spanId,
  start: isoOf(span.startTime),
  end: isoOf(span.endTime),
  durationMs: millisOf(span.duration),
  attributes: span.attributes,
  status: span.status,
  events: span.events.map((event) => ({ name: event.name, time: isoOf(event.time), attributes: event.attributes })),
});

/** Writes each span to the file at `path` as it is exported, one JSON object per line. */
export class JsonLinesSpanExporter implements SpanExporter {
  constructor(readonly path: string) {}
  export(spans: Array<ReadableSpan>, done: Parameters<SpanExporter["export"]>[1]): void {
    append(this.path, spans.map(spanLine));
    done({ code: 0 });
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/** One log line. Its attributes hold the `traceId` and `spanId` of the span it was written in, if any. */
export const logLine = (record: ReadableLogRecord) => ({
  time: isoOf(record.hrTime),
  level: record.severityText,
  body: record.body,
  attributes: record.attributes,
});

/** Writes each log record to the file at `path` as it is exported, one JSON object per line. */
export class JsonLinesLogExporter implements LogRecordExporter {
  constructor(readonly path: string) {}
  export(records: Array<ReadableLogRecord>, done: Parameters<LogRecordExporter["export"]>[1]): void {
    append(this.path, records.map(logLine));
    done({ code: 0 });
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Spans to `<base>.spans.jsonl` and Effect's log lines to `<base>.logs.jsonl`. Each is written as
 * it ends or is logged, so a run that stops early leaves what it got to. Log lines still go to the
 * loggers already installed too. The session's span ends when the scope it was opened in closes, so
 * this layer is provided outside that scope, or the session's span is never written.
 */
export const TelemetryToFiles = (base: string) =>
  AgentTelemetry({
    spans: new SimpleSpanProcessor(new JsonLinesSpanExporter(`${base}.spans.jsonl`)),
    logs: new SimpleLogRecordProcessor({ exporter: new JsonLinesLogExporter(`${base}.logs.jsonl`) }),
  });
