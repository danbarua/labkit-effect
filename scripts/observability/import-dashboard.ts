/**
 * Imports the labkit dashboard (`labkit-dashboard.json`) into a Grafana: `bun scripts/observability/import-dashboard.ts`.
 *
 * - The Grafana is `GRAFANA_URL`, `http://localhost:3000` when it is not set, such as the
 *   `grafana/otel-lgtm` container that `OTEL_EXPORTER_OTLP_ENDPOINT` sends to (`src/instrumentation`).
 * - `GRAFANA_SERVICE_ACCOUNT_TOKEN`, when it is set, is sent as the bearer token; without it, the
 *   import is anonymous, which lgtm's Grafana allows.
 * - A dashboard with the same uid (`labkit-agent`) is replaced. The script prints the dashboard's URL,
 *   and exits 1 with Grafana's answer when the import fails.
 *
 * The dashboard reads the metrics that the harness sends (`agent.model.time_to_first_token`,
 * `agent.model.tokens`, `agent.tool.runs`), Tempo's span metrics (`traces_spanmetrics_*`), Tempo's
 * traces and Loki's log lines, from lgtm's datasources (uids `prometheus`, `tempo`, `loki`).
 */

const grafana = (process.env["GRAFANA_URL"] ?? "http://localhost:3000").replace(/\/$/, "");
const token = process.env["GRAFANA_SERVICE_ACCOUNT_TOKEN"];
const dashboard = (await Bun.file(new URL("./labkit-dashboard.json", import.meta.url)).json()) as { readonly uid: string; readonly title: string };

const response = await fetch(`${grafana}/api/dashboards/db`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(token === undefined || token === "" ? {} : { Authorization: `Bearer ${token}` }) },
  body: JSON.stringify({ dashboard: { ...dashboard, id: null }, overwrite: true, message: "Imported by scripts/observability/import-dashboard.ts" }),
});
const answer = await response.text();
if (!response.ok) {
  console.error(`ERROR: Grafana did not import the dashboard: HTTP ${response.status}: ${answer}`);
  console.error(response.status === 401 || response.status === 403 ? "HINT: Set GRAFANA_SERVICE_ACCOUNT_TOKEN to a token of an editor or admin service account." : "HINT: Check that GRAFANA_URL is the Grafana to import into.");
  process.exit(1);
}
const { url } = JSON.parse(answer) as { readonly url: string };
console.log(`${dashboard.title}: ${grafana}${url}`);
