# instrumentation

Tool usage counted two ways, OpenTelemetry, and the bodies of each model request. None of it
changes what the loop does.

- `tool-stats.ts`: counts per tool, worked out from a session's facts.
- `tool-metrics.ts`: the same counts recorded while tools run, as Effect metrics (a counter and a
  timer), each with the session, the tool and how the run ended. `CountedToolRunner` also puts on
  each `agent.tool.run` span how the run ended (`outcome`) and the sizes of the call's input and of
  what the tool returned (`args_chars`, `result_chars`: characters; bytes for binary content).
- `telemetry.ts`: Effect's own tracer, logger and metrics, sent on. With
  `OTEL_EXPORTER_OTLP_ENDPOINT` set, spans, log lines and metrics go to it as OTLP (HTTP, JSON):
  - from the CLI (`labkit-cli`), the ACP launcher (`labkit-acp`), every `runTest` (`labkit-tests`),
    zork (`labkit-zork`), the probes (`labkit-probe`) and the capture server (`labkit-captures`).
    `OTEL_SERVICE_NAME` overrides the name.
  - Log lines are sent without the environment's secrets, as the log files are written.
  - To send everything to a local collector (such as `grafana/otel-lgtm`), add
    `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` to `.env`. Bun reads `.env` from the folder
    a command runs in, so it covers the commands run in this repository. A CLI run from another
    folder needs the variable in the shell's environment. The test suite takes about 3 seconds
    longer with it.
  - `SpansTo` passes each span to a function as it ends, as well as to the tracer already in place.
    `TelemetryToFiles` does both, and writes a run's spans to `<base>.spans.jsonl` and its log lines
    to `<base>.logs.jsonl`, one JSON object per line. The live probes in `scripts/probes/` write both
    beside their transcripts, in a folder per run (`logs/probes/<probe>/<run>/`).
- `model-timing.ts`: `TimedModelClient`, which marks on each model attempt's span the first stream
  event, the first thinking, the first text and each tool call parsed, with their times from the
  attempt's start as attributes (`ttft_ms` among them); puts each response's model, tokens, outcome
  and cost on its request's span (below); and records `agent.model.time_to_first_token`,
  `agent.model.tokens`, `agent.model.cost` and `agent.model.responses`.
- `model-attempts.ts`: `observedAttempts`, wrapped around each provider's requests in
  `agent-host/clients.ts`, which runs inside each `agent.model.attempt` span: the attempt's outcome,
  its output tokens and tokens per second, or its failure; and the capture of the message the
  adapter assembled.
- `error-signature.ts`: a failure's text with its ids and counters replaced, so that failures that
  differ only in a request id group together.
- `http-captures.ts`: the bodies of each model request's HTTP exchange, written to files (below).

## Spans

The spans form one trace for each time a session is opened: `agent.session`, then each `agent.turn`
under it, then each request's span under its turn (`agent.model.request`, `agent.tool.run`,
`agent.turn.review`, `agent.turn.stop`), each `agent.model.attempt` of a fallback chain under its
request, and the HTTP client's own `http.client` spans under those. A span's line has its name,
trace, span and parent ids, start, end, duration in milliseconds, attributes, status and events. A
log line written inside a span has that span's `traceId` and `spanId` (in Loki, the structured
metadata `trace_id` and `span_id`).

- Every span of a session has `cwd` and `host`, as the session's record (`host.json`) holds them.
  The host opens the session under `Effect.annotateSpans`, and the loop carries those annotations
  to the spans that other fibers start.
- `agent.session`: when it ends, the totals of this opening, from the facts recorded since the
  session was opened, resumed or loaded (`sessionTotals` in `agent-session/accounting.ts`):
  `requests`, `failed_requests`, `turns`, `tool_calls`, `failed_tool_calls`, `input_tokens`,
  `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `cost_usd` (only when a response was
  priced), `unpriced_requests`, and `models` (comma-separated `provider/model`, in first-use order).
  A sum over session spans counts each request once.
- `agent.model.request`: `provider`, `model`, the tokens (`input_tokens`, `uncached_input_tokens`,
  `output_tokens`, `thinking_tokens`, `cache_read_tokens`, `cache_write_tokens`), `outcome`
  (`responded` | `failed`), `stop`, `ending`, and the `ttft_ms` and `tokens_per_second` of the
  attempt that answered.
  - A response is *priced* when its model has a price in `capabilitiesOf`
    (`agent-session/configuration/well-known-models.ts`, the one owner of prices) and it reported
    its usage. A priced response's span has `priced=true` and `cost_usd`, `cost_input_usd`
    (uncached input), `cost_output_usd`, `cost_cache_read_usd` and `cost_cache_write_usd` (the
    hour-long cache writes at their own rate). Any other response has `priced=false` and no cost
    attribute: an unknown cost is never recorded as $0. A local model is never priced.
  - A failed request has `failure`, `error_kind` (the `AiError` reason), `error_signature`, and the
    `provider` and `model` it asked; no `priced` and no cost.
- `agent.model.attempt`: `provider`, `model`, the first moments above, `outcome`, `output_tokens`,
  `tokens_per_second` (output tokens ÷ (the attempt's time after its first token, in seconds);
  absent when there was no first token or no time after it), `stop`, `ending`. A failed attempt has
  `failure`, `error_kind`, `error_signature`, and `http_status` when its last HTTP response was not
  2xx; a status that a retry got past is not kept.
- `agent.tool.run`: `outcome`, `args_chars`, `result_chars` (`tool-metrics.ts`).

Metrics, besides the tool counters: `agent.model.time_to_first_token` (provider, model),
`agent.model.tokens` (provider, model, kind), `agent.model.cost` (USD; provider, model, component:
input, output, cache_read, cache_write; priced responses only) and `agent.model.responses`
(provider, model, outcome; `priced` on responded series only). Prometheus names them
`agent_model_*`. Each process is its own series (`service.instance.id`), and `increase()` misses a
series' first sample, so the counters of short CLI runs undercount there: the dashboards count from
the spans instead.

## Model request bodies

Every model client gets one HTTP client, `capturingHttp(FetchHttpClient.layer)`
(`agent-host/clients.ts`); the probes wrap theirs the same way. The provider clients' own changes
(the URL, the key, the API version) are made before it, so it sees the request as sent. When debug
lines are logged and a capture folder is set, each HTTP attempt (each retry, each fallback) writes
its bodies to `http-captures/<capture_id>.json` and logs one debug line,
`provider.http.payload_captured`, for each file, in the `agent.model.attempt` span:

- `request`: the body as sent, with `method` and `url` (without its query). No header is recorded,
  so no key or authorization header is. The request is sent while its body is captured.
- `response_events`: a streamed response, as a JSON array of its server-sent events as they arrived
  (each block with its blank line, so that the blocks joined are the received text), with `status`,
  `content_type`, `request_id` (the provider's) and `complete` (false when the stream failed or was
  cut before its end; a Chat Completions stream that ended with `[DONE]` is complete).
- `response`: a body read whole (a JSON answer, or a failed status's body), with `as: "text"` when
  it is not JSON and is kept as a JSON string.
- `response_message`: the message the adapter assembled from the response (the `ModelResponded`
  observation), once per attempt that responded.

Each line has `capture_id`, `body` (which of the four), `body_uri` (the file, `file://`), `size`,
`sha256` and `redacted`: the number of the environment's secret values replaced by `<redacted>`.
When it is not 0, the file is no longer exactly what was sent or received. A credential field's
value is not replaced, as it is in log lines, because a body's fields are the provider's (a tool's
schema can have a property named `password`). A file is written together with its line, so there is
no file without the line that points to it.

The capture folder is beside the session's log file: the log layer that names the file sets it
(`HttpCaptures`): `LogsToFile` (the CLI's REPL, zork), `LogsToStderr` (the CLI's `-p` runs: the
brand's logs folder), `LauncherLogs` (the ACP launcher's folder), `runTest` (the test's folder) and
`TelemetryToFiles` (beside the run's files). For labkit, that is
`~/.local/share/labkit/logs/http-captures/`. Capture files are not deleted: their disk use is shown
and alerted on instead (below).

To find the lines in Loki: `{service_name=~"labkit-.+"} | json | message="provider.http.payload_captured"`,
then `| body="request"` for one kind of body, or `| trace_id="<trace>"` for one trace.

## Log level

Every entry point reads `LABKIT_LOG_LEVEL` (the brand's prefix and `LOG_LEVEL`; one parser,
`agent-host/log-level.ts`): the names the CLI's `--log-level` takes (all, trace, debug, info, warn
or warning, error, fatal, none), in any case; info by default. The CLI's `--log-level` wins over it.
The ACP launcher reads `LABKIT_ACP_LOG_LEVEL` first, then `LABKIT_LOG_LEVEL`, and logs at debug
when neither is set. A value that names no level is passed over (to the next variable, else the
default) and reported once as a warning, `host_logs.level_invalid`, with the variable, the value and
the level used, where the run's log is read (zork and the spectator: each game session's log file).
The level is the program's `References.MinimumLogLevel`, so capture files are written exactly when
debug lines are logged.

## Grafana (`scripts/observability/`)

- `lgtm-stack.sh` runs the `grafana/otel-lgtm` container, with its data in `~/lgtm-data` and the
  capture folder mounted read-only. `tempo-config.yaml` (lgtm's own, mounted over it) keeps traces
  31 days and lets TraceQL search and metrics cover up to 31 days; lgtm's defaults are 14 days kept,
  7 days searched and 24 hours of metrics. Prometheus keeps 31 days. Loki has no retention limit.
- After the container is (re)built, run `bun run observability:datasources`,
  `bun run observability:alerts` and `bun run observability:dashboards`; each can run again without
  harm. They are anonymous calls, which lgtm's Grafana allows, or use
  `GRAFANA_SERVICE_ACCOUNT_TOKEN`; `GRAFANA_URL` is `http://localhost:3000` by default.
  - `datasources.ts`: Tempo's link from a span to its log lines selects them by `trace_id` and
    `span_id` under `{service_name=~"labkit-.+"}` (a process can send its spans and its lines under
    different service names), so "Logs for this span" on an attempt shows its capture lines; Loki's
    derived field turns a line's `capture_id` into a "Body" link to the capture server.
  - `alert-rules.ts` writes `alert-rules.json`: "labkit logs folder is larger than 1 GB", in the
    `labkit` folder, shown in Grafana's alert list only (no contact point).
  - `import-dashboard.ts` imports every `*-dashboard.json`, each replaced by its uid.
- `bun run observability:captures` (`capture-server.ts`) serves `GET /http-captures/<capture_id>.json`,
  read-only, from the capture folder, on 127.0.0.1 only; anything that is not a capture id is
  refused before a file is opened. A browser does not open a line's `file://` `body_uri` from
  Grafana's `http://` page; this server is how a body is opened. Its port has one owner,
  `config.ts` (3300). While it runs it reports, at start and every 60 seconds, the gauges
  `agent.logs.folder_bytes` and `agent.logs.folder_files` (`folder`: `logs` | `http-captures`, and
  `path`), which the disk-use tile and the alert read.

### Dashboards

Each has the tag `labkit`, a links bar to the others, the `Service` variable, and a default range of
7 days. Most panels count the spans with TraceQL metrics. Tempo's rules followed by their queries: a
range query sets `step` (10m), because without it Tempo leaves the current step empty; a sum or
average of an attribute filters `attr != nil`; a float attribute is compared with `0.0`; quantiles
are of `duration` only.

- **labkit agent** (`labkit-dashboard.json`): latency, tokens and tool runs by model and by tool;
  span durations; the size of the logs folder and of `http-captures/` with the time of the latest
  report ("No data" when none arrived in the range); the latest sessions and games with each
  session's totals, each row opening the session dashboard; warnings and errors.
- **labkit overview**, **models**, **providers**, **costs**, **projects**: omp's Overview, Models,
  Providers, Costs and Projects views, from the request spans' tokens, outcome, timing and cost
  (unpriced requests are counted, never shown as $0), and usage by working folder (`cwd`).
- **labkit requests**: totals and the request log (model, when, folder, tokens, cost, duration,
  TTFT, outcome, stop reason). A row opens its trace; in the trace, an `agent.model.attempt` span's
  "Logs for this span" lists its captured bodies, each with a "Body" link served by the capture
  server.
- **labkit errors**: failed requests and attempts by `error_signature`, error kind and model;
  failures over time; the list of failures; retries by reason, which only the
  `provider.request.retried` log lines record.
- **labkit tools**: calls, failures, error rate, distinct tools, argument and result characters,
  calls and failures over time, by tool, and by tool for each model. A tool span does not name the
  model: the by-model tables count the tool runs of turns in which that model answered.
- **labkit session** (`/d/labkit-session?var-trace=<trace id>`): one session or game: wall, model
  and tool time, turns, requests, tool calls, tokens, cost; the trace's waterfall; its requests and
  tools; its captured bodies and its log lines.

Not shown, from omp's dashboard: tokens and cost attributed to each tool (the tool span does not
name the request that asked for it); a session's idle time, lanes per agent, zoom and pan, and its
transcript (Grafana's trace view is a waterfall of spans; the text sent and received is in the
captured bodies); Gain (labkit's compaction is not automatic), Frustration (it needs a judge model
and is not wire-level) and subscription windows (labkit uses API keys).

## Reference

For whoever adds to it. Effect's published guides describe version 3; this repository uses version
4, whose source is in `repos/effect`.

- Metrics: <https://effect.website/docs/observability/metrics/>, `repos/effect/packages/effect/src/Metric.ts`
- Tracing (spans): <https://effect.website/docs/observability/tracing/>, `repos/effect/packages/effect/src/Tracer.ts`
- Logging: <https://effect.website/docs/observability/logging/>, `repos/effect/packages/effect/src/Logger.ts`
- OTLP: `repos/effect/packages/effect/src/observability/` (`Otlp.ts`, `OtlpTracer.ts`)
