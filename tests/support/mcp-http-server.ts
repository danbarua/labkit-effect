/**
 * The test MCP server (`mcp-fake.ts`) over HTTP, in the test's process (`Bun.serve`, a free port).
 *
 * - `http`: Streamable HTTP at `/mcp`. `initialize` starts a session (`Mcp-Session-Id`); any other
 *   message without one is 400, with one the server does not have 404. A request is answered on an
 *   SSE stream of its own (what the server asks during it, then its answer), or as one JSON message
 *   (`respond: "json"`), each stream primed with an event of an id and no data. A notification or a
 *   response is 202. GET opens the session's stream, for
 *   what the server sends unasked (kept until one is open), unless `getStream: false` (405). DELETE
 *   ends the session.
 * - `sse`: HTTP+SSE at `/sse`: the stream's first event is the endpoint (`endpoint`) messages are
 *   posted to; everything the server sends comes on the stream.
 *
 * With `auth`, every request needs `Authorization: Bearer <token>`, else 401, with a
 * `WWW-Authenticate` that points at OAuth's metadata when `oauth`; `setToken` changes it. `expire`
 * forgets every session;
 * `dropStreams` ends every stream (an HTTP+SSE session goes with its stream). Every request is kept
 * (`requests`): its method, path, and the MCP headers it carried.
 */

import { type Id, makeFake, type Message } from "./mcp-fake.ts";

export interface FakeHttpOptions {
  readonly transport: "http" | "sse";
  readonly respond?: "sse" | "json";
  readonly getStream?: boolean;
  readonly auth?: { readonly token: string; readonly oauth?: boolean };
  readonly noList?: boolean;
}

export interface SeenRequest {
  readonly method: string;
  readonly path: string;
  readonly session: string | null;
  readonly version: string | null;
  readonly accept: string | null;
  /** The JSON-RPC methods it carried; `response` for a response. */
  readonly carried: ReadonlyArray<string>;
}

export interface FakeHttpServer {
  /** The URL a client is given. */
  readonly url: string;
  readonly requests: ReadonlyArray<SeenRequest>;
  /** The sessions ended by DELETE. */
  readonly deleted: ReadonlyArray<string>;
  readonly expire: () => void;
  readonly dropStreams: () => void;
  /** The token `auth` takes from now on: the one a client has is revoked. */
  readonly setToken: (token: string) => void;
  /** Ends the response stream of every request not answered yet, without an answer. */
  readonly endRequestStreams: () => void;
  readonly stop: () => void;
}

type Stream = ReadableStreamDefaultController<Uint8Array>;

interface Session {
  handle: (message: Message) => void;
  /** The stream each request still waiting is answered on, by its id. */
  readonly streams: Map<string, Stream>;
  /** What a request answered as JSON waits for. */
  readonly waiting: Map<string, (message: unknown) => void>;
  /** The GET stream (`http`), or the session's stream (`sse`). */
  stream: Stream | undefined;
  /** What the server sent unasked before a GET stream was open. */
  readonly kept: Array<unknown>;
}

const encoder = new TextEncoder();
const event = (message: unknown, name?: string) => encoder.encode(`${name === undefined ? "" : `event: ${name}\n`}data: ${JSON.stringify(message)}\n\n`);

export const startFakeHttpServer = (options: FakeHttpOptions): FakeHttpServer => {
  let token = options.auth?.token;
  const sessions = new Map<string, Session>();
  const requests: Array<SeenRequest> = [];
  const deleted: Array<string> = [];
  let next = 0;

  const open = (onStream: (stream: Stream) => void, onCancel: () => void) =>
    new ReadableStream<Uint8Array>({
      start: onStream,
      cancel: onCancel,
    });

  const sessionOf = (send: (session: Session) => (message: unknown, request?: Id) => void): Session => {
    const session: Session = { handle: () => undefined, streams: new Map(), waiting: new Map(), stream: undefined, kept: [] };
    session.handle = makeFake((message, request) => send(session)(message, request), { noList: options.noList === true });
    return session;
  };

  /** Streamable HTTP: where a message the server sends goes. */
  const httpSend = (session: Session) => (message: unknown, request?: Id) => {
    const answers = typeof message === "object" && message !== null && !("method" in message) ? String((message as { id: Id }).id) : undefined;
    const key = answers ?? (request === undefined ? undefined : String(request));
    const waiting = key === undefined ? undefined : session.waiting.get(key);
    if (waiting !== undefined && answers !== undefined) return waiting(message);
    const stream = key === undefined ? undefined : session.streams.get(key);
    if (stream !== undefined) {
      stream.enqueue(event(message));
      if (answers !== undefined) {
        session.streams.delete(answers);
        stream.close();
      }
      return;
    }
    if (session.stream !== undefined) session.stream.enqueue(event(message));
    else session.kept.push(message);
  };

  const unauthorized = (origin: string) =>
    new Response("Unauthorized", {
      status: 401,
      headers: { "www-authenticate": options.auth?.oauth === true ? `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` : 'Bearer realm="fake"' },
    });

  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const body = request.method === "POST" ? ((await request.json()) as Message | ReadonlyArray<Message>) : undefined;
      const messages = body === undefined ? [] : Array.isArray(body) ? (body as ReadonlyArray<Message>) : [body as Message];
      requests.push({
        method: request.method,
        path: url.pathname,
        session: request.headers.get("mcp-session-id"),
        version: request.headers.get("mcp-protocol-version"),
        accept: request.headers.get("accept"),
        carried: messages.map((message) => message.method ?? "response"),
      });
      if (token !== undefined && request.headers.get("authorization") !== `Bearer ${token}`) return unauthorized(url.origin);

      if (options.transport === "sse") {
        if (request.method === "GET" && url.pathname === "/sse") {
          const id = `sse-${next++}`;
          const session = sessionOf((at) => (message) => at.stream?.enqueue(event(message, "message")));
          sessions.set(id, session);
          const stream = open(
            (controller) => {
              session.stream = controller;
              controller.enqueue(encoder.encode(`event: endpoint\ndata: /messages?sessionId=${id}\n\n`));
            },
            () => sessions.delete(id),
          );
          return new Response(stream, { headers: { "content-type": "text/event-stream" } });
        }
        if (request.method === "POST" && url.pathname === "/messages") {
          const session = sessions.get(url.searchParams.get("sessionId") ?? "");
          if (session === undefined) return new Response("No such session", { status: 404 });
          for (const message of messages) session.handle(message);
          return new Response(null, { status: 202 });
        }
        return new Response("Not found", { status: 404 });
      }

      if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });
      const given = request.headers.get("mcp-session-id");
      if (request.method === "POST" && messages.some((message) => message.method === "initialize")) {
        const id = `session-${next++}`;
        sessions.set(id, sessionOf(httpSend));
        return answer(sessions.get(id)!, messages, { "mcp-session-id": id });
      }
      if (given === null) return new Response("No session", { status: 400 });
      const session = sessions.get(given);
      if (session === undefined) return new Response("No such session", { status: 404 });
      if (request.method === "DELETE") {
        sessions.delete(given);
        deleted.push(given);
        return new Response(null, { status: 200 });
      }
      if (request.method === "GET") {
        if (options.getStream === false) return new Response(null, { status: 405, headers: { allow: "POST, DELETE" } });
        const stream = open(
          (controller) => {
            session.stream = controller;
            controller.enqueue(encoder.encode(`id: prime-${next++}\ndata:\n\n`));
            for (const message of session.kept.splice(0)) controller.enqueue(event(message));
          },
          () => {
            session.stream = undefined;
          },
        );
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      return answer(session, messages, {});
    },
  });

  /** A POST's answer: 202 for notifications and responses; each request's answer as JSON, or on a stream. */
  const answer = (session: Session, messages: ReadonlyArray<Message>, headers: Record<string, string>): Response | Promise<Response> => {
    const asking = messages.filter((message) => message.method !== undefined && message.id !== undefined);
    if (asking.length === 0) {
      for (const message of messages) session.handle(message);
      return new Response(null, { status: 202, headers });
    }
    if (options.respond === "json") {
      const answered = Promise.all(asking.map((message) => new Promise<unknown>((resolve) => session.waiting.set(String(message.id), resolve))));
      for (const message of messages) session.handle(message);
      return answered.then((all) => Response.json(all.length === 1 ? all[0] : all, { headers }));
    }
    const stream = open(
      (controller) => {
        // A stream is primed with an event of an id and no data, as the 2025-11-25 spec says a server should.
        controller.enqueue(encoder.encode(`id: prime-${next++}\ndata:\n\n`));
        for (const message of asking) session.streams.set(String(message.id), controller);
        for (const message of messages) session.handle(message);
      },
      () => {
        for (const message of asking) session.streams.delete(String(message.id));
      },
    );
    return new Response(stream, { headers: { ...headers, "content-type": "text/event-stream" } });
  };

  return {
    url: `http://localhost:${server.port}${options.transport === "sse" ? "/sse" : "/mcp"}`,
    requests,
    deleted,
    expire: () => sessions.clear(),
    setToken: (next) => {
      token = next;
    },
    endRequestStreams: () => {
      for (const session of sessions.values()) {
        for (const stream of new Set(session.streams.values())) stream.close();
        session.streams.clear();
      }
    },
    dropStreams: () => {
      for (const [id, session] of sessions) {
        try {
          session.stream?.close();
        } catch {
          // Closed already.
        }
        session.stream = undefined;
        if (options.transport === "sse") sessions.delete(id);
      }
    },
    stop: () => void server.stop(true),
  };
};
