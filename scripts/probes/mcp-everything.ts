/**
 * The MCP client (`src/agent-mcp`) against MCP's reference server,
 * `@modelcontextprotocol/server-everything` (a release pinned: `everything`), started with `bunx`: over stdio, or serving Streamable
 * HTTP (`http`, at `http://localhost:<port>/mcp`) or HTTP+SSE (`sse`, at `/sse`). It initializes,
 * lists the tools, calls `echo`, asks for the roots the client gave (`get-roots-list`, which makes
 * the server ask the client `roots/list`), and calls a tool that does not exist. What each step gave
 * is written to the run's folder (`logs/probes/mcp-everything/<run>/result.json`), and the client's
 * log to `log.jsonl` beside it. The probe runs in a session's context of its own (`mcp-everything`),
 * so the stdio server receives the default session environment: this process's environment without
 * its credential variables.
 *
 * Run: `bun scripts/probes/mcp-everything.ts [stdio|http|sse]` (stdio when not said).
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Logger, type Scope } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import type { SessionContext } from "../../src/agent-environment/session-context.ts";
import { logLevelOf, withLogLevel } from "../../src/agent-host/log-level.ts";
import { inSession, makeSessionContext } from "../../src/agent-host/session-context.ts";
import { SessionId } from "../../src/agent-machine/names.ts";
import { connectStdio, type McpConnection, type McpFailed } from "../../src/agent-mcp/client.ts";
import { connectRemote, type RemoteRefused } from "../../src/agent-mcp/http.ts";
import { OtlpSpansAndMetrics, otlpLogger } from "../../src/instrumentation/telemetry.ts";
import { runFolder } from "./run-folder.ts";

const transport = process.argv[2] ?? "stdio";
if (transport !== "stdio" && transport !== "http" && transport !== "sse") throw new Error(`Not a transport: ${transport}; those are stdio, http and sse`);
const folder = runFolder("mcp-everything", `${new Date().toISOString().replaceAll(":", "-")}-${transport}`);
const port = 3917;
/** The release run: 2026.8.31's `zod` cannot be found when it starts. */
const everything = "@modelcontextprotocol/server-everything@2026.8.18";
const log = Logger.make((options) => {
  appendFileSync(join(folder, "log.jsonl"), `${JSON.stringify({ level: options.logLevel, message: options.message })}\n`);
});

const step = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.timeout("30 seconds"),
    Effect.match({ onFailure: (error) => ({ failed: String(error) }), onSuccess: (value) => ({ gave: value }) }),
  );

const roots = [{ uri: `file://${process.cwd()}`, name: "labkit-effect" }];

/** The reference server serving `mode` on `port`, answering once it listens; it ends with the scope. */
const served = (mode: "streamableHttp" | "sse", path: string) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const child = Bun.spawn(["bunx", everything, mode], { env: { ...process.env, PORT: String(port) }, stdout: "ignore", stderr: "ignore" });
      for (let tries = 0; tries < 300; tries++) {
        const up = await fetch(`http://localhost:${port}${path}`, { method: "OPTIONS" }).then(
          () => true,
          () => false,
        );
        if (up) return child;
        await Bun.sleep(100);
      }
      child.kill();
      throw new Error(`server-everything did not listen on ${port} within 30 seconds`);
    }),
    (child) => Effect.sync(() => child.kill()),
  );

const connected: Effect.Effect<McpConnection, McpFailed | RemoteRefused, Scope.Scope | ChildProcessSpawner.ChildProcessSpawner | SessionContext> =
  transport === "stdio"
    ? connectStdio({ name: "everything", command: "bunx", args: [everything, "stdio"], env: {} }, roots)
    : Effect.andThen(served(transport === "http" ? "streamableHttp" : "sse", transport === "http" ? "/mcp" : "/sse"), () =>
        connectRemote({ name: "everything", transport, url: `http://localhost:${port}${transport === "http" ? "/mcp" : "/sse"}`, headers: {} }, roots),
      );

const program = Effect.gen(function* () {
  const connection = yield* connected;
  const tools = yield* step(Effect.map(connection.tools, (listed) => listed.map((tool) => tool.name)));
  const result = {
    transport,
    initialized: { protocolVersion: connection.initialized.protocolVersion, serverInfo: connection.initialized.serverInfo },
    tools,
    echo: yield* step(connection.call("echo", { message: "hi" })),
    roots: yield* step(connection.call("get-roots-list", {})),
    unknown: yield* step(connection.call("no_such_tool", {})),
  };
  writeFileSync(join(folder, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
});

const result = await Effect.runPromise(
  Effect.flatMap(makeSessionContext({ session: SessionId.make("mcp-everything"), working: process.cwd(), additional: [] }), (made) => inSession(made.context)(program)).pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(BunServices.layer, withLogLevel(logLevelOf(process.env), Logger.layer([log, otlpLogger("labkit-probe")])), OtlpSpansAndMetrics("labkit-probe"))),
  ),
);
console.log(JSON.stringify(result, null, 2));
console.log(`Written to ${folder}`);
process.exit(0);
