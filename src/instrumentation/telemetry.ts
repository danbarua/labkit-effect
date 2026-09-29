/**
 * OpenTelemetry for the harness, through Effect's OpenTelemetry package: the spans the loop opens
 * around each request, and Effect metrics such as the tool counters, go to the span processor and
 * metric reader given. Which exporter they feed (OTLP, the console, memory) is the caller's choice.
 */

import * as NodeSdk from "@effect/opentelemetry/NodeSdk";
import type { MetricReader } from "@opentelemetry/sdk-metrics";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";

export const AgentTelemetry = (outputs: { readonly spans: SpanProcessor; readonly metrics?: MetricReader }) =>
  NodeSdk.layer(() => ({
    resource: { serviceName: "labkit-effect" },
    spanProcessor: outputs.spans,
    metricReader: outputs.metrics,
  }));
