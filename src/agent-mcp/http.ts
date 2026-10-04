/**
 * The wire to an MCP server reached at a URL (`McpServerRemote`).
 *
 * Streamable HTTP (`http`): each message is a POST to the server's URL. The server answers `202`
 * (a notification or a response, taken), one JSON message, or an SSE stream of messages: its own
 * requests and notifications, then its answer. Once the server has answered `initialize`, every
 * message carries the session it gave (`Mcp-Session-Id`) and the version agreed
 * (`MCP-Protocol-Version`). A GET stream carries what the server sends unasked, when it offers one
 * (`405`: it does not); it is opened again a second after it ends. When the wire's scope closes,
 * the session is ended (DELETE).
 *
 * HTTP+SSE (`sse`, protocol 2024-11-05): a GET stream whose `endpoint` event gives the URL messages
 * are posted to; every message from the server comes on the stream. The wire ends when the stream
 * does.
 *
 * `write` sends a request and returns: the answer comes on `read`. A notification or a response is
 * written once the server has taken it, so the messages the client sends arrive in order. A request
 * the endpoint refuses (an HTTP error, or the server not reached) is answered on `read` with a
 * JSON-RPC error carrying what HTTP said (`HttpRejection`, `rejectionOf`); one whose stream ends
 * before the answer is answered with an error saying so. The headers configured go with every
 * request, and are never logged.
 */

import { Array as Arr, Data, Deferred, Effect, HashSet, Queue, Ref, Scope, Stream } from "effect";
import type { Cause } from "effect";
import type { McpSchema } from "effect/ai";
import * as Sse from "effect/encoding/Sse";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import { type JsonRpcId, JsonRpcError, type JsonRpcMessage, type Wire, WireInput } from "effective-acp/json-rpc";
import { type ClientInfo, connectOver, type McpConnection, McpFailed, type Root } from "./client.ts";
import { logKeys } from "./log-keys.ts";

/** A server reached at a URL: over Streamable HTTP, or over HTTP+SSE. */
export interface McpServerRemote {
  readonly name: string;
  readonly transport: "http" | "sse";
  readonly url: string;
  /** Sent with every request: a credential among them, as a rule. Never logged. */
  readonly headers: Readonly<Record<string, string>>;
}

/** What HTTP said of a request the endpoint refused. */
export interface HttpRejection {
  /** The response's status; 0 when the server was not reached. */
  readonly status: number;
  /** The `WWW-Authenticate` header the server answered with, if any. */
  readonly authenticate?: string | undefined;
  /** A 404 to a message that carried a session: the server no longer has the session. */
  readonly sessionExpired: boolean;
  /** The start of the response's body, or why the server was not reached. */
  readonly said: string;
}

/** The JSON-RPC error code of a request the endpoint refused (`HttpRejection` in its data). */
const refusedCode = -32001;
/** The JSON-RPC error code of a request whose response stream ended before its answer. */
const unansweredCode = -32002;

/** What HTTP said of a request that failed because the endpoint refused it, if that is why. */
export const rejectionOf = (error: unknown): HttpRejection | undefined => {
  const cause = error instanceof McpFailed ? error.cause : error;
  if (!(cause instanceof JsonRpcError) || cause.code !== refusedCode) return undefined;
  return (cause.data as { readonly http?: HttpRejection } | undefined)?.http;
};

/** The wire to a remote server, and what it is to be told once the server has answered `initialize`. */
export interface RemoteWire {
  readonly wire: Wire;
  readonly initialized: (result: McpSchema.InitializeResult) => Effect.Effect<void>;
}

/** The connection could not be made before `initialize`: the HTTP+SSE stream was refused or did not give its endpoint. */
export class RemoteRefused extends Data.TaggedError("RemoteRefused")<{ readonly rejection: HttpRejection }> {}

/** How many characters of a refusing response's body are kept. */
const saidLimit = 2000;

const requestIdsOf = (message: JsonRpcMessage | ReadonlyArray<JsonRpcMessage>): ReadonlyArray<JsonRpcId> =>
  (Array.isArray(message) ? message : [message]).flatMap((each) => ("method" in each && "id" in each && each.id !== undefined && each.id !== null ? [each.id] : []));

const methodsOf = (message: JsonRpcMessage | ReadonlyArray<JsonRpcMessage>): ReadonlyArray<string> =>
  (Array.isArray(message) ? message : [message]).map((each) => ("method" in each ? each.method : "response"));

/** The id a message from the server answers, if it is a response. */
const answeredBy = (value: unknown): JsonRpcId | undefined =>
  typeof value === "object" && value !== null && !("method" in value) && "id" in value ? (value.id as JsonRpcId) : undefined;

/** The ids the responses in `input` answer. */
const answeredIn = (input: WireInput): HashSet.HashSet<JsonRpcId> => {
  if (input._tag !== "Json") return HashSet.empty();
  const values: ReadonlyArray<unknown> = Array.isArray(input.value) ? input.value : [input.value];
  return HashSet.fromIterable(
    values.flatMap((each) => {
      const id = answeredBy(each);
      return id === undefined ? [] : [id];
    }),
  );
};

/** A URL as the log says it: its origin and path, without a query, which may hold a credential. */
export const whereOf = (url: string): string => {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "(not a URL)";
  }
};

/** What an error says: its message, or itself as JSON. */
const textOf = (error: unknown): string => (error instanceof Error ? error.message : JSON.stringify(error));

const parsed = (text: string): WireInput => {
  try {
    return WireInput.Json({ value: JSON.parse(text) });
  } catch {
    return WireInput.Unparsable({ text });
  }
};

/**
 * The events of an SSE stream that carry data. A server primes a stream with an event of an id and
 * no data (so that a client can resume it): it carries no message.
 */
const eventsOf = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.pipeThroughChannel(Sse.decode()),
    Stream.filter((event) => event.data !== ""),
  );

/** The parts both transports share: the inbox `read` gives, and how a message the endpoint took or refused is answered. */
const makeInbox = (server: McpServerRemote) =>
  Effect.gen(function* () {
    const inbox = yield* Queue.unbounded<WireInput, Cause.Done>();
    yield* Effect.addFinalizer(() => Queue.end(inbox));
    const deliver = (input: WireInput) => Queue.offer(inbox, input).pipe(Effect.asVoid);
    /** Answers each request in `message` with the endpoint's refusal. */
    const refused = (message: JsonRpcMessage | ReadonlyArray<JsonRpcMessage>, rejection: HttpRejection) =>
      Effect.gen(function* () {
        yield* Effect.logWarning(logKeys.http.refused, { server: server.name, url: whereOf(server.url), methods: methodsOf(message), ...rejection });
        const text = rejection.status === 0 ? rejection.said : `HTTP ${rejection.status}${rejection.sessionExpired ? " (the session has ended)" : ""}: ${rejection.said}`;
        yield* Effect.forEach(
          requestIdsOf(message),
          (id) => deliver(WireInput.Json({ value: { jsonrpc: "2.0", id, error: { code: refusedCode, message: text, data: { http: rejection } } } })),
          { discard: true },
        );
      });
    /** Delivers each message of a response; a request it carried that is not answered by its end is answered with an error. */
    const answers = (message: JsonRpcMessage | ReadonlyArray<JsonRpcMessage>, messages: Stream.Stream<string, unknown>) =>
      Effect.gen(function* () {
        const answered = yield* Ref.make(HashSet.empty<JsonRpcId>());
        const ended = yield* messages.pipe(
          Stream.runForEach((text) => {
            const input = parsed(text);
            return Ref.update(answered, HashSet.union(answeredIn(input))).pipe(Effect.andThen(deliver(input)));
          }),
          Effect.as("ended"),
          Effect.catch((error) => Effect.succeed(textOf(error))),
        );
        const waiting = yield* Effect.map(Ref.get(answered), (ids) => Arr.dedupe(requestIdsOf(message)).filter((id) => !HashSet.has(ids, id)));
        yield* Effect.forEach(
          waiting,
          (id) =>
            deliver(
              WireInput.Json({
                value: { jsonrpc: "2.0", id, error: { code: unansweredCode, message: ended === "ended" ? "The server's response ended before its answer" : `The server's response broke off before its answer: ${ended}` } },
              }),
            ),
          { discard: true },
        );
      });
    return { inbox, deliver, refused, answers };
  });

/** What a refusing response says, read from it. */
const rejectionFrom = (response: HttpClientResponse.HttpClientResponse, withSession: boolean): Effect.Effect<HttpRejection> =>
  Effect.map(
    Effect.catch(response.text, (error) => Effect.succeed(`(its body could not be read: ${error.message})`)),
    (body) => ({
      status: response.status,
      authenticate: response.headers["www-authenticate"],
      sessionExpired: withSession && response.status === 404,
      said: body.slice(0, saidLimit),
    }),
  );

const unreached = (error: { readonly message: string }): HttpRejection => ({ status: 0, sessionExpired: false, said: `the server could not be reached: ${error.message}` });

/** The messages a response carries: an SSE stream's events, or one JSON message. */
const messagesOf = (response: HttpClientResponse.HttpClientResponse): Stream.Stream<string, unknown> =>
  (response.headers["content-type"] ?? "").startsWith("text/event-stream")
    ? eventsOf(response.stream).pipe(Stream.map((event) => event.data))
    : Stream.fromEffect(response.text);

const streamableHttp = (server: McpServerRemote): Effect.Effect<RemoteWire, never, Scope.Scope | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const scope = yield* Scope.Scope;
    const http = yield* HttpClient.HttpClient;
    // A request lives as long as the wire: its stream is cut when the wire's scope closes.
    const execute = (request: HttpClientRequest.HttpClientRequest) => HttpClient.withScope(http).execute(request).pipe(Scope.provide(scope));
    const { inbox, deliver, refused, answers } = yield* makeInbox(server);
    const session = yield* Ref.make<string | undefined>(undefined);
    const version = yield* Ref.make<string | undefined>(undefined);
    /** The headers a message carries, and the session among them, if there is one. */
    const headersOf = (accept: string): Effect.Effect<{ readonly headers: Readonly<Record<string, string>>; readonly session: string | undefined }> =>
      Effect.map(Effect.all([Ref.get(session), Ref.get(version)]), ([session, version]) => ({
        session,
        headers: {
          ...server.headers,
          accept,
          ...(session === undefined ? {} : { "mcp-session-id": session }),
          ...(version === undefined ? {} : { "mcp-protocol-version": version }),
        },
      }));

    const post = (message: JsonRpcMessage | ReadonlyArray<JsonRpcMessage>) =>
      Effect.gen(function* () {
        const { headers, session: sent } = yield* headersOf("application/json, text/event-stream");
        const withSession = sent !== undefined;
        const response = yield* execute(
          HttpClientRequest.post(server.url).pipe(
            HttpClientRequest.setHeaders(headers),
            HttpClientRequest.bodyText(JSON.stringify(message), "application/json"),
          ),
        );
        // The session is the one the server gave in answer to `initialize`.
        const given = response.headers["mcp-session-id"];
        const changed = yield* Ref.modify(session, (current) => (given !== undefined && given !== current ? [true, given] : [false, current]));
        if (changed) yield* Effect.logInfo(logKeys.http.session, { server: server.name, url: whereOf(server.url) });
        if (response.status >= 400) return yield* refused(message, yield* rejectionFrom(response, withSession));
        if (response.status === 202 || response.status === 204) return;
        // An SSE stream may run long: it is read in the background, so the next message need not wait.
        yield* Effect.forkIn(answers(message, messagesOf(response)), scope);
      }).pipe(Effect.catch((error) => refused(message, unreached(error))));

    /** Reads the GET stream until it ends; whether to open it again. */
    const listen = Effect.gen(function* () {
      const response = yield* execute(HttpClientRequest.get(server.url).pipe(HttpClientRequest.setHeaders((yield* headersOf("text/event-stream")).headers)));
      if (response.status === 405) {
        yield* Effect.logInfo(logKeys.http.noStream, { server: server.name, url: whereOf(server.url) });
        return false;
      }
      if (response.status >= 400) {
        yield* Effect.logWarning(logKeys.http.streamRefused, { server: server.name, url: whereOf(server.url), ...(yield* rejectionFrom(response, true)) });
        return false;
      }
      yield* eventsOf(response.stream).pipe(Stream.runForEach((event) => deliver(parsed(event.data))));
      yield* Effect.logInfo(logKeys.http.streamEnded, { server: server.name, url: whereOf(server.url) });
      return true;
    }).pipe(Effect.catch((error) => Effect.logWarning(logKeys.http.streamBroke, { server: server.name, url: whereOf(server.url), cause: textOf(error) }).pipe(Effect.as(false))));

    yield* Effect.addFinalizer(() =>
      Effect.flatMap(headersOf("application/json"), ({ headers, session }) =>
        session !== undefined
          ? http.execute(HttpClientRequest.make("DELETE")(server.url).pipe(HttpClientRequest.setHeaders(headers))).pipe(
              Effect.timeout("2 seconds"),
              Effect.flatMap((response) =>
                response.status < 400 ? Effect.void : Effect.logWarning(logKeys.http.notEnded, { server: server.name, url: whereOf(server.url), status: response.status }),
              ),
              Effect.catch((error) => Effect.logWarning(logKeys.http.notEnded, { server: server.name, url: whereOf(server.url), cause: textOf(error) })),
            )
          : Effect.void,
      ),
    );

    const wire: Wire = {
      read: Stream.fromQueue(inbox),
      // A request is sent in the background; a notification or a response once the server has taken it, so the next follows it.
      write: (message) => (requestIdsOf(message).length > 0 ? Effect.asVoid(Effect.forkIn(post(message), scope)) : post(message)),
    };
    return {
      wire,
      initialized: (result) =>
        Effect.gen(function* () {
          yield* Ref.set(version, result.protocolVersion);
          yield* listen.pipe(
            Effect.flatMap((again) => (again ? Effect.sleep("1 second").pipe(Effect.as(true)) : Effect.succeed(false))),
            Effect.repeat({ while: (again) => again }),
            Effect.forkIn(scope),
          );
        }),
    };
  });

const httpSse = (server: McpServerRemote): Effect.Effect<RemoteWire, RemoteRefused, Scope.Scope | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const scope = yield* Scope.Scope;
    const http = yield* HttpClient.HttpClient;
    const execute = (request: HttpClientRequest.HttpClientRequest) => HttpClient.withScope(http).execute(request).pipe(Scope.provide(scope));
    const { inbox, deliver, refused, answers } = yield* makeInbox(server);
    const headersOf = (accept: string) => ({ ...server.headers, accept });

    const stream = yield* execute(HttpClientRequest.get(server.url).pipe(HttpClientRequest.setHeaders(headersOf("text/event-stream")))).pipe(
      Effect.mapError((error) => new RemoteRefused({ rejection: unreached(error) })),
    );
    if (stream.status >= 400) return yield* new RemoteRefused({ rejection: yield* rejectionFrom(stream, false) });
    const endpoint = yield* Deferred.make<string>();
    yield* eventsOf(stream.stream).pipe(
      Stream.runForEach((event) =>
        event.event === "endpoint" ? Deferred.succeed(endpoint, new URL(event.data, server.url).href).pipe(Effect.asVoid) : deliver(parsed(event.data)),
      ),
      Effect.catch((error) => Effect.logWarning(logKeys.http.streamBroke, { server: server.name, url: whereOf(server.url), cause: textOf(error) })),
      Effect.andThen(Effect.logInfo(logKeys.http.streamEnded, { server: server.name, url: whereOf(server.url) })),
      // The stream is the connection: when it ends, the wire does.
      Effect.ensuring(Queue.end(inbox)),
      Effect.forkIn(scope),
    );
    const posted = yield* Deferred.await(endpoint);

    const post = (message: JsonRpcMessage | ReadonlyArray<JsonRpcMessage>) =>
      Effect.gen(function* () {
        const response = yield* execute(
          HttpClientRequest.post(posted).pipe(HttpClientRequest.setHeaders(headersOf("application/json")), HttpClientRequest.bodyText(JSON.stringify(message), "application/json")),
        );
        // The endpoint's URL carries the session: a 404 there is the session ended.
        if (response.status >= 400) return yield* refused(message, yield* rejectionFrom(response, true));
        // The answers come on the stream; a body, if the server sends one, is read as messages too.
        if (response.status !== 202 && response.status !== 204) yield* Effect.forkIn(answers([], messagesOf(response).pipe(Stream.filter((text) => text.trim() !== ""))), scope);
      }).pipe(Effect.catch((error) => refused(message, unreached(error))));

    return {
      wire: {
        read: Stream.fromQueue(inbox),
        write: (message) => (requestIdsOf(message).length > 0 ? Effect.asVoid(Effect.forkIn(post(message), scope)) : post(message)),
      },
      initialized: () => Effect.void,
    };
  });

/** The wire to `server`, in the scope given: it lives as long as the scope. */
export const remoteWire = (server: McpServerRemote): Effect.Effect<RemoteWire, RemoteRefused, Scope.Scope> =>
  (server.transport === "http" ? streamableHttp(server) : httpSse(server)).pipe(Effect.provide(FetchHttpClient.layer));

/** Connects to `server` over its wire, in the scope given (`client.ts` `connectOver`); `roots` are what it is told when it asks. */
export const connectRemote = (server: McpServerRemote, roots: ReadonlyArray<Root>, clientInfo?: ClientInfo): Effect.Effect<McpConnection, McpFailed | RemoteRefused, Scope.Scope> =>
  Effect.flatMap(remoteWire(server), (remote) => connectOver(server.name, remote.wire, roots, clientInfo, remote.initialized));
