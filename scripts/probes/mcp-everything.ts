/**
 * The MCP client (`src/agent-mcp/client.ts`) against MCP's reference server,
 * `@modelcontextprotocol/server-everything`, started with `bunx` over stdio: it initializes, lists
 * the tools, calls `echo`, asks for the roots the client gave (`get-roots-list`, which makes the
 * server ask the client `roots/list`), and calls a tool that does not exist. What each step gave is
 * written to the run's folder (`logs/probes/mcp-everything/<run>/result.json`), and the client's
 * log to `log.jsonl` beside it.
 *
 * Run: `bun scripts/probes/mcp-everything.ts`.
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Logger } from "effect";
import { connectStdio } from "../../src/agent-mcp/client.ts";
import { runFolder } from "./run-folder.ts";

const folder = runFolder("mcp-everything", new Date().toISOString().replaceAll(":", "-"));
const log = Logger.make((options) => {
  appendFileSync(join(folder, "log.jsonl"), `${JSON.stringify({ level: options.logLevel, message: options.message })}\n`);
});

const step = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.timeout("30 seconds"),
    Effect.match({ onFailure: (error) => ({ failed: String(error) }), onSuccess: (value) => ({ gave: value }) }),
  );

const program = Effect.gen(function* () {
  const connection = yield* connectStdio(
    { name: "everything", command: "bunx", args: ["@modelcontextprotocol/server-everything", "stdio"], env: {} },
    [{ uri: `file://${process.cwd()}`, name: "labkit-effect" }],
  );
  const tools = yield* step(Effect.map(connection.tools, (listed) => listed.map((tool) => tool.name)));
  const result = {
    initialized: { protocolVersion: connection.initialized.protocolVersion, serverInfo: connection.initialized.serverInfo },
    tools,
    echo: yield* step(connection.call("echo", { message: "hi" })),
    roots: yield* step(connection.call("get-roots-list", {})),
    unknown: yield* step(connection.call("no_such_tool", {})),
  };
  writeFileSync(join(folder, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
});

const result = await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(BunServices.layer, Logger.layer([log])))));
console.log(JSON.stringify(result, null, 2));
console.log(`Written to ${folder}`);
process.exit(0);
