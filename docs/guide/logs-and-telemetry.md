# Logs and telemetry

labkit always writes a log file for each session. If you set one environment variable, it also
sends its traces, log lines and metrics to an OpenTelemetry collector, and Grafana shows them on
labkit's dashboards. How the instrumentation works is described in
[src/instrumentation/README.md](../../src/instrumentation/README.md).

## Log files

| What                                          | Where                                                                          |
|-----------------------------------------------|--------------------------------------------------------------------------------|
| A `labkit` conversation's log                 | `~/.local/share/labkit/logs/cli-<session>.log`                                 |
| A `labkit -p` run's log lines                 | stderr, so that stdout carries only the answer                                 |
| The ACP agent's log, one file per launch      | `~/.local/share/labkit/logs/`, or the folder `LABKIT_ACP_LOG_DIR` names        |
| The bodies of each model request and response | `~/.local/share/labkit/logs/http-captures/`, written only at the `debug` level |

`--data-dir` moves the whole `~/.local/share/labkit/` folder, logs included.

The level is set as follows:

| Program              | Setting                                         | Default |
|----------------------|-------------------------------------------------|---------|
| The `labkit` command | `--log-level`, else `LABKIT_LOG_LEVEL`          | `info`  |
| The ACP agent        | `LABKIT_ACP_LOG_LEVEL`, else `LABKIT_LOG_LEVEL` | `debug` |

The levels are `all`, `trace`, `debug`, `info`, `warn`, `error`, `fatal` and `none`.

`bun run acp:logs` prints the newest ACP launch's log. `bun run acp:logs --errors` prints only its
warnings and errors.

## Traces and dashboards in Grafana

1. Start a local collector and Grafana. The script runs the `grafana/otel-lgtm` container in Docker:

   ```sh
   scripts/observability/lgtm-stack.sh
   ```

2. The first time, and after the container is rebuilt, add labkit's data sources, alerts and
   dashboards. Each command can run again without harm:

   ```sh
   bun run observability:datasources
   bun run observability:alerts
   bun run observability:dashboards
   ```

3. Set `OTEL_EXPORTER_OTLP_ENDPOINT` to the collector's address, `http://localhost:4318`, in the
   environment of the program you run. A program sends telemetry only while the variable is set.

   ```sh
   export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318   # every program run from this shell
   labkit
   ```

    - To set it for one run only, put it before the command: `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 labkit`.
      There, `labkit` is the command that runs, not part of the variable's value.
    - The commands run in this checkout (`bun cli`, `bun test`, the scripts) also read the variable
      from the checkout's `.env`.
    - For the ACP agent, add the variable to the environment that the editor starts the agent with,
      in the editor's settings for the agent. labkit-web's dev stack passes its own environment to
      the agent it starts.

4. Open Grafana at <http://localhost:3000>. The dashboards have the tag `labkit`. They include an
   overview, models, providers, costs, requests, errors, tools and one session. Each request links to
   its trace.

5. To open a captured request or response body from Grafana's "Body" links, run the capture server:

   ```sh
   bun run observability:captures
   ```

   The bodies are captured only at the `debug` level.

## Service names

Each program sends its telemetry under a service name, which Grafana shows and filters by:

| Program                                           | Service name      |
|---------------------------------------------------|-------------------|
| The `labkit` command (`bun cli` in this checkout) | `labkit-cli`      |
| The ACP agent                                     | `labkit-acp`      |
| Zork and the Zork spectator                       | `labkit-zork`     |
| The tests (`bun test`)                            | `labkit-tests`    |
| The live probes in `scripts/probes/`              | `labkit-probe`    |
| The capture server                                | `labkit-captures` |

- The `labkit` in `labkit-cli` and `labkit-acp` is the brand that the program runs as. It is
  `labkit` unless a program that ships the agent gives another brand, or `LABKIT_BRAND` names one.
  The other names are fixed.
- `OTEL_SERVICE_NAME` replaces the name for every program run with it.
- Each dashboard's **Service** list offers the services whose names start with `labkit-`, and shows
  all of them by default. A program sent under another name, from another brand or another
  `OTEL_SERVICE_NAME`, is still recorded in the collector, but no dashboard shows it.
- The names cover this repository's programs only. labkit-web sends no telemetry of its own; the ACP
  agent it starts sends as `labkit-acp`.

The telemetry carries no API keys: secret values from the environment are redacted from log lines,
and request bodies are captured without their headers.
