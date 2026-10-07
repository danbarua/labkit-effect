/**
 * Sets the links between lgtm's datasources that labkit's telemetry needs:
 * `bun run observability:datasources`.
 *
 * - Tempo's trace-to-logs link (`tracesToLogsV2`) selects a span's log lines by their `trace_id` and
 *   `span_id` (structured metadata on every line logged inside a span) under every service of the
 *   brand (`{service_name=~"labkit-.+"}`), not under the span's own service: a process can send its
 *   spans and its log lines under two service names (a test's spans under `labkit-tests`, zork's lines
 *   under `labkit-zork`). "Logs for this span" on a model attempt's span then shows that attempt's
 *   lines, its capture lines among them.
 * - Loki's derived field `capture_id` turns a capture line's `capture_id` (`provider.http.payload_captured`,
 *   `src/instrumentation/http-captures.ts`) into a link to the capture server (`config.ts`), which
 *   serves the body.
 *
 * lgtm provisions its datasources from files, and a new container sets them back; this script then
 * sets them again. It changes only these two settings, so running it again changes nothing. The
 * Grafana is `GRAFANA_URL` (default `http://localhost:3000`); `GRAFANA_SERVICE_ACCOUNT_TOKEN`, when
 * set, is sent as the bearer token, and the calls are otherwise anonymous, which lgtm's Grafana allows.
 * Exits 1 with Grafana's answer when a call fails.
 */

import { brandFrom } from "../../src/agent-host/brand.ts";
import { captureIdPattern, captureLinkTemplate } from "./config.ts";

const grafana = (process.env["GRAFANA_URL"] ?? "http://localhost:3000").replace(/\/$/, "");
const token = process.env["GRAFANA_SERVICE_ACCOUNT_TOKEN"];
const headers = { "Content-Type": "application/json", ...(token === undefined || token === "" ? {} : { Authorization: `Bearer ${token}` }) };

interface Datasource {
  readonly uid: string;
  readonly name: string;
  readonly jsonData?: Readonly<Record<string, unknown>>;
}

/** Calls Grafana's API, or exits 1 with its answer. */
const call = async (method: "GET" | "PUT", path: string, body?: unknown): Promise<unknown> => {
  const response = await fetch(`${grafana}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const answer = await response.text();
  if (!response.ok) {
    console.error(`ERROR: Grafana refused ${method} ${path}: HTTP ${response.status}: ${answer}`);
    console.error(response.status === 401 || response.status === 403 ? "HINT: Set GRAFANA_SERVICE_ACCOUNT_TOKEN to a token of an admin service account." : "HINT: Check that GRAFANA_URL is lgtm's Grafana.");
    process.exit(1);
  }
  return JSON.parse(answer);
};

/** Replaces `uid`'s settings by `jsonDataOf(its settings)`, keeping the rest of the datasource. */
const update = async (uid: string, jsonDataOf: (jsonData: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>) => {
  // The datasource as Grafana returns it is the body its update takes (`PUT /api/datasources/uid/:uid`).
  const datasource = (await call("GET", `/api/datasources/uid/${uid}`)) as Datasource;
  await call("PUT", `/api/datasources/uid/${uid}`, { ...datasource, jsonData: jsonDataOf(datasource.jsonData ?? {}) });
  console.log(`${datasource.name}: ${grafana}/connections/datasources/edit/${uid}`);
};

const services = `${brandFrom(process.env).name}-.+`;

await update("tempo", (jsonData) => ({
  ...jsonData,
  tracesToLogsV2: {
    datasourceUid: "loki",
    customQuery: true,
    query: `{service_name=~"${services}"} | trace_id = "\${__trace.traceId}" | span_id = "\${__span.spanId}"`,
    // The custom query selects by span itself; these say so for the settings page.
    filterByTraceID: true,
    filterBySpanID: true,
    tags: [],
    // A line logged as the span ends can carry a later timestamp than the span's end.
    spanStartTimeShift: "-1m",
    spanEndTimeShift: "1m",
  },
}));

const captureField = {
  name: "capture_id",
  matcherType: "regex",
  // A capture line's body is JSON, as `src/instrumentation/telemetry.ts` writes it.
  matcherRegex: `"capture_id"\\s*:\\s*"(${captureIdPattern})"`,
  url: captureLinkTemplate,
  urlDisplayLabel: "Body: ${__value.raw}",
  targetBlank: true,
};

await update("loki", (jsonData) => {
  const fields: ReadonlyArray<unknown> = Array.isArray(jsonData["derivedFields"]) ? jsonData["derivedFields"] : [];
  const others = fields.filter((field) => !(typeof field === "object" && field !== null && "name" in field && field.name === captureField.name));
  return { ...jsonData, derivedFields: [...others, captureField] };
});
