/**
 * The spectator's HTTP server:
 *
 * | Route | What it does |
 * | --- | --- |
 * | `GET /` | The phone page (`page.html`). |
 * | `GET /events` | The match's state as server-sent events: the current state at once, then each change. A comment line every five seconds keeps the connection open while a turn is played. |
 * | `POST /begin` | Begins a game from `{ "engine": <label>, "adventurer": <label> }`: 200 when it started, 409 when one was running (the page then shows it), 400 with `error` and `hint` when it was refused. |
 */
import { Duration, Effect, Stream } from "effect";
import type { Begun, Match } from "./match.ts";

/** How long a connection that sends nothing stays open, in seconds; above the heartbeat's interval. */
const idleSeconds = 30;

const page = Bun.file(new URL("./page.html", import.meta.url));

/** The match's states as server-sent events, with a heartbeat comment between them. */
const events = (match: Match): Response => {
  const states = match.states.pipe(Stream.map((state) => `data: ${JSON.stringify(state)}\n\n`));
  const heartbeat = Stream.tick(Duration.seconds(5)).pipe(Stream.map(() => ": heartbeat\n\n"));
  return new Response(Stream.toReadableStream(Stream.encodeText(Stream.merge(states, heartbeat))), {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
};

/** The HTTP status of each way a Begin goes. */
const statuses: Readonly<Record<Begun["_tag"], number>> = { Started: 200, Running: 409, Refused: 400 };

const begin = async (match: Match, request: Request): Promise<Response> => {
  const body = (await request.json().catch(() => ({}))) as { readonly engine?: unknown; readonly adventurer?: unknown };
  const begun = await Effect.runPromise(match.begin(body.engine, body.adventurer));
  return Response.json(begun, { status: statuses[begun._tag] });
};

/**
 * The one address the spectator listens on, so that only this machine can open it. `localhost` would
 * name two addresses, `::1` and `127.0.0.1`, and Bun listens on whichever of them is free: a second
 * spectator would then start beside the first, on the other address, and a browser would reach the
 * first.
 */
export const hostname = "127.0.0.1";

/** Serves the spectator for `match` on `hostname` and `port` (0 for any free port). */
export const serve = (match: Match, port: number) =>
  Bun.serve({
    hostname,
    port,
    idleTimeout: idleSeconds,
    fetch: (request) => {
      const { pathname } = new URL(request.url);
      if (request.method === "GET" && pathname === "/") return new Response(page, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      if (request.method === "GET" && pathname === "/events") return events(match);
      if (request.method === "POST" && pathname === "/begin") return begin(match, request);
      return new Response("Not found.", { status: 404 });
    },
  });

/** Serves the spectator for `match` on `port`. When the port is in use, prints why and exits with status 1. */
export const listening = (match: Match, port: number): ReturnType<typeof serve> => {
  try {
    return serve(match, port);
  } catch (error) {
    if ((error as { readonly code?: unknown }).code !== "EADDRINUSE") throw error;
    console.error(`ERROR: ${hostname}:${port} is in use.\nHINT: Stop the spectator that is listening there, then start this one again.`);
    return process.exit(1);
  }
};
