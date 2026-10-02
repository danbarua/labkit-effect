/**
 * ACP's Streamable HTTP transport, at the wire level, against `@agentclientprotocol/sdk` 1.5.0:
 * `serve` driven by the SDK's `createHttpStream` client and by raw `fetch`, and `connect` against
 * the SDK's `AcpServer` and against `serve`. The agents and clients here read and write raw
 * JSON-RPC on the wire.
 */

import { describe, expect, test } from "bun:test";
import http from "node:http";
import * as acp from "@agentclientprotocol/sdk";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import { createNodeHttpHandler } from "@agentclientprotocol/sdk/experimental/node";
import { AcpServer, type HandleRequestOptions } from "@agentclientprotocol/sdk/experimental/server";
import { Deferred, type Duration, Effect, Fiber, Queue, type Scope, Stream } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpClient from "effect/http/HttpClient";
import * as HttpRouter from "effect/http/HttpRouter";
import { connect, serve } from "./http.ts";
import type { JsonRpcMessage, Wire, WireError } from "./json-rpc.ts";

/** A JSON-RPC message as these tests read it. */
interface Message {
  readonly jsonrpc: "2.0";
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: {
    readonly sessionId?: string;
    readonly prompt?: ReadonlyArray<{ readonly text?: string }>;
    readonly update?: { readonly content?: { readonly text?: string } };
    readonly toolCall?: { readonly toolCallId?: string };
  };
  readonly result?: {
    readonly sessionId?: string;
    readonly stopReason?: string;
    readonly protocolVersion?: number;
    readonly outcome?: { readonly optionId?: string };
  };
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

const initialize = { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } } as const;

const updateParams = (sessionId: string, text: string): acp.SessionNotification => ({
  sessionId,
  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
});

const textUpdate = (sessionId: string, text: string): JsonRpcMessage => ({
  jsonrpc: "2.0",
  method: "session/update",
  params: updateParams(sessionId, text),
});

const permissionParams = (sessionId: string): acp.RequestPermissionRequest => ({
  sessionId,
  toolCall: { toolCallId: "permission-tool", title: "Permission tool" },
  options: [{ kind: "allow_once", name: "Allow once", optionId: "allow" }],
});

// The agent behind `serve`: raw JSON-RPC on the wire.

interface Probe {
  /** The agent's wire's `read` ended. */
  readonly wireEnded: Deferred.Deferred<void>;
  /** `onConnection`'s scope closed. */
  readonly scopeClosed: Deferred.Deferred<void>;
  /** The agent wrote its response to a prompt. */
  readonly prompted: Deferred.Deferred<void>;
}

const makeProbe = (): Probe => ({
  wireEnded: Deferred.makeUnsafe(),
  scopeClosed: Deferred.makeUnsafe(),
  prompted: Deferred.makeUnsafe(),
});

/**
 * Answers `initialize`, `session/new` and `session/load` (one update, "replayed", for the session,
 * then `{}`). A prompt with text T sends updates T-1, T-2 and T-3, yielding between them; when T is
 * "permission" it then asks the client for permission and sends "permission-<optionId>". Then it
 * answers `end_turn`.
 */
const wireAgent =
  (probe: Probe) =>
  (wire: Wire): Effect.Effect<void, never, Scope.Scope> =>
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Deferred.succeed(probe.scopeClosed, undefined));
      const replies = new Map<string | number | null | undefined, Deferred.Deferred<Message>>();
      let nextId = 0;
      const send = (message: JsonRpcMessage) => Effect.orDie(wire.write(message));
      const answer = (id: string | number, result: unknown) => send({ jsonrpc: "2.0", id, result });
      const ask = (method: string, params: unknown) =>
        Effect.gen(function* () {
          const id = `agent-${nextId++}`;
          const reply = Deferred.makeUnsafe<Message>();
          replies.set(id, reply);
          yield* send({ jsonrpc: "2.0", id, method, params });
          return yield* Deferred.await(reply);
        });
      const serveRequest = (id: string | number, message: Message): Effect.Effect<void> =>
        Effect.gen(function* () {
          const sessionId = message.params?.sessionId ?? "";
          switch (message.method) {
            case "initialize":
              return yield* answer(id, { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] });
            case "session/new":
              return yield* answer(id, { sessionId: globalThis.crypto.randomUUID() });
            case "session/load":
              yield* send(textUpdate(sessionId, "replayed"));
              return yield* answer(id, {});
            case "session/prompt": {
              const text = message.params?.prompt?.[0]?.text ?? "";
              for (const index of [1, 2, 3]) {
                yield* send(textUpdate(sessionId, `${text}-${index}`));
                // Lets a prompt running at the same time write between these updates.
                yield* Effect.yieldNow;
              }
              if (text === "permission") {
                const reply = yield* ask("session/request_permission", permissionParams(sessionId));
                yield* send(textUpdate(sessionId, `permission-${reply.result?.outcome?.optionId}`));
              }
              yield* answer(id, { stopReason: "end_turn" });
              yield* Deferred.succeed(probe.prompted, undefined);
              return;
            }
            default:
              return yield* send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
          }
        });
      yield* wire.read.pipe(
        Stream.runForEach((input) => {
          if (input._tag !== "Json") return Effect.void;
          const message = input.value as Message;
          if (message.method === undefined) {
            const reply = replies.get(message.id);
            return reply === undefined ? Effect.void : Deferred.succeed(reply, message);
          }
          if (message.id === undefined || message.id === null) return Effect.void;
          return Effect.asVoid(Effect.forkScoped(serveRequest(message.id, message)));
        }),
        Effect.ignore,
      );
      yield* Deferred.succeed(probe.wireEnded, undefined);
    });

const settled = (deferred: Deferred.Deferred<void>): Promise<void> =>
  Effect.runPromise(Deferred.await(deferred).pipe(Effect.timeout("3 seconds")));

/**
 * Answers `initialize`, then sends the notification `late`, which names no session, once `trigger`
 * completes. It returns only when the connection ends.
 */
const quietAgent =
  (trigger: Deferred.Deferred<void>) =>
  (wire: Wire): Effect.Effect<void, never, Scope.Scope> =>
    Effect.gen(function* () {
      yield* wire.read.pipe(
        Stream.runForEach((input) =>
          input._tag === "Json" && (input.value as Message).method === "initialize"
            ? wire.write({ jsonrpc: "2.0", id: 0, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } })
            : Effect.void,
        ),
        Effect.ignore,
        Effect.forkScoped,
      );
      yield* Deferred.await(trigger);
      yield* Effect.ignore(wire.write({ jsonrpc: "2.0", method: "late" }));
      return yield* Effect.never;
    });

/** `serve` on `Bun.serve`, port 0. `idleTimeout` is `Bun.serve`'s, in seconds. */
const hostServe = (
  onConnection: (wire: Wire, connection: { readonly id: string }) => Effect.Effect<void, never, Scope.Scope>,
  options: { readonly keepAliveInterval?: Duration.Input; readonly idleTimeout?: number } = {},
) => {
  const web = HttpRouter.toWebHandler(serve({ onConnection, keepAliveInterval: options.keepAliveInterval }), { disableLogger: true });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    ...(options.idleTimeout === undefined ? {} : { idleTimeout: options.idleTimeout }),
    fetch: (request) => web.handler(request),
  });
  return {
    url: `http://127.0.0.1:${server.port}/acp`,
    stop: async () => {
      await web.dispose();
      await server.stop(true);
    },
  };
};

// The SDK's agent behind its `AcpServer`, the same behaviour as `wireAgent`.

const sdkAgent = () =>
  acp
    .agent({ name: "ah-sdk-agent" })
    .onRequest("initialize", () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] }))
    .onRequest("session/new", () => ({ sessionId: globalThis.crypto.randomUUID() }))
    .onRequest("session/load", async (c) => {
      await c.client.notify("session/update", updateParams(c.params.sessionId, "replayed"));
      return {};
    })
    .onRequest("session/prompt", async (c) => {
      const first = c.params.prompt[0];
      const text = first?.type === "text" ? first.text : "";
      for (const index of [1, 2, 3]) {
        await c.client.notify("session/update", updateParams(c.params.sessionId, `${text}-${index}`));
      }
      if (text === "permission") {
        const permission = await c.client.request("session/request_permission", permissionParams(c.params.sessionId));
        const optionId = permission.outcome.outcome === "selected" ? permission.outcome.optionId : "cancelled";
        await c.client.notify("session/update", updateParams(c.params.sessionId, `permission-${optionId}`));
      }
      return { stopReason: "end_turn" as const };
    })
    .onNotification("session/cancel", () => undefined);

interface Recorded {
  readonly method: string;
  readonly rpc: string | undefined;
  readonly connectionId: string | null;
  readonly sessionId: string | null;
  readonly cookie: string | null;
  readonly authorization: string | null;
  readonly status: number;
}

/**
 * The SDK's `AcpServer`, recording every request. Its answer to `initialize` sets the cookie
 * `affinity=backend-1`.
 */
class RecordingServer extends AcpServer {
  readonly requests: Recorded[] = [];
  readonly connectionIds: string[] = [];

  override async handleRequest(request: Request, options?: HandleRequestOptions): Promise<Response> {
    const body = request.method === "POST" ? ((await request.clone().json().catch(() => undefined)) as Message | undefined) : undefined;
    const answered = await super.handleRequest(request, options);
    const response = new Response(answered.body, answered);
    const connectionId = answered.headers.get("acp-connection-id");
    if (connectionId !== null) {
      this.connectionIds.push(connectionId);
      response.headers.append("set-cookie", "affinity=backend-1; Path=/");
    }
    this.requests.push({
      method: request.method,
      rpc: body?.method ?? (body?.result !== undefined ? "response" : undefined),
      connectionId: request.headers.get("acp-connection-id"),
      sessionId: request.headers.get("acp-session-id"),
      cookie: request.headers.get("cookie"),
      authorization: request.headers.get("authorization"),
      status: answered.status,
    });
    return response;
  }
}

/**
 * The SDK's server as its own tests host it: `node:http` through its node adapter. Under
 * `Bun.serve` its event streams send no headers until their first event.
 */
const hostSdk = async () => {
  const acpServer = new RecordingServer({ createAgent: sdkAgent });
  const server = http.createServer(createNodeHttpHandler(acpServer));
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  return {
    url: `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}/acp`,
    requests: acpServer.requests,
    connectionIds: acpServer.connectionIds,
    stop: async () => {
      await acpServer.close();
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    },
  };
};

// Raw HTTP.

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

const connectionOf = async (url: string): Promise<string> => {
  const response = await post(url, initialize);
  expect(response.status).toBe(200);
  return response.headers.get("acp-connection-id") ?? "";
};

interface EventReader {
  /** The next message; `undefined` once the stream has ended. */
  readonly next: () => Promise<Message | undefined>;
  readonly cancel: () => Promise<void>;
}

/** Opens one event stream with a GET. */
const events = async (url: string, connectionId: string, sessionId?: string): Promise<EventReader> => {
  const response = await fetch(url, {
    headers: {
      accept: "text/event-stream",
      "acp-connection-id": connectionId,
      ...(sessionId === undefined ? {} : { "acp-session-id": sessionId }),
    },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const reader = (response.body ?? new ReadableStream<Uint8Array>()).pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  const next = async (): Promise<Message | undefined> => {
    for (;;) {
      const end = buffer.indexOf("\n\n");
      if (end >= 0) {
        const data = buffer
          .slice(0, end)
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        buffer = buffer.slice(end + 2);
        if (data !== "") return JSON.parse(data) as Message;
        continue;
      }
      const chunk = await reader.read();
      if (chunk.done) return undefined;
      buffer += chunk.value;
    }
  };
  return { next, cancel: () => reader.cancel() };
};

const updateText = (message: Message | undefined) => `${message?.params?.sessionId}:${message?.params?.update?.content?.text}`;

// `connect`, driven from its wire.

const runClient = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient | Scope.Scope>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)));

/**
 * A client on `wire`. `until(id, update?)` answers permission requests "allow" and records updates
 * until the response to `id` has arrived and, when given, the update `update`: the two may arrive
 * on different streams, in either order.
 */
const wireClient = (wire: Wire) =>
  Effect.gen(function* () {
    const inbox = yield* Queue.unbounded<Message>();
    const readEnded = yield* wire.read.pipe(
      Stream.runForEach((input) => (input._tag === "Json" ? Queue.offer(inbox, input.value as Message) : Effect.void)),
      Effect.forkScoped,
    );
    const updates: string[] = [];
    const permissionRequests: string[] = [];
    const until = (id: number, update?: string): Effect.Effect<Message> =>
      Effect.gen(function* () {
        let answered: Message | undefined;
        while (answered === undefined || (update !== undefined && !updates.includes(update))) {
          const message = yield* Queue.take(inbox).pipe(Effect.timeout("5 seconds"));
          if (message.method === "session/request_permission" && message.id !== undefined && message.id !== null) {
            permissionRequests.push(`${message.params?.sessionId}:${message.params?.toolCall?.toolCallId}`);
            yield* wire.write({ jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "selected", optionId: "allow" } } });
          } else if (message.method === "session/update") {
            updates.push(updateText(message));
          } else if (message.id === id) {
            answered = message;
          }
        }
        return answered;
      }).pipe(Effect.orDie);
    return { until, updates, permissionRequests, readEnded };
  });

interface Exchanged {
  readonly initialized: Message;
  readonly sessionId: string;
  readonly prompted: Message;
  readonly loaded: Message;
  readonly updates: ReadonlyArray<string>;
  readonly permissionRequests: ReadonlyArray<string>;
}

/** initialize, session/new, a prompt with a permission request, then session/load of a session this client never saw. */
const exchange = (wire: Wire): Effect.Effect<Exchanged, WireError, Scope.Scope> =>
  Effect.gen(function* () {
    const client = yield* wireClient(wire);
    yield* wire.write(initialize);
    const initialized = yield* client.until(0);
    yield* wire.write({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } });
    const sessionId = (yield* client.until(1)).result?.sessionId ?? "";
    yield* wire.write({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "permission" }] },
    });
    const prompted = yield* client.until(2);
    yield* wire.write({
      jsonrpc: "2.0",
      id: 3,
      method: "session/load",
      params: { sessionId: "loaded-session", cwd: "/tmp", mcpServers: [] },
    });
    const loaded = yield* client.until(3, "loaded-session:replayed");
    return { initialized, sessionId, prompted, loaded, updates: client.updates, permissionRequests: client.permissionRequests };
  });

const expectExchange = (result: Exchanged) => {
  expect(result.initialized.result?.protocolVersion).toBe(1);
  expect(result.prompted.result).toEqual({ stopReason: "end_turn" });
  expect(result.loaded.result).toEqual({});
  expect(result.permissionRequests).toEqual([`${result.sessionId}:permission-tool`]);
  expect(result.updates).toEqual([
    `${result.sessionId}:permission-1`,
    `${result.sessionId}:permission-2`,
    `${result.sessionId}:permission-3`,
    `${result.sessionId}:permission-allow`,
    "loaded-session:replayed",
  ]);
};

/** The SDK's client app: answers permission requests "allow", records updates. */
const sdkClient = () => {
  const updates: string[] = [];
  const permissionRequests: string[] = [];
  const app = acp
    .client({ name: "ah-sdk-client" })
    .onRequest("session/request_permission", (c) => {
      permissionRequests.push(`${c.params.sessionId}:${c.params.toolCall.toolCallId}`);
      return { outcome: { outcome: "selected", optionId: "allow" } };
    })
    .onNotification("session/update", (c) => {
      const update = c.params.update as { readonly content?: { readonly text?: string } };
      updates.push(`${c.params.sessionId}:${update.content?.text}`);
    });
  return { app, updates, permissionRequests };
};

const prompt = (sessionId: string, text: string): acp.PromptRequest => ({ sessionId, prompt: [{ type: "text", text }] });

describe("serve, driven by the SDK's HTTP client", () => {
  test("AH1: initialize, session/new and a prompt whose updates and permission request reach the client before its response; DELETE ends the wire", async () => {
    const probe = makeProbe();
    const host = hostServe(wireAgent(probe));
    try {
      const stream = createHttpStream(host.url);
      const client = sdkClient();
      const result = await client.app.connectWith(stream, async (agent) => {
        const initialized = await agent.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
        const { sessionId } = await agent.request("session/new", { cwd: "/tmp", mcpServers: [] });
        const response = await agent.request("session/prompt", prompt(sessionId, "permission"));
        return { initialized, sessionId, response, updatesBeforeResponse: [...client.updates] };
      });
      expect(result.initialized.protocolVersion).toBe(1);
      expect(result.response).toEqual({ stopReason: "end_turn" });
      expect(client.permissionRequests).toEqual([`${result.sessionId}:permission-tool`]);
      expect(result.updatesBeforeResponse).toEqual(
        ["permission-1", "permission-2", "permission-3", "permission-allow"].map((text) => `${result.sessionId}:${text}`),
      );
      await stream.writable.close();
      await settled(probe.wireEnded);
      await settled(probe.scopeClosed);
    } finally {
      await host.stop();
    }
  });

  test("AH2: two sessions prompted at once each receive only their own updates", async () => {
    const host = hostServe(wireAgent(makeProbe()));
    try {
      const stream = createHttpStream(host.url);
      const client = sdkClient();
      const sessions = await client.app.connectWith(stream, async (agent) => {
        await agent.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
        const first = (await agent.request("session/new", { cwd: "/tmp", mcpServers: [] })).sessionId;
        const second = (await agent.request("session/new", { cwd: "/tmp", mcpServers: [] })).sessionId;
        await Promise.all([
          agent.request("session/prompt", prompt(first, "first")),
          agent.request("session/prompt", prompt(second, "second")),
        ]);
        return { first, second };
      });
      await stream.writable.close();
      expect(client.updates.filter((update) => update.startsWith(`${sessions.first}:`))).toEqual(
        ["first-1", "first-2", "first-3"].map((text) => `${sessions.first}:${text}`),
      );
      expect(client.updates.filter((update) => update.startsWith(`${sessions.second}:`))).toEqual(
        ["second-1", "second-2", "second-3"].map((text) => `${sessions.second}:${text}`),
      );
      expect(client.updates).toHaveLength(6);
    } finally {
      await host.stop();
    }
  });
});

describe("serve's routing, over raw HTTP", () => {
  test("AH2: a session's updates and the responses to its requests go to its stream only", async () => {
    const host = hostServe(wireAgent(makeProbe()));
    try {
      const connectionId = await connectionOf(host.url);
      const connection = await events(host.url, connectionId);
      const ids: string[] = [];
      for (const id of [1, 2]) {
        expect((await post(host.url, { jsonrpc: "2.0", id, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } }, { "acp-connection-id": connectionId })).status).toBe(202);
        ids.push((await connection.next())?.result?.sessionId ?? "");
      }
      const [a = "", b = ""] = ids;
      const streamA = await events(host.url, connectionId, a);
      const streamB = await events(host.url, connectionId, b);
      for (const [id, session, text] of [[3, a, "a"], [4, b, "b"]] as const) {
        const response = await post(
          host.url,
          { jsonrpc: "2.0", id, method: "session/prompt", params: prompt(session, text) },
          { "acp-connection-id": connectionId, "acp-session-id": session },
        );
        expect(response.status).toBe(202);
        expect(await response.text()).toBe("");
      }
      const readFour = async (stream: EventReader) => [await stream.next(), await stream.next(), await stream.next(), await stream.next()];
      const [seenA, seenB] = await Promise.all([readFour(streamA), readFour(streamB)]);
      expect(seenA.slice(0, 3).map(updateText)).toEqual(["a-1", "a-2", "a-3"].map((text) => `${a}:${text}`));
      expect(seenA[3]).toEqual({ jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn" } });
      expect(seenB.slice(0, 3).map(updateText)).toEqual(["b-1", "b-2", "b-3"].map((text) => `${b}:${text}`));
      expect(seenB[3]).toEqual({ jsonrpc: "2.0", id: 4, result: { stopReason: "end_turn" } });
      await Promise.all([connection.cancel(), streamA.cancel(), streamB.cancel()]);
    } finally {
      await host.stop();
    }
  });

  test("AH3: messages for a stream not yet opened are kept until a GET opens it", async () => {
    const probe = makeProbe();
    const host = hostServe(wireAgent(probe));
    try {
      const connectionId = await connectionOf(host.url);
      await post(host.url, { jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } }, { "acp-connection-id": connectionId });
      const connection = await events(host.url, connectionId);
      const sessionId = (await connection.next())?.result?.sessionId ?? "";
      await post(
        host.url,
        { jsonrpc: "2.0", id: 2, method: "session/prompt", params: prompt(sessionId, "early") },
        { "acp-connection-id": connectionId, "acp-session-id": sessionId },
      );
      await settled(probe.prompted);
      const session = await events(host.url, connectionId, sessionId);
      const seen = [await session.next(), await session.next(), await session.next(), await session.next()];
      expect(seen.slice(0, 3).map(updateText)).toEqual(["early-1", "early-2", "early-3"].map((text) => `${sessionId}:${text}`));
      expect(seen[3]?.id).toBe(2);
      await Promise.all([connection.cancel(), session.cancel()]);
    } finally {
      await host.stop();
    }
  });

  test("AH4: session/load's updates go to the session's stream and its response to the connection's stream", async () => {
    const host = hostServe(wireAgent(makeProbe()));
    try {
      const connectionId = await connectionOf(host.url);
      const connection = await events(host.url, connectionId);
      const session = await events(host.url, connectionId, "stored");
      const response = await post(
        host.url,
        { jsonrpc: "2.0", id: 7, method: "session/load", params: { sessionId: "stored", cwd: "/tmp", mcpServers: [] } },
        { "acp-connection-id": connectionId, "acp-session-id": "stored" },
      );
      expect(response.status).toBe(202);
      expect(updateText(await session.next())).toBe("stored:replayed");
      expect(await connection.next()).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
      await Promise.all([connection.cancel(), session.cancel()]);
    } finally {
      await host.stop();
    }
  });

  test("AH5: the client's answer to the agent's request about a session must carry that session's Acp-Session-Id", async () => {
    const host = hostServe(wireAgent(makeProbe()));
    try {
      const connectionId = await connectionOf(host.url);
      const connection = await events(host.url, connectionId);
      await post(host.url, { jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } }, { "acp-connection-id": connectionId });
      const sessionId = (await connection.next())?.result?.sessionId ?? "";
      const session = await events(host.url, connectionId, sessionId);
      await post(
        host.url,
        { jsonrpc: "2.0", id: 2, method: "session/prompt", params: prompt(sessionId, "permission") },
        { "acp-connection-id": connectionId, "acp-session-id": sessionId },
      );
      await session.next();
      await session.next();
      await session.next();
      const request = await session.next();
      expect(request?.method).toBe("session/request_permission");
      const answer = { jsonrpc: "2.0", id: request?.id, result: { outcome: { outcome: "selected", optionId: "allow" } } };
      const without = await post(host.url, answer, { "acp-connection-id": connectionId });
      expect([without.status, await without.text()]).toEqual([400, "Missing Acp-Session-Id"]);
      const mismatched = await post(host.url, answer, { "acp-connection-id": connectionId, "acp-session-id": "other" });
      expect([mismatched.status, await mismatched.text()]).toEqual([400, "Mismatched Acp-Session-Id"]);
      expect((await post(host.url, answer, { "acp-connection-id": connectionId, "acp-session-id": sessionId })).status).toBe(202);
      expect(updateText(await session.next())).toBe(`${sessionId}:permission-allow`);
      expect((await session.next())?.result).toEqual({ stopReason: "end_turn" });
      await Promise.all([connection.cancel(), session.cancel()]);
    } finally {
      await host.stop();
    }
  });

  test("AH7: a second GET on a stream that has a reader is refused 409", async () => {
    const host = hostServe(wireAgent(makeProbe()));
    try {
      const connectionId = await connectionOf(host.url);
      const first = await events(host.url, connectionId, "s");
      const second = await fetch(host.url, { headers: { accept: "text/event-stream", "acp-connection-id": connectionId, "acp-session-id": "s" } });
      expect(second.status).toBe(409);
      await first.cancel();
    } finally {
      await host.stop();
    }
  });

  test("AH8: DELETE closes the connection's streams, ends its wire and scope, and later requests are 404; stopping the server does the same", async () => {
    const deleted = makeProbe();
    const host = hostServe(wireAgent(deleted));
    try {
      const connectionId = await connectionOf(host.url);
      const connection = await events(host.url, connectionId);
      const session = await events(host.url, connectionId, "s");
      const response = await fetch(host.url, { method: "DELETE", headers: { "acp-connection-id": connectionId } });
      expect(response.status).toBe(202);
      expect(await connection.next()).toBeUndefined();
      expect(await session.next()).toBeUndefined();
      await settled(deleted.wireEnded);
      await settled(deleted.scopeClosed);
      expect((await post(host.url, { jsonrpc: "2.0", id: 1, method: "session/new", params: {} }, { "acp-connection-id": connectionId })).status).toBe(404);
    } finally {
      await host.stop();
    }
    const stopped = makeProbe();
    const second = hostServe(wireAgent(stopped));
    const connectionId = await connectionOf(second.url);
    const connection = await events(second.url, connectionId);
    await second.stop();
    expect(await connection.next()).toBeUndefined();
    await settled(stopped.scopeClosed);
  });

  test("AH9: when the agent's first message does not answer initialize, the POST is answered 500 with a JSON-RPC error and the connection is gone", async () => {
    const scopeClosed = Deferred.makeUnsafe<void>();
    const host = hostServe((wire) =>
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Deferred.succeed(scopeClosed, undefined));
        yield* Effect.orDie(wire.write(textUpdate("s", "too early")));
        return yield* Effect.never;
      }),
    );
    const returns = hostServe(() => Effect.void);
    try {
      for (const url of [host.url, returns.url]) {
        const response = await post(url, initialize);
        expect(response.status).toBe(500);
        expect(response.headers.get("acp-connection-id")).toBeNull();
        expect(await response.json()).toEqual({
          jsonrpc: "2.0",
          id: 0,
          error: { code: -32603, message: "Initialize failed", data: "Expected initialize response from agent" },
        });
      }
      await settled(scopeClosed);
    } finally {
      await host.stop();
      await returns.stop();
    }
  });
});

/** Every refusal the SDK's server makes, as status codes. */
const refusals = async (url: string) => {
  const live = await connectionOf(url);
  const unknown = globalThis.crypto.randomUUID();
  const sessionNew = { jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } };
  const reader = await events(url, live);
  const statuses = {
    "POST text/plain": (await fetch(url, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(initialize) })).status,
    "POST application/json-patch+json": (await fetch(url, { method: "POST", headers: { "content-type": "application/json-patch+json" }, body: "{}" })).status,
    "POST without a body or content type": (await fetch(url, { method: "POST" })).status,
    "POST invalid JSON": (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{ nope" })).status,
    "POST a batch": (await post(url, [initialize])).status,
    "POST a number": (await post(url, 1)).status,
    "POST without Acp-Connection-Id": (await post(url, sessionNew)).status,
    "POST unknown Acp-Connection-Id": (await post(url, sessionNew, { "acp-connection-id": unknown })).status,
    "POST initialize on a connection": (await post(url, initialize, { "acp-connection-id": live })).status,
    "POST session/prompt without Acp-Session-Id": (await post(url, { jsonrpc: "2.0", id: 2, method: "session/prompt", params: prompt("s", "x") }, { "acp-connection-id": live })).status,
    "POST mismatched Acp-Session-Id": (await post(url, { jsonrpc: "2.0", id: 2, method: "session/prompt", params: prompt("s", "x") }, { "acp-connection-id": live, "acp-session-id": "t" })).status,
    "GET without Accept": (await fetch(url, { headers: { "acp-connection-id": live } })).status,
    "GET without Acp-Connection-Id": (await fetch(url, { headers: { accept: "text/event-stream" } })).status,
    "GET unknown Acp-Connection-Id": (await fetch(url, { headers: { accept: "text/event-stream", "acp-connection-id": unknown } })).status,
    "GET a second reader": (await fetch(url, { headers: { accept: "text/event-stream", "acp-connection-id": live } })).status,
    "GET a WebSocket upgrade": (await fetch(url, { headers: { accept: "text/event-stream", upgrade: "websocket", connection: "upgrade" } })).status,
    "PUT": (await fetch(url, { method: "PUT" })).status,
    "PATCH": (await fetch(url, { method: "PATCH" })).status,
    "DELETE without Acp-Connection-Id": (await fetch(url, { method: "DELETE" })).status,
    "DELETE unknown Acp-Connection-Id": (await fetch(url, { method: "DELETE", headers: { "acp-connection-id": unknown } })).status,
    "DELETE": (await fetch(url, { method: "DELETE", headers: { "acp-connection-id": live } })).status,
    "POST after DELETE": (await post(url, sessionNew, { "acp-connection-id": live })).status,
  };
  await reader.cancel();
  return statuses;
};

describe("serve's refusals", () => {
  test("AH6: serve refuses what the SDK's server refuses, with the same statuses", async () => {
    const ours = hostServe(wireAgent(makeProbe()));
    const sdk = await hostSdk();
    try {
      const expected = {
        "POST text/plain": 415,
        "POST application/json-patch+json": 415,
        "POST without a body or content type": 415,
        "POST invalid JSON": 400,
        "POST a batch": 501,
        "POST a number": 400,
        "POST without Acp-Connection-Id": 400,
        "POST unknown Acp-Connection-Id": 404,
        "POST initialize on a connection": 400,
        "POST session/prompt without Acp-Session-Id": 400,
        "POST mismatched Acp-Session-Id": 400,
        "GET without Accept": 406,
        "GET without Acp-Connection-Id": 400,
        "GET unknown Acp-Connection-Id": 404,
        "GET a second reader": 409,
        "GET a WebSocket upgrade": 426,
        PUT: 405,
        PATCH: 405,
        "DELETE without Acp-Connection-Id": 400,
        "DELETE unknown Acp-Connection-Id": 404,
        DELETE: 202,
        "POST after DELETE": 404,
      };
      expect(await refusals(sdk.url)).toEqual(expected);
      expect(await refusals(ours.url)).toEqual(expected);
    } finally {
      await ours.stop();
      await sdk.stop();
    }
  });
});

describe("connect", () => {
  test("AH10: the same exchange, driven from the wire, against the SDK's server and against serve", async () => {
    const sdk = await hostSdk();
    const probe = makeProbe();
    const ours = hostServe(wireAgent(probe));
    try {
      expectExchange(await runClient(Effect.flatMap(connect(sdk.url), exchange)));
      expectExchange(await runClient(Effect.flatMap(connect(ours.url), exchange)));
      await settled(probe.wireEnded);
      await settled(probe.scopeClosed);
    } finally {
      await sdk.stop();
      await ours.stop();
    }
  });

  test("AH11: a session's stream is open before the first POST about it, and those POSTs, and answers to requests from its stream, carry its Acp-Session-Id", async () => {
    const sdk = await hostSdk();
    try {
      const result = await runClient(Effect.flatMap(connect(sdk.url), exchange));
      const index = (predicate: (request: Recorded) => boolean) => sdk.requests.findIndex(predicate);
      for (const [sessionId, rpc] of [[result.sessionId, "session/prompt"], ["loaded-session", "session/load"]] as const) {
        const opened = index((request) => request.method === "GET" && request.sessionId === sessionId);
        const posted = index((request) => request.rpc === rpc);
        expect(opened).toBeGreaterThanOrEqual(0);
        expect(opened).toBeLessThan(posted);
        expect(sdk.requests[posted]?.sessionId).toBe(sessionId);
      }
      const answer = sdk.requests.find((request) => request.rpc === "response");
      expect(answer?.sessionId).toBe(result.sessionId);
      expect(answer?.status).toBe(202);
      expect(sdk.requests.find((request) => request.rpc === "session/new")?.sessionId).toBeNull();
    } finally {
      await sdk.stop();
    }
  });

  test("AH12: the caller's headers go on every request, and cookies the server sets come back on every later one", async () => {
    const sdk = await hostSdk();
    try {
      await runClient(Effect.flatMap(connect(sdk.url, { headers: { Authorization: "Bearer token", Cookie: "caller=1; affinity=caller" } }), exchange));
      const [first, ...later] = sdk.requests;
      expect(first?.cookie).toBe("caller=1; affinity=caller");
      expect(later.length).toBeGreaterThan(5);
      expect(new Set(later.map((request) => request.cookie))).toEqual(new Set(["affinity=caller; caller=1"]));
      await runClient(Effect.flatMap(connect(sdk.url, { headers: { Authorization: "Bearer token" } }), exchange));
      const second = sdk.requests.slice(later.length + 1);
      expect(second[0]?.cookie).toBeNull();
      expect(new Set(second.slice(1).map((request) => request.cookie))).toEqual(new Set(["affinity=backend-1"]));
      expect(new Set(sdk.requests.map((request) => request.authorization))).toEqual(new Set(["Bearer token"]));
    } finally {
      await sdk.stop();
    }
  });

  test("AH13: closing the scope DELETEs the connection; read fails when the connection's stream ends without that, for example after something else DELETEs the connection", async () => {
    const sdk = await hostSdk();
    try {
      await runClient(Effect.flatMap(connect(sdk.url), exchange));
      const last = sdk.requests.at(-1);
      expect([last?.method, last?.connectionId, last?.status]).toEqual(["DELETE", sdk.connectionIds[0] ?? "", 202]);
      const failed = await runClient(
        Effect.gen(function* () {
          const wire = yield* connect(sdk.url);
          const client = yield* wireClient(wire);
          yield* wire.write(initialize);
          yield* client.until(0);
          const connectionId = sdk.connectionIds[1] ?? "";
          yield* Effect.promise(() => fetch(sdk.url, { method: "DELETE", headers: { "acp-connection-id": connectionId } }));
          return yield* Fiber.join(client.readEnded).pipe(Effect.flip, Effect.timeout("3 seconds"));
        }),
      );
      expect(failed.reason).toBe("ACP connection SSE stream closed");
    } finally {
      await sdk.stop();
    }
  });

  test("AH13: read fails when a server that closes idle connections drops the connection's stream", async () => {
    const host = hostServe(quietAgent(Deferred.makeUnsafe()), { idleTimeout: 1, keepAliveInterval: "1 minute" });
    try {
      const failed = await runClient(
        Effect.gen(function* () {
          const wire = yield* connect(host.url);
          const client = yield* wireClient(wire);
          yield* wire.write(initialize);
          yield* client.until(0);
          return yield* Fiber.join(client.readEnded).pipe(Effect.flip, Effect.timeout("5 seconds"));
        }),
      );
      // `Bun.serve` cuts the connection mid-body, which `fetch` reads as an error rather than an end.
      expect(failed._tag).toBe("WireError");
      expect(failed.reason).toMatch(/^ACP (connection SSE stream closed|SSE stream failed: )/);
    } finally {
      await host.stop();
    }
  }, 15_000);

  test("AH15: an event stream stays open past the server's idle timeout, and delivers what the agent sends after it", async () => {
    const trigger = Deferred.makeUnsafe<void>();
    const host = hostServe(quietAgent(trigger), { idleTimeout: 1, keepAliveInterval: "200 millis" });
    try {
      const outcome = await runClient(
        Effect.gen(function* () {
          const wire = yield* connect(host.url);
          const inbox = yield* Queue.unbounded<unknown>();
          const read = yield* wire.read.pipe(
            Stream.runForEach((input) => Queue.offer(inbox, input._tag === "Json" ? input.value : input)),
            Effect.forkScoped,
          );
          yield* wire.write(initialize);
          yield* Queue.take(inbox).pipe(Effect.timeout("3 seconds"));
          yield* Effect.sleep("2500 millis");
          yield* Deferred.succeed(trigger, undefined);
          const late = yield* Queue.take(inbox).pipe(Effect.timeout("3 seconds"));
          return { late, read: read.pollUnsafe() };
        }),
      );
      expect(outcome.late).toEqual({ jsonrpc: "2.0", method: "late" });
      expect(outcome.read).toBeUndefined();
    } finally {
      await host.stop();
    }
  }, 15_000);

  test("AH14: a refused request fails the write with its status and body, and fails read; a batch is refused", async () => {
    const host = hostServe(wireAgent(makeProbe()));
    try {
      const outcome = await runClient(
        Effect.gen(function* () {
          const wire = yield* connect(host.url.replace("/acp", "/elsewhere"));
          const read = yield* Effect.forkScoped(Stream.runDrain(wire.read));
          const written = yield* Effect.flip(wire.write(initialize));
          const readExit = yield* Fiber.await(read).pipe(Effect.timeout("3 seconds"));
          const afterwards = yield* Effect.flip(wire.write(initialize));
          return { written: written.reason, readExit: readExit._tag, afterwards: afterwards.reason };
        }),
      );
      expect(outcome.written).toStartWith("ACP initialize failed: 404");
      expect(outcome.readExit).toBe("Failure");
      expect(outcome.afterwards).toBe("ACP HTTP stream is closed");
      const batch = await runClient(
        Effect.gen(function* () {
          const wire = yield* connect(host.url);
          return (yield* Effect.flip(wire.write([initialize]))).reason;
        }),
      );
      expect(batch).toBe("ACP Streamable HTTP does not carry JSON-RPC batches");
    } finally {
      await host.stop();
    }
  });
});
