/**
 * Writes labkit's Grafana alert rules (`alert-rules.json`) into a Grafana: `bun run observability:alerts`.
 *
 * The file holds one rule group and the folder it lives in. The script creates the folder when it is
 * missing, then replaces the group with the file's, through Grafana's provisioning API, so running it
 * again changes nothing, and a rule removed from the file is removed from Grafana.
 *
 * The rules raise alerts in Grafana's alert list only: the script adds no contact point and does not
 * change the notification policy. The rule "labkit logs folder is larger than 1 GB" reads
 * `agent_logs_folder_bytes`, which the capture server (`capture-server.ts`) reports while it runs;
 * when no report arrives, the rule keeps its last state.
 *
 * The Grafana is `GRAFANA_URL` (default `http://localhost:3000`); `GRAFANA_SERVICE_ACCOUNT_TOKEN`,
 * when set, is sent as the bearer token, and the calls are otherwise anonymous, which lgtm's Grafana
 * allows. Exits 1 with Grafana's answer when a call fails.
 */

interface AlertRules {
  readonly folder: { readonly uid: string; readonly title: string };
  readonly group: { readonly title: string; readonly interval: number; readonly rules: ReadonlyArray<Readonly<Record<string, unknown>>> };
}

const grafana = (process.env["GRAFANA_URL"] ?? "http://localhost:3000").replace(/\/$/, "");
const token = process.env["GRAFANA_SERVICE_ACCOUNT_TOKEN"];
const headers = { "Content-Type": "application/json", ...(token === undefined || token === "" ? {} : { Authorization: `Bearer ${token}` }) };
const { folder, group } = (await Bun.file(new URL("./alert-rules.json", import.meta.url)).json()) as AlertRules;

/** Calls Grafana's API: its answer, or `undefined` when the status is one of `absent`; otherwise exits 1 with the answer. */
const call = async (method: "GET" | "POST" | "PUT", path: string, body?: unknown, absent: ReadonlyArray<number> = []): Promise<unknown> => {
  const response = await fetch(`${grafana}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const answer = await response.text();
  if (absent.includes(response.status)) return undefined;
  if (!response.ok) {
    console.error(`ERROR: Grafana refused ${method} ${path}: HTTP ${response.status}: ${answer}`);
    console.error(response.status === 401 || response.status === 403 ? "HINT: Set GRAFANA_SERVICE_ACCOUNT_TOKEN to a token of an admin service account." : "HINT: Check that GRAFANA_URL is the Grafana to write the rules into.");
    process.exit(1);
  }
  return JSON.parse(answer);
};

if ((await call("GET", `/api/folders/${folder.uid}`, undefined, [404])) === undefined) await call("POST", "/api/folders", folder);

await call("PUT", `/api/v1/provisioning/folder/${folder.uid}/rule-groups/${encodeURIComponent(group.title)}`, {
  title: group.title,
  folderUid: folder.uid,
  interval: group.interval,
  rules: group.rules.map((rule) => ({ ...rule, folderUID: folder.uid, ruleGroup: group.title })),
});
for (const rule of group.rules) console.log(`${String(rule["title"])}: ${grafana}/alerting/grafana/${String(rule["uid"])}/view`);
