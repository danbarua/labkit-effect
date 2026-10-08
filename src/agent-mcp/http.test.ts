/** The MCP client over HTTP: Streamable HTTP and HTTP+SSE, against the test server (`tests/support/mcp-http-server.ts`). */

import { expect } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, Fiber, Layer, Logger, type Scope, Stream } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import type { SessionContext } from "../agent-environment/session-context.ts";
import { type FakeHttpOptions, type FakeHttpServer, startFakeHttpServer } from "../../tests/support/mcp-http-server.ts";
import { runTest } from "../../tests/support/run.ts";
import { test } from "../../tests/support/test.ts";
import type { ToolResult } from "./client.ts";
import { connectRemote, type McpServerRemote, rejectionOf } from "./http.ts";
import { logKeys } from "./log-keys.ts";
import type { McpServerState } from "./server-machine.ts";
import { type McpServer, startMcpServer } from "./server.ts";

const roots = [{ uri: "file:///work", name: "work" }];

const textOf = (result: ToolResult) =>
  (Array.isArray(result["content"]) ? result["content"] : [])
    .flatMap((block) => (typeof block === "object" && block !== null && !Array.isArray(block) && typeof block["text"] === "string" ? [block["text"]] : []))
    .join("");

/** The server `fake` serves, as a client is given it. */
const remoteOf = (fake: FakeHttpServer, transport: "http" | "sse", headers: Readonly<Record<string, string>> = {}): McpServerRemote => ({ name: "fake", transport, url: fake.url, headers });

/** Runs `use` with a fake server of `options`, and what was logged meanwhile: each record's message. */
const withFake = async <A, E>(
  options: FakeHttpOptions,
  use: (fake: FakeHttpServer, logged: ReadonlyArray<unknown>) => Effect.Effect<A, E, Scope.Scope | ChildProcessSpawner.ChildProcessSpawner | SessionContext>,
) => {
  const fake = startFakeHttpServer(options);
  const logged: Array<unknown> = [];
  const capture = Logger.make((log) => {
    logged.push(log.message);
  });
  try {
    const value = await runTest(use(fake, logged).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, Logger.layer([capture], { mergeWithExisting: true })))));
    return { value, logged: logged.flat(), fake };
  } finally {
    fake.stop();
  }
};

/** The data of the messages the server logged (`notifications/message`). */
const serverLogData = (logged: ReadonlyArray<unknown>) =>
  logged.flat().filter((each): each is { data: string } => typeof each === "object" && each !== null && "data" in each).map((each) => each.data);

/** Waits, within five seconds, until `done`: for what happens in the background (a stream's messages, a connection made anew). */
const until = (done: () => boolean) => Effect.sleep("20 millis").pipe(Effect.repeat({ until: done, times: 250 }));

interface Transport {
  readonly name: string;
  readonly options: FakeHttpOptions;
  readonly transport: "http" | "sse";
}

const transports: ReadonlyArray<Transport> = [
  { name: "Streamable HTTP, answered on streams", options: { transport: "http", respond: "sse" }, transport: "http" },
  { name: "Streamable HTTP, answered as JSON", options: { transport: "http", respond: "json" }, transport: "http" },
  { name: "HTTP+SSE", options: { transport: "sse" }, transport: "sse" },
];

test.each([...transports])("over $name, the client initializes, lists every page of tools, calls one, and a refused call fails naming the server", async ({ options, transport }: Transport) => {
  const { value, logged } = await withFake(options, (fake, logged) =>
    Effect.gen(function* () {
      const connection = yield* connectRemote(remoteOf(fake, transport), roots, { name: "acme", version: "2.0.0" });
      const tools = yield* connection.tools;
      const echoed = textOf(yield* connection.call("echo", { message: "hi" }));
      const unknown = yield* Effect.flip(connection.call("no_such_tool", {}));
      // The server's log line arrives on a stream of its own (the GET stream, or HTTP+SSE's).
      yield* until(() => serverLogData(logged).includes("initialized by acme 2.0.0"));
      return { server: connection.initialized.serverInfo.name, tools: tools.map((tool) => tool.name), echoed, unknown: unknown.message };
    }),
  );
  expect(value).toEqual({ server: "fake", tools: ["echo", "roots", "slow"], echoed: "hi", unknown: "fake: tools/call no_such_tool failed" });
  expect(serverLogData(logged)).toContain("initialized by acme 2.0.0");
  // A stream's priming event (an id, no data) is no message: nothing the client sent was refused.
  expect(logged).not.toContain(logKeys.http.refused);
});

// Answered as JSON, a call cannot carry the server's own request: those are over the transports that stream.
test.each(transports.filter((each) => each.options.respond !== "json"))(
  "over $name, the server's request during a call (roots/list) is answered, and a call interrupted is cancelled at the server",
  async ({ options, transport }: Transport) => {
    const { value, logged } = await withFake(options, (fake, logged) =>
      Effect.gen(function* () {
        const connection = yield* connectRemote(remoteOf(fake, transport), roots);
        const asked = JSON.parse(textOf(yield* connection.call("roots", {})));
        yield* connection.call("slow", {}).pipe(Effect.timeout("200 millis"), Effect.ignore);
        yield* until(() => serverLogData(logged).some((data) => data.startsWith("cancelled")));
        return asked;
      }),
    );
    expect(value).toEqual({ roots: [{ uri: "file:///work", name: "work" }] });
    expect(serverLogData(logged).some((data) => /^cancelled \d+$/.test(data))).toBe(true);
  },
);

test("Streamable HTTP: after initialize every message carries the session and the version agreed; the GET stream is opened with them; closing the scope ends the session", async () => {
  const { fake } = await withFake({ transport: "http" }, (fake) =>
    Effect.gen(function* () {
      const connection = yield* connectRemote(remoteOf(fake, "http"), roots);
      yield* connection.tools;
      yield* until(() => fake.requests.some((request) => request.method === "GET"));
    }),
  );
  const [initialize, ...after] = fake.requests;
  expect(initialize).toMatchObject({ method: "POST", carried: ["initialize"], session: null, version: null, accept: "application/json, text/event-stream" });
  const session = after[0]?.session ?? "";
  expect(session).toStartWith("session-");
  for (const request of after) expect(request).toMatchObject({ session, version: "2025-11-25" });
  expect(after.map((request) => [request.method, ...request.carried])).toEqual(
    expect.arrayContaining([["POST", "notifications/initialized"], ["GET"], ["POST", "tools/list"], ["DELETE"]]),
  );
  expect(after.find((request) => request.method === "GET")?.accept).toBe("text/event-stream");
  expect(fake.deleted).toEqual([session]);
});

test("Streamable HTTP: a server that offers no GET stream (405) is used without one, and says so", async () => {
  const { value, logged } = await withFake({ transport: "http", getStream: false }, (fake, logged) =>
    Effect.gen(function* () {
      const connection = yield* connectRemote(remoteOf(fake, "http"), roots);
      const echoed = textOf(yield* connection.call("echo", { message: "still" }));
      // The GET is made in the background once initialized: what its 405 logs is waited for.
      yield* until(() => logged.flat().includes(logKeys.http.noStream));
      return echoed;
    }),
  );
  expect(value).toBe("still");
  expect(logged).toContain(logKeys.http.noStream);
});

test("HTTP+SSE: messages are posted to the endpoint the stream's first event gives", async () => {
  const { fake } = await withFake({ transport: "sse" }, (fake) =>
    Effect.gen(function* () {
      const connection = yield* connectRemote(remoteOf(fake, "sse"), roots);
      yield* connection.call("echo", { message: "hi" });
    }),
  );
  expect(fake.requests[0]).toMatchObject({ method: "GET", path: "/sse", accept: "text/event-stream" });
  expect(fake.requests.slice(1).every((request) => request.method === "POST" && request.path === "/messages")).toBe(true);
});

test("a request the endpoint refuses fails with what HTTP said; a server not reached is status 0", async () => {
  const { value } = await withFake({ transport: "http", auth: { token: "right", oauth: true } }, (fake) =>
    Effect.gen(function* () {
      const refused = yield* Effect.flip(connectRemote(remoteOf(fake, "http"), roots));
      fake.stop();
      const unreached = yield* Effect.flip(connectRemote(remoteOf(fake, "http"), roots));
      return { refused: rejectionOf(refused), unreached: rejectionOf(unreached) };
    }),
  );
  expect(value.refused).toMatchObject({ status: 401, sessionExpired: false, text: "Unauthorized" });
  expect(value.refused?.authenticate).toContain("resource_metadata=");
  expect(value.unreached).toMatchObject({ status: 0, sessionExpired: false });
  expect(value.unreached?.text).toStartWith("the server could not be reached:");
});

/** The first state of `server` that `is` accepts, within five seconds. */
const firstStateWhere = (server: McpServer, is: (state: McpServerState) => boolean) =>
  server.changes.pipe(Stream.filter(is), Stream.runHead, Effect.timeout("5 seconds"), Effect.map((state) => (state._tag === "Some" ? state.value : undefined)));

test("a remote server that no longer has the session is given a new one, the call it refused is made again once, and the renewal is logged as a warning", async () => {
  const { value, logged, fake } = await withFake({ transport: "http" }, (fake) =>
    Effect.gen(function* () {
      const server = yield* startMcpServer(remoteOf(fake, "http"), roots);
      const ready = yield* server.settled;
      fake.expire();
      const echoed = textOf(yield* server.call("echo", { message: "after" }));
      return { ready: ready._tag, echoed, now: (yield* server.state)._tag };
    }),
  );
  expect(value).toEqual({ ready: "Ready", echoed: "after", now: "Ready" });
  expect(logged).toContain(logKeys.server.sessionRenewed);
  expect(fake.requests.filter((request) => request.carried.includes("initialize"))).toHaveLength(2);
});

test("a request whose response stream ends before its answer fails with that reason, and is not made again", async () => {
  const { value, fake } = await withFake({ transport: "http" }, (fake) =>
    Effect.gen(function* () {
      const connection = yield* connectRemote(remoteOf(fake, "http"), roots);
      const pending = yield* Effect.forkChild(Effect.flip(connection.call("slow", {})));
      yield* until(() => fake.requests.some((request) => request.carried.includes("tools/call")));
      fake.endRequestStreams();
      return yield* Fiber.join(pending);
    }),
  );
  expect(value.message).toBe("fake: tools/call slow failed");
  expect(value.cause).toMatchObject({ code: -32002, message: "The server's response ended before its answer" });
  expect(fake.requests.filter((request) => request.carried.includes("tools/call"))).toHaveLength(1);
});

test("an HTTP+SSE server whose stream ends between requests is connected anew; a call after it is answered", async () => {
  const { value, logged } = await withFake({ transport: "sse" }, (fake) =>
    Effect.gen(function* () {
      const server = yield* startMcpServer(remoteOf(fake, "sse"), roots);
      yield* server.settled;
      fake.dropStreams();
      // Connected anew: a second stream, and `initialize` on it.
      yield* until(() => fake.requests.filter((request) => request.carried.includes("initialize")).length === 2);
      return { echoed: textOf(yield* server.call("echo", { message: "again" })), now: (yield* server.state)._tag };
    }),
  );
  expect(value).toEqual({ echoed: "again", now: "Ready" });
  expect(logged).toContain(logKeys.server.connectionLost);
});

test("a server that asks for credentials when none are given needs authorization, with OAuth named when the server asks for it; a server that refuses the credentials given has failed; with the right credentials it is ready", async () => {
  const settle = (options: FakeHttpOptions, headers: Readonly<Record<string, string>>) =>
    withFake(options, (fake) => Effect.flatMap(startMcpServer(remoteOf(fake, "http", headers), roots), (server) => server.settled)).then(({ value }) => value);
  expect(await settle({ transport: "http", auth: { token: "right", oauth: true } }, {})).toEqual({
    _tag: "NeedsAuth",
    run: 1,
    reason: "the server asks for OAuth (HTTP 401), which this client does not do yet; a token can be given in its headers",
  });
  expect(await settle({ transport: "http", auth: { token: "right" } }, {})).toEqual({ _tag: "NeedsAuth", run: 1, reason: "the server asks for credentials (HTTP 401) and its headers give none" });
  expect(await settle({ transport: "http", auth: { token: "right" } }, { Authorization: "Bearer wrong" })).toEqual({
    _tag: "Failed",
    run: 1,
    reason: "the server refused the credentials given (HTTP 401: Unauthorized)",
  });
  expect((await settle({ transport: "http", auth: { token: "right" } }, { Authorization: "Bearer right" }))._tag).toBe("Ready");
});

test("a key revoked mid-session: the next call fails, and the server has failed with the reason that its credentials were refused", async () => {
  const { value } = await withFake({ transport: "http", auth: { token: "right" } }, (fake) =>
    Effect.gen(function* () {
      const server = yield* startMcpServer(remoteOf(fake, "http", { Authorization: "Bearer right" }), roots);
      const ready = (yield* server.settled)._tag;
      fake.setToken("rotated");
      const refused = yield* Effect.flip(server.call("echo", { message: "now" }));
      const failed = yield* firstStateWhere(server, (state) => state._tag === "Failed");
      return { ready, refused: refused.message, failed, running: yield* server.running };
    }),
  );
  expect(value.ready).toBe("Ready");
  expect(value.refused).toStartWith("fake: tools/call echo failed");
  expect(value.failed).toEqual({ _tag: "Failed", run: 1, reason: "the server refused the credentials given (HTTP 401: Unauthorized)" });
});

test("reconnecting a remote server ends its session and makes another, as a new run", async () => {
  const { value, fake } = await withFake({ transport: "http" }, (fake) =>
    Effect.gen(function* () {
      const server = yield* startMcpServer(remoteOf(fake, "http"), roots);
      yield* server.settled;
      yield* server.reconnect;
      const again = yield* firstStateWhere(server, (state) => state._tag === "Ready" && state.run === 2);
      return { again: again?.run, echoed: textOf(yield* server.call("echo", { message: "two" })) };
    }),
  );
  expect(value).toEqual({ again: 2, echoed: "two" });
  expect(fake.deleted).toHaveLength(2);
});

test("a server that refuses a key given under a credential header name (X-API-Key) has failed: the credentials given were refused", async () => {
  const { value } = await withFake({ transport: "http", auth: { token: "right" } }, (fake) =>
    Effect.flatMap(startMcpServer(remoteOf(fake, "http", { "X-API-Key": "wrong" }), roots), (server) => server.settled),
  );
  expect(value).toEqual({ _tag: "Failed", run: 1, reason: "the server refused the credentials given (HTTP 401: Unauthorized)" });
});

test("Streamable HTTP: the GET stream is opened again after it ends", async () => {
  const { value } = await withFake({ transport: "http" }, (fake) =>
    Effect.gen(function* () {
      const gets = () => fake.requests.filter((request) => request.method === "GET").length;
      yield* connectRemote(remoteOf(fake, "http"), roots);
      yield* until(() => gets() === 1);
      fake.dropStreams();
      yield* until(() => gets() === 2);
      return gets();
    }),
  );
  expect(value).toBe(2);
});

test("the headers a server is given are never logged, though a request the server refuses is", async () => {
  const { value, logged } = await withFake({ transport: "http", auth: { token: "right" } }, (fake) =>
    Effect.flatMap(startMcpServer(remoteOf(fake, "http", { Authorization: "Bearer header-secret-value" }), roots), (server) => server.settled),
  );
  expect(value._tag).toBe("Failed");
  expect(logged).toContain(logKeys.http.refused);
  expect(JSON.stringify(logged)).not.toContain("header-secret-value");
});
