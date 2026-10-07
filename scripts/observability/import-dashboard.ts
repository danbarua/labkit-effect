/**
 * Imports every labkit dashboard (each `*-dashboard.json` in this folder) into a Grafana:
 * `bun run observability:dashboards`.
 *
 * - The Grafana is `GRAFANA_URL`, `http://localhost:3000` when it is not set, such as the
 *   `grafana/otel-lgtm` container that `OTEL_EXPORTER_OTLP_ENDPOINT` sends to (`src/instrumentation`).
 * - `GRAFANA_SERVICE_ACCOUNT_TOKEN`, when it is set, is sent as the bearer token; without it, the
 *   import is anonymous, which lgtm's Grafana allows.
 * - A dashboard with the same uid (`labkit-agent` for `labkit-dashboard.json`) is replaced. The script
 *   prints each dashboard's URL, in the files' order by name, and exits 1 with Grafana's answer at the
 *   first import that fails.
 *
 * The dashboards read the metrics that the harness and the capture server send (`agent.*`), Tempo's
 * span metrics (`traces_spanmetrics_*`), Tempo's traces and Loki's log lines, from lgtm's datasources
 * (uids `prometheus`, `tempo`, `loki`).
 */

const grafana = (process.env["GRAFANA_URL"] ?? "http://localhost:3000").replace(/\/$/, "");
const token = process.env["GRAFANA_SERVICE_ACCOUNT_TOKEN"];
const files = (await Array.fromAsync(new Bun.Glob("*-dashboard.json").scan({ cwd: import.meta.dir }))).sort();

for (const file of files) {
  const dashboard = (await Bun.file(`${import.meta.dir}/${file}`).json()) as { readonly uid: string; readonly title: string };
  const response = await fetch(`${grafana}/api/dashboards/db`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token === undefined || token === "" ? {} : { Authorization: `Bearer ${token}` }) },
    body: JSON.stringify({ dashboard: { ...dashboard, id: null }, overwrite: true, message: "Imported by scripts/observability/import-dashboard.ts" }),
  });
  const answer = await response.text();
  if (!response.ok) {
    console.error(`ERROR: Grafana did not import ${file}: HTTP ${response.status}: ${answer}`);
    console.error(response.status === 401 || response.status === 403 ? "HINT: Set GRAFANA_SERVICE_ACCOUNT_TOKEN to a token of an editor or admin service account." : "HINT: Check that GRAFANA_URL is the Grafana to import into.");
    process.exit(1);
  }
  const { url } = JSON.parse(answer) as { readonly url: string };
  console.log(`${dashboard.title}: ${grafana}${url}`);
}
