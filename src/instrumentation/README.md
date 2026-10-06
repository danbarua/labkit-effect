# instrumentation

Tool usage counted two ways, and OpenTelemetry. None of it changes what the loop does.

- `tool-stats.ts`: counts per tool, worked out from a session's facts.
- `tool-metrics.ts`: the same counts recorded while tools run, as Effect metrics (a counter and a
  timer), each with the session, the tool and how the run ended.
- `telemetry.ts`: Effect's own tracer, logger and metrics, sent on. With
  `OTEL_EXPORTER_OTLP_ENDPOINT` set, spans, log lines and metrics go to it as OTLP (HTTP, JSON):
  - from the CLI (`labkit-cli`), the ACP launcher (`labkit-acp`), every `runTest` (`labkit-tests`),
    zork (`labkit-zork`) and the probes (`labkit-probe`). `OTEL_SERVICE_NAME` overrides the name.
  - Log lines are sent without the environment's secrets, as the log files are written.
  - To send everything to a local collector (such as `grafana/otel-lgtm`), add
    `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` to `.env`, which Bun reads for every
    command run in this repository. The test suite then takes about 3 seconds longer.
  `SpansTo` passes each span to a function as it ends, as well as to the tracer already in place.
  `TelemetryToFiles` does both, and writes a run's spans to `<base>.spans.jsonl` and its log lines
  to `<base>.logs.jsonl`, one JSON object per line. The live probes in `scripts/probes/` write both
  beside their transcripts, in a folder per run (`logs/probes/<probe>/<run>/`).

The spans form one trace per session: `agent.session`, then each `agent.turn` under it, then each
request's span under its turn (`agent.model.request`, `agent.tool.run`, `agent.turn.review`,
`agent.turn.stop`), each `agent.model.attempt` of a fallback chain under its request, and the HTTP
client's own `http.client` spans under those. A span's line has its name, trace, span and parent
ids, start, end, duration in milliseconds, attributes, status and events. A log line written inside
a span has that span's `traceId` and `spanId`.

Reference, for whoever adds to it. Effect's published guides describe version 3; this repository
uses version 4, whose source is in `repos/effect`.

- Metrics: <https://effect.website/docs/observability/metrics/>, `repos/effect/packages/effect/src/Metric.ts`
- Tracing (spans): <https://effect.website/docs/observability/tracing/>, `repos/effect/packages/effect/src/Tracer.ts`
- Logging: <https://effect.website/docs/observability/logging/>, `repos/effect/packages/effect/src/Logger.ts`
- OTLP: `repos/effect/packages/effect/src/observability/` (`Otlp.ts`, `OtlpTracer.ts`)
