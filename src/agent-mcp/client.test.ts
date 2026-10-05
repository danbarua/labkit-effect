/** The MCP client, against a small server over stdio (`tests/support/mcp-server.ts`). */

import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Logger, Queue, Stream } from "effect";
import { type Wire, WireInput } from "effective-acp/json-rpc";
import { runTest } from "../../tests/support/run.ts";
import { test, testFolder } from "../../tests/support/test.ts";
import { type ClientInfo, connectOver, connectStdio, McpFailed, protocolVersion, type ToolResult } from "./client.ts";
import { logKeys } from "./log-keys.ts";

const fake = { name: "fake", command: process.execPath, args: [new URL("../../tests/support/mcp-server.ts", import.meta.url).pathname], env: {} };
const roots = [{ uri: "file:///work", name: "work" }];

/** Runs `use` with a connection to the test server; what it gives, and the server's log messages. */
const connected = <A, E>(use: (connection: Effect.Success<ReturnType<typeof connectStdio>>) => Effect.Effect<A, E>, clientInfo?: ClientInfo) => {
  const logged: Array<unknown> = [];
  const capture = Logger.make((options) => {
    logged.push(options.message);
  });
  return runTest(
    connectStdio(fake, roots, clientInfo).pipe(
      Effect.flatMap(use),
      Effect.provide(Layer.mergeAll(BunServices.layer, Logger.layer([capture], { mergeWithExisting: true }))),
    ),
  ).then((value) => ({ value, logged: logged.flat() }));
};

const textOf = (result: ToolResult) =>
  (Array.isArray(result["content"]) ? result["content"] : [])
    .flatMap((block) => (typeof block === "object" && block !== null && !Array.isArray(block) && typeof block["text"] === "string" ? [block["text"]] : []))
    .join("");

/** What the server logged, as text. */
const serverLogData = (logged: ReadonlyArray<unknown>) =>
  logged.filter((each): each is { data: string } => typeof each === "object" && each !== null && "data" in each).map((each) => each.data);

test("the client calls itself what its host says (clientInfo); when it says nothing, the default brand", async () => {
  // The server logs the clientInfo it was given once it is told initialization was done; a request after it waits for that line.
  const listed = (connection: Effect.Success<ReturnType<typeof connectStdio>>) => connection.tools;
  expect(serverLogData((await connected(listed, { name: "acme", version: "2.0.0" })).logged)).toContain("initialized by acme 2.0.0");
  expect(serverLogData((await connected(listed)).logged)).toContain("initialized by labkit 0.1.0");
});

test("initialize offers this client's version and the server's answer is kept; its tools are listed across pages; a call returns the tool's result", async () => {
  const { value, logged } = await connected((connection) =>
    Effect.gen(function* () {
      const tools = yield* connection.tools;
      const echoed = yield* connection.call("echo", { message: "hi" });
      return { server: connection.initialized.serverInfo.name, version: connection.initialized.protocolVersion, tools: tools.map((tool) => tool.name), echoed: textOf(echoed) };
    }),
  );
  expect(value).toEqual({ server: "fake", version: protocolVersion, tools: ["echo", "roots", "slow"], echoed: "hi" });
  // The server logged once it was told initialization was done.
  expect(logged).toContainEqual(logKeys.server.logged);
});

test("the server's own request during a call (roots/list) is answered with the roots the client was given", async () => {
  const { value } = await connected((connection) => Effect.map(connection.call("roots", {}), textOf));
  expect(JSON.parse(value)).toEqual({ roots: [{ uri: "file:///work", name: "work" }] });
});

test("a call interrupted is cancelled at the server (notifications/cancelled, with its request id)", async () => {
  const { logged } = await connected((connection) =>
    Effect.gen(function* () {
      yield* connection.call("slow", {}).pipe(Effect.timeout("200 millis"), Effect.ignore);
      // The server's log message saying it was told to cancel.
      yield* Effect.sleep("200 millis");
    }),
  );
  expect(serverLogData(logged).some((data) => /^cancelled \d+$/.test(data))).toBe(true);
});

test("a request the server answers with an error fails with McpFailed, naming the server and the request", async () => {
  const { value } = await connected((connection) => Effect.flip(connection.call("no_such_tool", {})));
  expect(value).toBeInstanceOf(McpFailed);
  expect(value.message).toBe("fake: tools/call no_such_tool failed");
});

test("connectStdio starts the server with this process's environment without its credential variables, plus the server's own env", async () => {
  process.env["LABKIT_MCP_TEST_TOKEN"] = "inherited";
  process.env["LABKIT_MCP_TEST_PLAIN"] = "plain";
  const file = join(testFolder(), "env.txt");
  // The shell writes the environment it was started with, then becomes the test server.
  const server = { ...fake, command: "/bin/sh", args: ["-c", `env > "${file}"; exec "$0" "$1"`, fake.command, ...fake.args], env: { SERVER_TOKEN: "given" } };
  await runTest(connectStdio(server, roots).pipe(Effect.flatMap((connection) => connection.tools), Effect.provide(BunServices.layer)));
  const names = readFileSync(file, "utf8").split("\n").map((line) => line.split("=")[0]);
  expect(names).toContain("LABKIT_MCP_TEST_PLAIN");
  expect(names).not.toContain("LABKIT_MCP_TEST_TOKEN");
  expect(readFileSync(file, "utf8")).toContain("SERVER_TOKEN=given");
});

/**
 * A server on an in-memory wire. It answers `initialize` and `tools/list`, keeps every message the
 * client writes (`written`), and passes the client's responses to `responses`. `send` delivers a
 * message from the server.
 */
const inMemoryServer = Effect.gen(function* () {
  const inbox = yield* Queue.unbounded<WireInput>();
  const responses = yield* Queue.unbounded<Record<string, unknown>>();
  const written: Array<Record<string, unknown>> = [];
  const reply = (id: unknown, result: unknown) => Queue.offer(inbox, WireInput.Json({ value: { jsonrpc: "2.0", id, result } }));
  const answer = (message: Record<string, unknown>) => {
    if (message["method"] === "initialize") return reply(message["id"], { protocolVersion, capabilities: {}, serverInfo: { name: "memory", version: "1.0.0" } });
    if (message["method"] === "tools/list") return reply(message["id"], { tools: [] });
    return message["method"] === undefined ? Queue.offer(responses, message) : Effect.void;
  };
  const wire: Wire = {
    read: Stream.fromQueue(inbox),
    write: (message) =>
      Effect.forEach(
        (Array.isArray(message) ? message : [message]) as ReadonlyArray<Record<string, unknown>>,
        (each) => Effect.sync(() => written.push(each)).pipe(Effect.andThen(answer(each))),
        { discard: true },
      ),
  };
  return { wire, written, responses, send: (value: unknown) => Queue.offer(inbox, WireInput.Json({ value })) };
});

test("a request with no params is written without a params field, not with params: null", async () => {
  const written = await runTest(
    Effect.gen(function* () {
      const server = yield* inMemoryServer;
      const connection = yield* connectOver("memory", server.wire, roots);
      yield* connection.tools;
      return server.written;
    }),
  );
  const listed = written.filter((message) => message["method"] === "tools/list" || message["method"] === "notifications/initialized");
  expect(listed).toHaveLength(2);
  for (const message of listed) expect(message).not.toHaveProperty("params");
});

test("the client answers a ping from the server with an empty result", async () => {
  const response = await runTest(
    Effect.gen(function* () {
      const server = yield* inMemoryServer;
      yield* connectOver("memory", server.wire, roots);
      yield* server.send({ jsonrpc: "2.0", id: "ping-1", method: "ping" });
      return yield* Queue.take(server.responses).pipe(Effect.timeout("5 seconds"));
    }),
  );
  expect(response).toEqual({ jsonrpc: "2.0", id: "ping-1", result: {} });
});
