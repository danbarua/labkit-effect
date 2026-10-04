/**
 * End to end, live: the CLI, as a process, asks a real model to call a tool of an MCP server named in
 * `--mcp-config` (`tests/support/mcp-server.ts`), and the run's facts are checked: the server was
 * ready and recorded so, the model called `mcp__fake__echo`, its result was recorded as the server
 * sent it, and the answer says what the tool returned. The model is the local server's unless one is
 * named (`--model provider/model`, its key in the environment). The run's folder is
 * `logs/e2e/cli-mcp/<run>/`: the CLI runs there, with it as its home, so no configuration of the
 * user's is read, and its session's facts and log are kept there. Exits 1 when a check fails.
 *
 * Run: `bun scripts/e2e/cli-mcp.ts [--model <provider/model>]`.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const at = process.argv.indexOf("--model");
const model = at === -1 ? "localhost/mlx-community/Qwen3.5-9B-8bit" : process.argv[at + 1];
const root = resolve(import.meta.dir, "../..");
const run = join(root, "logs/e2e/cli-mcp", new Date().toISOString().replaceAll(":", "-"));
mkdirSync(run, { recursive: true });

const servers = { mcpServers: { fake: { command: process.execPath, args: [join(root, "tests/support/mcp-server.ts")] } } };
const prompt = "Call the tool mcp__fake__echo with the message 'labkit says hi', then tell me exactly what it returned.";
const child = Bun.spawn(
  [process.execPath, join(root, "src/examples/cli-repl/index.ts"), "-p", prompt, "--model", model ?? "", "--permission-mode", "bypassPermissions", "--max-turns", "4", "--mcp-config", JSON.stringify(servers), "--output-format", "json"],
  { cwd: run, stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: run, NO_COLOR: "1", FORCE_COLOR: "0" } },
);
const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
writeFileSync(join(run, "stdout.txt"), stdout);
writeFileSync(join(run, "stderr.txt"), stderr);

const json = stdout.slice(stdout.indexOf("{"), stdout.lastIndexOf("}") + 1);
const result = (() => {
  try {
    return JSON.parse(json) as { readonly result?: string; readonly session_id?: string; readonly subtype?: string };
  } catch {
    return {};
  }
})();
const sessions = join(run, "logs/cli");
const session = result.session_id ?? readdirSync(sessions).at(0) ?? "";
const facts = readFileSync(join(sessions, session, "facts.jsonl"), "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line) as { readonly _tag: string; readonly observation?: Record<string, unknown> & { readonly _tag: string } });
const observed = facts.flatMap((fact) => (fact.observation === undefined ? [] : [fact.observation]));
const called = observed.find((each) => each._tag === "ToolCallArrived" && each["tool"] === "mcp__fake__echo");
const ended = observed.find((each) => each._tag === "ToolEnded" && each["call"] === called?.["call"]) as { readonly outcome?: { readonly _tag: string; readonly output?: { readonly mediaType: string; readonly body: { readonly text: string } } } } | undefined;

const checks: ReadonlyArray<readonly [string, boolean]> = [
  ["the CLI exited 0", code === 0],
  ["the server was recorded ready, with its tools", observed.some((each) => each._tag === "McpServerChanged" && (each["state"] as { readonly _tag: string })._tag === "Ready")],
  ["the model called mcp__fake__echo", called !== undefined],
  ["its result was recorded as the server sent it", ended?.outcome?._tag === "Succeeded" && ended.outcome.output?.mediaType === "application/vnd.modelcontextprotocol.call-tool-result+json" && ended.outcome.output.body.text.includes("labkit says hi")],
  ["the answer says what the tool returned", result.subtype === "Completed" && (result.result ?? "").includes("labkit says hi")],
];
for (const [check, passed] of checks) console.log(`${passed ? "pass" : "FAIL"}  ${check}`);
console.log(`model ${model}; written to ${run}`);
process.exit(checks.every(([, passed]) => passed) ? 0 : 1);
