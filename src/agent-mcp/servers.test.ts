/** The MCP servers one session keeps: started at once, their tools as sources, notices to the model, their changes as recorded. */

import { expect } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, Stream } from "effect";
import { runTest } from "../../tests/support/run.ts";
import { test } from "../../tests/support/test.ts";
import { startMcpServers } from "./servers.ts";

const fake = { name: "fake", command: process.execPath, args: [new URL("../../tests/support/mcp-server.ts", import.meta.url).pathname], env: {} };
const given = [
  { server: fake },
  { server: { name: "missing", command: "/no/such/server", args: [], env: {} } },
  // Nothing listens on port 1.
  { server: { name: "remote", transport: "http" as const, url: "http://localhost:1/mcp", headers: {} } },
];

test("MK1 MK2: every server is started at once, run or at its URL; the tools of those ready are sources; the model is told once of each server not running", async () => {
  const seen = await runTest(
    Effect.gen(function* () {
      const servers = yield* startMcpServers(given, []);
      const states = (yield* servers.states).map(({ name, state }) => [name, state._tag]);
      const first = yield* servers.notices.notices;
      const second = yield* servers.notices.notices;
      return { states, sources: servers.sources.map((source) => [source.namespace, source.tools.map((tool) => tool.name as string)]), first, second };
    }).pipe(Effect.provide(BunServices.layer)),
  );
  expect(seen.states).toEqual([
    ["fake", "Ready"],
    ["missing", "Failed"],
    ["remote", "Failed"],
  ]);
  expect(seen.sources).toEqual([["mcp__fake", ["echo", "roots", "slow"]]]);
  expect(seen.first).toHaveLength(2);
  expect(seen.first[0]).toStartWith("The MCP server missing is not running, so its tools cannot be called: it failed: its process could not be started:");
  expect(seen.first[1]).toStartWith("The MCP server remote is not running, so its tools cannot be called: it failed: the server could not be reached:");
  expect(seen.second).toEqual([]);
});

test("MK3: a server that stops is told of once, and once more when it is reconnected and runs again; its changes are recorded as McpServerChanged", async () => {
  const seen = await runTest(
    Effect.gen(function* () {
      const servers = yield* startMcpServers([{ server: { ...fake, env: { MCP_FAKE_EXIT: "1" } } }], []);
      const recorded = yield* servers.changes.pipe(Stream.take(1), Stream.runCollect);
      yield* servers.notices.notices;
      const source = servers.sources[0]!;
      yield* source.run("exit" as never, { mediaType: "application/json", body: { _tag: "Text", text: "{}" } } as never, "c1" as never).pipe(Effect.ignore);
      yield* Effect.sleep("300 millis");
      const stopped = yield* servers.notices.notices;
      const again = yield* servers.reconnect("fake");
      const back = yield* servers.notices.notices;
      return { recorded: [...recorded], stopped, again: again?._tag, back, unknown: yield* servers.reconnect("nobody") };
    }).pipe(Effect.provide(BunServices.layer)),
  );
  expect(seen.recorded as unknown).toEqual([
    { _tag: "McpServerChanged", server: "fake", state: { _tag: "Ready", tools: ["mcp__fake__echo", "mcp__fake__roots", "mcp__fake__slow", "mcp__fake__exit"] } },
  ]);
  expect(seen.stopped).toEqual(["The MCP server fake is not running, so its tools cannot be called: it stopped: its process exited with code 7."]);
  expect(seen.again).toBe("Ready");
  expect(seen.back).toEqual(["The MCP server fake is running again: its tools can be called."]);
  expect(seen.unknown).toBeUndefined();
});
