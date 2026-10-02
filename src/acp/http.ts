/**
 * ACP's Streamable HTTP transport: the agent's end (`serve`, routes on an `HttpRouter`) and the
 * client's end (`connect`, over an `HttpClient`). Each ACP connection is one `Wire`.
 *
 * One endpoint. POST carries the client's messages: `initialize` is answered 200 with the agent's
 * response and an `Acp-Connection-Id` header, every other message 202 with no body. GET with
 * `Accept: text/event-stream` opens a server-sent event stream: with `Acp-Connection-Id` alone the
 * connection's stream, with `Acp-Session-Id` as well that session's stream. DELETE ends the
 * connection. Statuses and routing follow `@agentclientprotocol/sdk` 1.5.0's `AcpServer` and
 * `createHttpStream`. WebSocket upgrade is not implemented: such a GET is answered 426.
 */

import { Cause, Deferred, type Duration, Effect, Exit, Fiber, type Layer, Predicate, Queue, Scope, Semaphore, Stream } from "effect";
import * as Sse from "effect/encoding/Sse";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpRouter from "effect/http/HttpRouter";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { isRequest, isResponse, type JsonRpcMessage, type Wire, WireError, WireInput } from "./json-rpc.ts";

/** The header naming the connection, set by the agent on its answer to `initialize`. */
export const ConnectionIdHeader = "Acp-Connection-Id";

/** The header naming the session a request, or a stream, belongs to. */
export const SessionIdHeader = "Acp-Session-Id";

const connectionIdKey = "acp-connection-id";
const sessionIdKey = "acp-session-id";
const eventStream = "text/event-stream";
const jsonMime = "application/json";

/** Methods whose POST must carry `Acp-Session-Id`, whatever their params say. */
const sessionScopedMethods: ReadonlySet<string> = new Set([
  "session/cancel",
  "session/close",
  "session/delete",
  "session/fork",
  "session/load",
  "session/prompt",
  "session/resume",
  "session/set_config_option",
  "session/set_mode",
  "session/set_model",
  "nes/suggest",
  "nes/accept",
  "nes/reject",
  "nes/close",
  "document/didOpen",
  "document/didChange",
  "document/didClose",
  "document/didSave",
  "document/didFocus",
]);

type Json = Readonly<Record<string, unknown>>;

const isInitializeRequest = (value: Json): boolean =>
  value["jsonrpc"] === "2.0" && "id" in value && value["method"] === "initialize";

/** The key a message id is tracked under: `1` and `"1"` are different ids. */
const idKey = (id: unknown): string | undefined => {
  if (typeof id === "string") return `string:${id}`;
  if (typeof id === "number") return `number:${id}`;
  if (id === null) return "null";
  return undefined;
};

const sessionIdOf = (params: unknown): string | undefined => {
  if (!Predicate.isObject(params)) return undefined;
  const sessionId = params["sessionId"];
  return typeof sessionId === "string" ? sessionId : undefined;
};

/** The session a request or notification is about: `params.sessionId`. */
const paramsSessionId = (message: unknown): string | undefined =>
  Predicate.isObject(message) && "method" in message ? sessionIdOf(message["params"]) : undefined;

/** The session a response names: `result.sessionId`, as `session/new` answers. */
const resultSessionId = (message: unknown): string | undefined =>
  isResponse(message) && "result" in message ? sessionIdOf(message["result"]) : undefined;

const isBatch = (message: JsonRpcMessage | ReadonlyArray<JsonRpcMessage>): message is ReadonlyArray<JsonRpcMessage> =>
  Array.isArray(message);

const parseJson = (text: string): { readonly value: unknown } | undefined => {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return undefined;
  }
};

const batchRefused = (): WireError => new WireError({ reason: "ACP Streamable HTTP does not carry JSON-RPC batches" });

// The agent's end.

/** Where a message for the client goes: the connection's stream, or one session's. */
type Route = "connection" | { readonly session: string };

/**
 * One outbound event stream's messages. They are kept until a GET reads them, so messages for a
 * session whose stream the client has not opened yet are delivered when it does. One GET at a time.
 */
interface Outbox {
  readonly queue: Queue.Queue<unknown, Cause.Done>;
  leased: boolean;
}

interface ServerConnection {
  readonly id: string;
  readonly inbound: Queue.Queue<WireInput, Cause.Done>;
  readonly connectionStream: Outbox;
  readonly sessions: Map<string, Outbox>;
  /** Requests from the client, by id: where their responses go. */
  readonly pendingRoutes: Map<string, Route>;
  /** Requests from the agent, by id: the session the client's response must name. */
  readonly clientResponseRoutes: Map<string, Route>;
  /** The first message the agent writes, which must answer `initialize`. */
  readonly initial: Deferred.Deferred<unknown, WireError>;
  readonly scope: Scope.Closeable;
  open: boolean;
  fiber: Fiber.Fiber<void> | undefined;
}

const makeOutbox: Effect.Effect<Outbox> = Effect.map(Queue.unbounded<unknown, Cause.Done>(), (queue) => ({ queue, leased: false }));

/** Ends the stream once what is queued has been read. */
const finishOutbox = (outbox: Outbox): Effect.Effect<void> => Effect.asVoid(Queue.end(outbox.queue));

/** Ends the stream now, dropping what is queued. */
const abortOutbox = (outbox: Outbox): Effect.Effect<void> =>
  Queue.end(outbox.queue).pipe(Effect.andThen(Queue.shutdown(outbox.queue)), Effect.asVoid);

const ensureSession = (connection: ServerConnection, sessionId: string): Effect.Effect<Outbox> =>
  Effect.suspend(() => {
    const existing = connection.sessions.get(sessionId);
    if (existing !== undefined) return Effect.succeed(existing);
    return Effect.map(makeOutbox, (outbox) => {
      const raced = connection.sessions.get(sessionId);
      if (raced !== undefined) return raced;
      connection.sessions.set(sessionId, outbox);
      return outbox;
    });
  });

/**
 * The outbox's messages as `data:` events, with a keep-alive comment at once and then one every
 * `keepAliveInterval`. The first comment makes a server that holds the headers until the body's
 * first bytes (`Bun.serve` does) send them; the rest keep a server or proxy that closes idle
 * connections from closing a stream with nothing to send.
 */
const sseBody = (outbox: Outbox, keepAliveInterval: Duration.Input): Stream.Stream<Uint8Array> =>
  Stream.fromQueue(outbox.queue).pipe(
    Stream.map((message) => `data: ${JSON.stringify(message)}\n\n`),
    Stream.merge(Stream.tick(keepAliveInterval).pipe(Stream.as(":\n\n")), { haltStrategy: "left" }),
    Stream.encodeText,
    Stream.ensuring(
      Effect.sync(() => {
        outbox.leased = false;
      }),
    ),
  );

const routeOutbound = (connection: ServerConnection, message: unknown): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (isResponse(message)) {
      const key = idKey(message.id);
      const route = key === undefined ? undefined : connection.pendingRoutes.get(key);
      const named = resultSessionId(message);
      if (named !== undefined) yield* ensureSession(connection, named);
      if (key !== undefined) connection.pendingRoutes.delete(key);
      const outbox =
        route === undefined || route === "connection" ? connection.connectionStream : yield* ensureSession(connection, route.session);
      yield* Queue.offer(outbox.queue, message);
      return;
    }
    const sessionId = paramsSessionId(message);
    const key = isRequest(message) ? idKey(message.id) : undefined;
    if (key !== undefined) connection.clientResponseRoutes.set(key, sessionId === undefined ? "connection" : { session: sessionId });
    const outbox = sessionId === undefined ? connection.connectionStream : yield* ensureSession(connection, sessionId);
    yield* Queue.offer(outbox.queue, message);
  });

const writeOutbound = (
  connection: ServerConnection,
  message: JsonRpcMessage | ReadonlyArray<JsonRpcMessage>,
): Effect.Effect<void, WireError> =>
  Effect.suspend(() => {
    if (!connection.open) return Effect.fail(new WireError({ reason: `ACP connection ${connection.id} is closed` }));
    if (isBatch(message)) return Effect.fail(batchRefused());
    if (!Deferred.isDoneUnsafe(connection.initial)) {
      Deferred.doneUnsafe(connection.initial, Effect.succeed(message));
      return Effect.void;
    }
    return routeOutbound(connection, message);
  });

const textResponse = (body: string, status: number): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(body, { status, contentType: "text/plain" });

const header = (request: HttpServerRequest.HttpServerRequest, key: string): string | undefined => {
  const value = request.headers[key];
  return value === undefined || value === "" ? undefined : value;
};

const initializeFailed = (id: unknown, reason: string): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.jsonUnsafe(
    { jsonrpc: "2.0", id, error: { code: -32603, message: "Initialize failed", data: reason } },
    { status: 500 },
  );

const notAnswered = (): WireError => new WireError({ reason: "Expected initialize response from agent" });

export interface ServeOptions<R> {
  /** The endpoint. Default `/acp`. */
  readonly path?: HttpRouter.PathInput | undefined;
  /**
   * How often each event stream gets a keep-alive comment, whatever else it sends. Default 5 seconds,
   * half of `Bun.serve`'s default `idleTimeout` (10 seconds), after which Bun closes an idle connection.
   */
  readonly keepAliveInterval?: Duration.Input | undefined;
  /**
   * Runs once per ACP connection, from its `initialize` until the client's DELETE or the server's
   * stop, which close its scope. The first message it writes must answer `initialize`. When it
   * returns, the connection ends: its streams deliver what is queued and close.
   */
  readonly onConnection: (wire: Wire, connection: { readonly id: string }) => Effect.Effect<void, never, Scope.Scope | R>;
}

/**
 * The agent's end of ACP's Streamable HTTP transport, as POST, GET and DELETE routes on the
 * `HttpRouter` at `path`, and 405 for PUT, PATCH, OPTIONS and QUERY there.
 */
export const serve = <R = never>(
  options: ServeOptions<R>,
): Layer.Layer<never, never, HttpRouter.HttpRouter | Exclude<R, Scope.Scope>> =>
  HttpRouter.use((router) =>
    Effect.gen(function* () {
      const context = yield* Effect.context<Exclude<R, Scope.Scope>>();
      const connections = new Map<string, ServerConnection>();
      const path = options.path ?? "/acp";
      const keepAliveInterval = options.keepAliveInterval ?? "5 seconds";

      const forget = (connection: ServerConnection): void => {
        connection.open = false;
        if (connections.get(connection.id) === connection) connections.delete(connection.id);
      };

      /** The agent's end returned: deliver what is queued, then close the streams and the scope. */
      const ended = (connection: ServerConnection): Effect.Effect<void> =>
        Effect.gen(function* () {
          forget(connection);
          yield* Deferred.fail(connection.initial, notAnswered());
          yield* Queue.end(connection.inbound);
          yield* finishOutbox(connection.connectionStream);
          yield* Effect.forEach(connection.sessions.values(), finishOutbox, { discard: true });
          yield* Scope.close(connection.scope, Exit.void);
        });

      /** DELETE, or the server stopping: drop what is queued, close the streams, stop the agent's end. */
      const shutdown = (connection: ServerConnection): Effect.Effect<void> =>
        Effect.gen(function* () {
          forget(connection);
          yield* abortOutbox(connection.connectionStream);
          yield* Effect.forEach(connection.sessions.values(), abortOutbox, { discard: true });
          connection.sessions.clear();
          connection.pendingRoutes.clear();
          connection.clientResponseRoutes.clear();
          yield* Queue.end(connection.inbound);
          yield* Deferred.fail(connection.initial, notAnswered());
          if (connection.fiber !== undefined) yield* Fiber.interrupt(connection.fiber);
        }).pipe(Effect.uninterruptible);

      const open: Effect.Effect<ServerConnection> = Effect.gen(function* () {
        const connection: ServerConnection = {
          id: globalThis.crypto.randomUUID(),
          inbound: yield* Queue.unbounded<WireInput, Cause.Done>(),
          connectionStream: yield* makeOutbox,
          sessions: new Map(),
          pendingRoutes: new Map(),
          clientResponseRoutes: new Map(),
          initial: yield* Deferred.make<unknown, WireError>(),
          scope: yield* Scope.make(),
          open: true,
          fiber: undefined,
        };
        connections.set(connection.id, connection);
        const wire: Wire = {
          read: Stream.fromQueue(connection.inbound),
          write: (message) => writeOutbound(connection, message),
        };
        connection.fiber = Effect.runForkWith(context)(
          options.onConnection(wire, { id: connection.id }).pipe(
            Scope.provide(connection.scope),
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.void
                : Effect.logError("ACP connection handler failed", cause).pipe(
                    Effect.annotateLogs({ acpConnectionId: connection.id }),
                  ),
            ),
            Effect.ensuring(ended(connection)),
          ),
        );
        return connection;
      });

      const initialize = (message: Json): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
        Effect.gen(function* () {
          const id = message["id"];
          if (id === null) return textResponse("Initialize request must include an ID", 400);
          const connection = yield* open;
          return yield* Effect.gen(function* () {
            yield* Queue.offer(connection.inbound, WireInput.Json({ value: message }));
            const answer = yield* Deferred.await(connection.initial);
            if (!isResponse(answer) || answer.id !== id) {
              yield* shutdown(connection);
              return initializeFailed(id, notAnswered().reason);
            }
            return HttpServerResponse.jsonUnsafe(answer, { headers: { [connectionIdKey]: connection.id } });
          }).pipe(
            Effect.catch((error) => Effect.as(shutdown(connection), initializeFailed(id, error.reason))),
            Effect.onInterrupt(() => shutdown(connection)),
          );
        });

      const forwardResponse = (
        connection: ServerConnection,
        message: Json & { readonly id: unknown },
        sessionHeader: string | undefined,
      ): Effect.Effect<HttpServerResponse.HttpServerResponse | undefined> =>
        Effect.gen(function* () {
          const key = idKey(message.id);
          const route = key === undefined ? undefined : connection.clientResponseRoutes.get(key);
          if (route !== undefined && route !== "connection") {
            if (sessionHeader === undefined) return textResponse("Missing Acp-Session-Id", 400);
            if (sessionHeader !== route.session) return textResponse("Mismatched Acp-Session-Id", 400);
          }
          if (key !== undefined) connection.clientResponseRoutes.delete(key);
          yield* Queue.offer(connection.inbound, WireInput.Json({ value: message }));
          return undefined;
        });

      const forwardMethod = (
        connection: ServerConnection,
        message: Json,
        sessionHeader: string | undefined,
      ): Effect.Effect<HttpServerResponse.HttpServerResponse | undefined> =>
        Effect.gen(function* () {
          const method = message["method"];
          const fromParams = sessionIdOf(message["params"]);
          const scoped = typeof method === "string" && sessionScopedMethods.has(method);
          if ((scoped || fromParams !== undefined) && sessionHeader === undefined) {
            return textResponse("Missing Acp-Session-Id", 400);
          }
          if (sessionHeader !== undefined && fromParams !== undefined && sessionHeader !== fromParams) {
            return textResponse("Mismatched Acp-Session-Id", 400);
          }
          const sessionId = sessionHeader ?? fromParams;
          const route: Route = sessionId === undefined ? "connection" : { session: sessionId };
          if (sessionId !== undefined) yield* ensureSession(connection, sessionId);
          const key = "id" in message ? idKey(message["id"]) : undefined;
          // `session/load` names a session the client may not have a stream for yet: its response goes to the connection's stream.
          if (key !== undefined) connection.pendingRoutes.set(key, method === "session/load" ? "connection" : route);
          yield* Queue.offer(connection.inbound, WireInput.Json({ value: message }));
          return undefined;
        });

      const post = (request: HttpServerRequest.HttpServerRequest): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
        Effect.gen(function* () {
          const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
          if (contentType !== jsonMime) return textResponse("Unsupported Media Type", 415);
          const body = yield* request.text.pipe(
            Effect.map(parseJson),
            Effect.orElseSucceed(() => undefined),
          );
          if (body === undefined) return textResponse("Invalid JSON", 400);
          const message = body.value;
          if (Array.isArray(message)) return textResponse("Batch JSON-RPC requests are not implemented", 501);
          if (!Predicate.isObject(message)) return textResponse("Invalid JSON-RPC message", 400);
          const connectionId = header(request, connectionIdKey);
          if (isInitializeRequest(message)) {
            if (connectionId === undefined) return yield* initialize(message);
            return textResponse("Initialize not allowed on existing connection", 400);
          }
          if (connectionId === undefined) return textResponse("Missing Acp-Connection-Id", 400);
          const connection = connections.get(connectionId);
          if (connection === undefined) return textResponse("Unknown Acp-Connection-Id", 404);
          const sessionHeader = header(request, sessionIdKey);
          const refused = isResponse(message)
            ? yield* forwardResponse(connection, message, sessionHeader)
            : yield* forwardMethod(connection, message, sessionHeader);
          return refused ?? HttpServerResponse.empty({ status: 202 });
        });

      const get = (request: HttpServerRequest.HttpServerRequest): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
        Effect.gen(function* () {
          if (request.headers["upgrade"]?.toLowerCase() === "websocket") {
            return textResponse("WebSocket upgrade is not implemented", 426);
          }
          if (!request.headers["accept"]?.toLowerCase().includes(eventStream)) return textResponse("Not Acceptable", 406);
          const connectionId = header(request, connectionIdKey);
          if (connectionId === undefined) return textResponse("Missing Acp-Connection-Id", 400);
          const connection = connections.get(connectionId);
          if (connection === undefined) return textResponse("Unknown Acp-Connection-Id", 404);
          const sessionId = header(request, sessionIdKey);
          const outbox = sessionId === undefined ? connection.connectionStream : yield* ensureSession(connection, sessionId);
          if (outbox.leased) return textResponse("Outbound stream already has an active receiver", 409);
          outbox.leased = true;
          return HttpServerResponse.stream(sseBody(outbox, keepAliveInterval), {
            contentType: eventStream,
            headers: { "cache-control": "no-cache", connection: "keep-alive" },
          });
        });

      const del = (request: HttpServerRequest.HttpServerRequest): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
        Effect.gen(function* () {
          const connectionId = header(request, connectionIdKey);
          if (connectionId === undefined) return textResponse("Missing Acp-Connection-Id", 400);
          const connection = connections.get(connectionId);
          if (connection === undefined) return textResponse("Unknown Acp-Connection-Id", 404);
          yield* shutdown(connection);
          return HttpServerResponse.empty({ status: 202 });
        });

      yield* Effect.addFinalizer(() =>
        Effect.forEach([...connections.values()], shutdown, { discard: true, concurrency: "unbounded" }),
      );
      yield* router.add("POST", path, post);
      yield* router.add("GET", path, get);
      yield* router.add("DELETE", path, del);
      const methodNotAllowed = textResponse("Method Not Allowed", 405);
      yield* router.add("PUT", path, methodNotAllowed);
      yield* router.add("PATCH", path, methodNotAllowed);
      yield* router.add("OPTIONS", path, methodNotAllowed);
      yield* router.add("QUERY", path, methodNotAllowed);
    }),
  );

// The client's end.

export interface ConnectOptions {
  /** Sent on every request. A `Cookie` here overrides a cookie of the same name the server set. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

const cookiePairs = (header: string | undefined): ReadonlyArray<readonly [string, string]> =>
  (header ?? "").split(";").flatMap((pair) => {
    const separator = pair.indexOf("=");
    const name = pair.slice(0, Math.max(separator, 0)).trim();
    return separator <= 0 || name === "" ? [] : [[name, pair.slice(separator + 1).trim()] as const];
  });

/**
 * The client's end of ACP's Streamable HTTP transport, for the agent at `url`.
 *
 * Nothing is sent until the first write, which must be `initialize`: it is POSTed, and its answer
 * names the connection, whose stream is then opened. A session's stream is opened when a message
 * names the session (`result.sessionId` of a response, `params.sessionId` of a message written),
 * and a message about a session is not POSTed until its stream is open. Cookies the server sets
 * are sent back on every later request. Closing the scope aborts the streams and requests in
 * flight, DELETEs the connection and ends `read`. Until then, `read` fails when a request or a
 * stream fails, when the connection's stream ends (`ACP connection SSE stream closed`), and when a
 * session's stream ends while a request about that session waits for its response.
 */
export const connect = (
  url: string,
  options?: ConnectOptions,
): Effect.Effect<Wire, WireError, HttpClient.HttpClient | Scope.Scope> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const scope = yield* Scope.Scope;
    const streams = yield* Scope.fork(scope);
    const inbound = yield* Queue.unbounded<WireInput, WireError | Cause.Done>();
    const writeLock = yield* Semaphore.make(1);
    const closing = yield* Deferred.make<void>();
    const callerHeaders = Object.entries(options?.headers ?? {});
    const callerCookie = callerHeaders.find(([name]) => name.toLowerCase() === "cookie")?.[1];
    const cookies = new Map<string, string>();
    const knownSessions = new Set<string>();
    const sessionReady = new Map<string, Deferred.Deferred<void, WireError>>();
    /** Requests from the agent that arrived on a session's stream, by id: their responses name that session. */
    const pendingResponseSessions = new Map<string, string>();
    /** Requests to the agent about a session, by id, until their responses arrive. */
    const pendingSessionRequests = new Map<string, string>();
    const state: { connectionId: string | undefined; ended: boolean; deleted: boolean } = {
      connectionId: undefined,
      ended: false,
      deleted: false,
    };

    const closedError = (): WireError => new WireError({ reason: "ACP HTTP stream is closed" });

    const requestHeaders = (transport: Readonly<Record<string, string>>): Record<string, string> => {
      const headers: Record<string, string> = {};
      for (const [name, value] of [...callerHeaders, ...Object.entries(transport)]) headers[name.toLowerCase()] = value;
      const merged = new Map(cookies);
      for (const [name, value] of cookiePairs(callerCookie)) merged.set(name, value);
      if (merged.size > 0) headers["cookie"] = [...merged].map(([name, value]) => `${name}=${value}`).join("; ");
      return headers;
    };

    const send = (
      request: HttpClientRequest.HttpClientRequest,
      transport: Readonly<Record<string, string>>,
      failure: string,
    ): Effect.Effect<HttpClientResponse.HttpClientResponse, WireError> =>
      http.execute(HttpClientRequest.setHeaders(request, requestHeaders(transport))).pipe(
        Effect.tap((response) =>
          Effect.sync(() => {
            for (const cookie of Object.values(response.cookies.cookies)) cookies.set(cookie.name, cookie.valueEncoded);
          }),
        ),
        Effect.mapError((error) => new WireError({ reason: `${failure}: ${error.message}`, cause: error })),
      );

    /** A response that is not 2xx, as a failure carrying its status and body. */
    const expectOk = (
      response: HttpClientResponse.HttpClientResponse,
      failure: string,
    ): Effect.Effect<HttpClientResponse.HttpClientResponse, WireError> =>
      response.status >= 200 && response.status < 300
        ? Effect.succeed(response)
        : response.text.pipe(
            Effect.orElseSucceed(() => ""),
            Effect.flatMap((text) =>
              Effect.fail(
                new WireError({ reason: `${failure}: ${response.status}${text === "" ? "" : `: ${text}`}` }),
              ),
            ),
          );

    /** Fails with "closed" as soon as the wire closes, interrupting the request. */
    const abortable = <A>(effect: Effect.Effect<A, WireError>): Effect.Effect<A, WireError> =>
      Effect.raceFirst(effect, Effect.andThen(Deferred.await(closing), Effect.fail(closedError())));

    const deleteConnection: Effect.Effect<void> = Effect.suspend(() => {
      const connectionId = state.connectionId;
      if (connectionId === undefined || state.deleted) return Effect.void;
      state.deleted = true;
      return send(HttpClientRequest.delete(url), { [connectionIdKey]: connectionId }, "ACP DELETE failed").pipe(
        Effect.ignore,
      );
    });

    /** Stops the streams, then ends the connection at the agent. */
    const teardown: Effect.Effect<void> = Scope.close(streams, Exit.void).pipe(
      Effect.andThen(deleteConnection),
      Effect.andThen(Effect.sync(() => cookies.clear())),
      Effect.uninterruptible,
    );

    const stop = (ending: Effect.Effect<unknown>): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (state.ended) return Effect.void;
        state.ended = true;
        return Deferred.succeed(closing, undefined).pipe(
          Effect.andThen(ending),
          Effect.andThen(Effect.forkIn(teardown, scope)),
          Effect.asVoid,
        );
      });

    /** `read` fails with `error`, and the connection is torn down. */
    const failRead = (error: WireError): Effect.Effect<void> => stop(Queue.fail(inbound, error));

    /**
     * A stream ended, and not because this end closed: the agent ended the connection, or a server
     * or proxy dropped the stream. As in the SDK's client, a session's stream that ends with no
     * request about the session waiting is forgotten, and opened again when a message names it.
     */
    const streamEnded = (sessionId: string | undefined): Effect.Effect<void, WireError> =>
      Effect.suspend(() => {
        if (state.ended) return Effect.void;
        if (sessionId === undefined) return Effect.fail(new WireError({ reason: "ACP connection SSE stream closed" }));
        knownSessions.delete(sessionId);
        sessionReady.delete(sessionId);
        return [...pendingSessionRequests.values()].includes(sessionId)
          ? Effect.fail(new WireError({ reason: `ACP session SSE stream closed: ${sessionId}` }))
          : Effect.void;
      });

    const receive = (data: string, streamSession: string | undefined): Effect.Effect<void, WireError> =>
      Effect.gen(function* () {
        if (state.ended) return;
        const parsed = parseJson(data);
        if (parsed === undefined) {
          yield* Queue.offer(inbound, WireInput.Unparsable({ text: data }));
          return;
        }
        const message = parsed.value;
        if (Array.isArray(message)) return yield* batchRefused();
        const named = resultSessionId(message);
        // Opened, not waited for: the next POST about the session waits.
        if (named !== undefined) yield* Effect.asVoid(openSession(named));
        if (streamSession !== undefined && isRequest(message)) {
          const key = idKey(message.id);
          if (key !== undefined) pendingResponseSessions.set(key, streamSession);
        }
        if (isResponse(message)) {
          const key = idKey(message.id);
          if (key !== undefined) pendingSessionRequests.delete(key);
        }
        yield* Queue.offer(inbound, WireInput.Json({ value: message }));
      });

    /** Opens a stream (the connection's, or `sessionId`'s) in the background; `ready` completes once it is open. */
    const openStream = (
      connectionId: string,
      sessionId: string | undefined,
      ready: Deferred.Deferred<void, WireError> | undefined,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const transport: Record<string, string> = { accept: eventStream, [connectionIdKey]: connectionId };
        if (sessionId !== undefined) transport[sessionIdKey] = sessionId;
        const response = yield* send(HttpClientRequest.get(url), transport, "ACP SSE connection failed").pipe(
          Effect.flatMap((response) => expectOk(response, "ACP SSE connection failed")),
        );
        if (ready !== undefined) yield* Deferred.succeed(ready, undefined);
        yield* response.stream.pipe(
          Stream.decodeText,
          Stream.pipeThroughChannel(Sse.decode()),
          Stream.mapError((error) => {
            // The SDK's server never sends `retry:`; a stream that does is not one this transport resumes.
            const description = error._tag === "Retry" ? "the server asked for a reconnect" : error.message;
            return new WireError({ reason: `ACP SSE stream failed: ${description}`, cause: error });
          }),
          Stream.runForEach((event) => receive(event.data, sessionId)),
        );
        yield* streamEnded(sessionId);
      }).pipe(
        Effect.catch((error) =>
          state.ended
            ? Effect.void
            : Effect.andThen(ready === undefined ? Effect.void : Deferred.fail(ready, error), failRead(error)),
        ),
        Effect.ensuring(
          Effect.suspend(() => {
            if (sessionId !== undefined && sessionReady.get(sessionId) === ready) sessionReady.delete(sessionId);
            return ready === undefined
              ? Effect.void
              : Deferred.fail(ready, new WireError({ reason: "ACP session SSE stream closed before opening" }));
          }),
        ),
        Effect.forkIn(streams),
        Effect.asVoid,
      );

    /** Opens the session's stream if it is not open. The result waits until it is. */
    const openSession = (sessionId: string): Effect.Effect<Effect.Effect<void, WireError>> =>
      Effect.suspend(() => {
        const existing = sessionReady.get(sessionId);
        if (existing !== undefined) return Effect.succeed(Deferred.await(existing));
        const connectionId = state.connectionId;
        if (knownSessions.has(sessionId) || connectionId === undefined) return Effect.succeed(Effect.void);
        const ready = Deferred.makeUnsafe<void, WireError>();
        knownSessions.add(sessionId);
        sessionReady.set(sessionId, ready);
        return Effect.as(openStream(connectionId, sessionId, ready), Deferred.await(ready));
      });

    const postBody = (message: JsonRpcMessage, transport: Readonly<Record<string, string>>, failure: string) =>
      abortable(
        send(
          HttpClientRequest.post(url).pipe(HttpClientRequest.bodyText(JSON.stringify(message), jsonMime)),
          transport,
          failure,
        ).pipe(Effect.flatMap((response) => expectOk(response, failure))),
      );

    const postInitialize = (message: JsonRpcMessage): Effect.Effect<void, WireError> =>
      Effect.gen(function* () {
        if (!Predicate.isObject(message) || !isInitializeRequest(message)) {
          return yield* new WireError({ reason: "ACP HTTP stream first message must be initialize" });
        }
        const response = yield* postBody(message, {}, "ACP initialize failed");
        const connectionId = response.headers[connectionIdKey];
        if (connectionId === undefined || connectionId === "") {
          return yield* new WireError({ reason: "ACP initialize response missing Acp-Connection-Id" });
        }
        // Known from here, so that a failure below DELETEs the connection the agent opened.
        state.connectionId = connectionId;
        const body = yield* abortable(
          response.json.pipe(
            Effect.mapError((error) => new WireError({ reason: `ACP initialize failed: ${error.message}`, cause: error })),
          ),
        );
        if (!isResponse(body)) {
          return yield* new WireError({ reason: "ACP initialize response was not a JSON-RPC response" });
        }
        if (idKey(body.id) !== idKey(message["id"])) {
          return yield* new WireError({ reason: "ACP initialize response id did not match initialize request" });
        }
        yield* openStream(connectionId, undefined, undefined);
        yield* Queue.offer(inbound, WireInput.Json({ value: body }));
      }).pipe(Effect.tapError(failRead));

    const postConnected = (connectionId: string, message: JsonRpcMessage): Effect.Effect<void, WireError> =>
      Effect.gen(function* () {
        const responseKey = isResponse(message) ? idKey(message.id) : undefined;
        const sessionId =
          paramsSessionId(message) ?? (responseKey === undefined ? undefined : pendingResponseSessions.get(responseKey));
        if (sessionId !== undefined) yield* yield* openSession(sessionId);
        const requestKey = sessionId !== undefined && isRequest(message) ? idKey(message.id) : undefined;
        if (sessionId !== undefined && requestKey !== undefined) pendingSessionRequests.set(requestKey, sessionId);
        const transport: Record<string, string> = { [connectionIdKey]: connectionId };
        if (sessionId !== undefined) transport[sessionIdKey] = sessionId;
        yield* postBody(message, transport, "ACP POST failed").pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              if (requestKey !== undefined) pendingSessionRequests.delete(requestKey);
            }),
          ),
        );
        if (responseKey !== undefined) pendingResponseSessions.delete(responseKey);
      }).pipe(Effect.tapError(failRead));

    yield* Scope.addFinalizer(
      scope,
      Effect.suspend(() => {
        state.ended = true;
        return Deferred.succeed(closing, undefined).pipe(Effect.andThen(teardown), Effect.andThen(Queue.end(inbound)));
      }),
    );

    const write = (message: JsonRpcMessage | ReadonlyArray<JsonRpcMessage>): Effect.Effect<void, WireError> =>
      writeLock.withPermit(
        Effect.suspend(() => {
          if (state.ended) return Effect.fail(closedError());
          if (isBatch(message)) return Effect.fail(batchRefused());
          const connectionId = state.connectionId;
          return connectionId === undefined ? postInitialize(message) : postConnected(connectionId, message);
        }),
      );

    return { read: Stream.fromQueue(inbound), write } satisfies Wire;
  });
