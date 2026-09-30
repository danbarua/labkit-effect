# instrumentation

Tool usage counted two ways, and OpenTelemetry. None of it changes what the loop does.

- `tool-stats.ts`: counts per tool, worked out from a session's facts.
- `tool-metrics.ts`: the same counts recorded while tools run, as Effect metrics (a counter and a
  timer), each with the session, the tool and how the run ended.
- `telemetry.ts`: a layer that sends the loop's spans and Effect's metrics to OpenTelemetry.

Reference, for whoever adds to it. Effect's published guides describe version 3; this repository
uses version 4, whose source is in `repos/effect`.

- Metrics: <https://effect.website/docs/observability/metrics/>, `repos/effect/packages/effect/src/Metric.ts`
- Tracing (spans): <https://effect.website/docs/observability/tracing/>, `repos/effect/packages/effect/src/Tracer.ts`
- Logging: <https://effect.website/docs/observability/logging/>, `repos/effect/packages/effect/src/Logger.ts`
- OpenTelemetry: `repos/effect/packages/opentelemetry/src/NodeSdk.ts`
