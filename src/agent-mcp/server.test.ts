/** An MCP server a session keeps: its machine, and the test server run by it. */

import { expect } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, Stream } from "effect";
import { runTest } from "../../tests/support/run.ts";
import { test } from "../../tests/support/test.ts";
import type { ToolResult } from "./client.ts";
import { initialMcpServerState, type McpServerState, stepMcpServer } from "./server-machine.ts";
import { type McpServer, startMcpServer } from "./server.ts";

const fake = { name: "fake", command: process.execPath, args: [new URL("../../tests/support/mcp-server.ts", import.meta.url).pathname], env: {} };

test("MS1: a server connects on each run of its process, is ready with its tools, fails or exits with its run; what arrives about an earlier run changes nothing", () => {
  const steps = (events: Parameters<typeof stepMcpServer>[1][]) => events.reduce((state, event) => stepMcpServer(state, event).state, initialMcpServerState);
  const tools = [{ name: "echo" }] as never;
  expect(steps([{ _tag: "Process", state: { _tag: "Starting", run: 1 } }])).toEqual({ _tag: "Connecting", run: 1 });
  expect(steps([{ _tag: "Process", state: { _tag: "Starting", run: 1 } }, { _tag: "Connected", run: 1, tools }])).toEqual({ _tag: "Ready", run: 1, tools });
  // A server that does not connect has failed, and its process is to be stopped.
  expect(stepMcpServer({ _tag: "Connecting", run: 1 }, { _tag: "ConnectFailed", run: 1, reason: "no answer" })).toEqual({
    state: { _tag: "Failed", run: 1, reason: "no answer" },
    effects: [{ _tag: "StopProcess" }],
  });
  // Stopping its process then leaves it Failed.
  expect(stepMcpServer({ _tag: "Failed", run: 1, reason: "no answer" }, { _tag: "Process", state: { _tag: "Idle", run: 1 } }).state._tag).toBe("Failed");
  expect(stepMcpServer({ _tag: "Ready", run: 1, tools }, { _tag: "Process", state: { _tag: "Exited", run: 1, code: 7, signal: undefined } }).state).toEqual({
    _tag: "Exited",
    run: 1,
    reason: "its process exited with code 7",
  });
  // Run 1's end, reported once run 2 is connecting, changes nothing.
  expect(stepMcpServer({ _tag: "Connecting", run: 2 }, { _tag: "Process", state: { _tag: "Exited", run: 1, code: 143, signal: undefined } }).state).toEqual({ _tag: "Connecting", run: 2 });
});

const textOf = (result: ToolResult) =>
  (Array.isArray(result["content"]) ? result["content"] : [])
    .flatMap((block) => (typeof block === "object" && block !== null && !Array.isArray(block) && typeof block["text"] === "string" ? [block["text"]] : []))
    .join("");

/** The first state of `server` that `is` accepts, within ten seconds. */
const until = (server: McpServer, is: (state: McpServerState) => boolean) =>
  server.changes.pipe(Stream.filter(is), Stream.runHead, Effect.timeout("10 seconds"), Effect.map((state) => (state._tag === "Some" ? state.value : undefined)));

test("MS2 MS4: a server that connects is ready with its tools and answers calls; one whose process ends has exited, and calls fail saying so, until it is reconnected", async () => {
  const seen = await runTest(
    Effect.gen(function* () {
      const server = yield* startMcpServer(fake, []);
      const ready = yield* server.settled;
      const echoed = textOf(yield* server.call("echo", { message: "hi" }));
      yield* server.call("exit", {}).pipe(Effect.ignore);
      const exited = yield* until(server, (state) => state._tag === "Exited");
      const refused = yield* Effect.flip(server.call("echo", { message: "again" }));
      yield* server.reconnect;
      const again = yield* until(server, (state) => state._tag === "Ready" && state.run === 2);
      return {
        ready: ready._tag === "Ready" ? ready.tools.map((tool) => tool.name) : ready,
        echoed,
        exited,
        refused: refused.message,
        again: again?.run,
        echoedAgain: textOf(yield* server.call("echo", { message: "back" })),
      };
    }).pipe(Effect.provide(BunServices.layer)),
  );
  expect(seen).toEqual({
    ready: ["echo", "roots", "slow"],
    echoed: "hi",
    exited: { _tag: "Exited", run: 1, reason: "its process exited with code 7" },
    refused: "fake: echo was not called: the server is not running (it stopped: its process exited with code 7)",
    again: 2,
    echoedAgain: "back",
  });
});

test("MS3: a server whose process cannot be started has failed, and a call to it fails saying why", async () => {
  const seen = await runTest(
    Effect.gen(function* () {
      const server = yield* startMcpServer({ name: "missing", command: "/no/such/server", args: [], env: {} }, []);
      const settled = yield* server.settled;
      const refused = yield* Effect.flip(server.call("echo", {}));
      return { settled: settled._tag, refused: refused.message };
    }).pipe(Effect.provide(BunServices.layer)),
  );
  expect(seen.settled).toBe("Failed");
  expect(seen.refused).toStartWith("missing: echo was not called: the server is not running (it failed: its process could not be started:");
});

test("MS5: a server that does not answer initialize, or does not list its tools, in time has failed, and its process is stopped", async () => {
  const settle = (server: Parameters<typeof startMcpServer>[0]) =>
    Effect.gen(function* () {
      const started = yield* startMcpServer(server, [], { connectTimeout: "300 millis" });
      const settled = yield* started.settled;
      // Its process group was stopped (agent-process PG4: a stopped group's processes are ended).
      yield* Effect.sleep("50 millis");
      return { settled, process: (yield* started.process)._tag };
    });
  const seen = await runTest(
    Effect.gen(function* () {
      return {
        silent: yield* settle({ name: "silent", command: "/bin/sh", args: ["-c", "sleep 30"], env: {} }),
        unlisted: yield* settle({ ...fake, name: "unlisted", env: { MCP_FAKE_NO_LIST: "1" } }),
      };
    }).pipe(Effect.provide(BunServices.layer)),
  );
  const failed = { _tag: "Failed", run: 1, reason: "did not answer initialize and tools/list within 300ms" };
  expect(seen as unknown).toEqual({ silent: { settled: failed, process: "Idle" }, unlisted: { settled: failed, process: "Idle" } });
});
