/**
 * Failures VidaiMock cannot play, since it always answers whole: a provider that cannot be reached,
 * and a response whose body does not arrive whole. The others (HTTP statuses, retries) are tested
 * against it in `vidaimock.test.ts`.
 */

import { userInput } from "../../../tests/support/observations.ts";
import { afterAll, expect } from "bun:test";
import { test } from "../../../tests/support/test.ts";
import { OpenAiClient as OpenAiCompatClient } from "@effect/ai-openai-compat";
import { Effect, Fiber, Layer, Logger, Redacted } from "effect";
import { TestClock } from "effect/testing";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { ModelName, ProviderName, TurnId } from "../../agent-machine/names.ts";
import { ModelClient } from "../contracts.ts";
import { conversationOf } from "../conversation.ts";
import { openSession } from "../loop.ts";
import { EphemeralSessionStore } from "../session-store.ts";
import { TurnContextAssembler } from "../turn-context.ts";
import { CountingTurns } from "../turns.ts";
import { BoringModelProvider, boringOpening } from "../../../tests/support/boring.ts";
import { SmolToolRunner, smolCatalog } from "../../../tests/support/smol-tools.ts";
import { logKeys } from "../log-keys.ts";
import { anthropicModelClient } from "./anthropic-client.ts";
import { openAiModelClient } from "./openai-client.ts";
import { openAiCompatModelClient } from "./openai-compat-client.ts";
import { ModelStreamIdle } from "../provider-call.ts";
import { anthropicAt, openAiAt, openAiCompatAt } from "../../../tests/support/providers.ts";
import { runTest } from "../../../tests/support/run.ts";

test("a provider that cannot be reached fails as a network error, retried first", async () => {
  // Port 1 on this machine has no server: the connection is refused. (A port freed by a server the
  // test stopped can be taken by another test's server meanwhile, which answers.)
  const url = new URL("http://127.0.0.1:1/");
  const logged: Array<unknown> = [];
  const observed = await runTest(
    Effect.gen(function* () {
      return yield* (yield* ModelClient).respond(
        { provider: ProviderName.make("anthropic"), model: ModelName.make("claude-sonnet-5") },
        { system: undefined, tools: [], messages: [{ role: "user", parts: [{ _tag: "Text", text: "hi" }] }] },
        TurnId.make("turn-1"),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          anthropicModelClient({ times: 2, firstWait: "1 millis" }).pipe(Layer.provide(anthropicAt(url))),
          Logger.layer([Logger.make((options) => logged.push(options.message))], { mergeWithExisting: true }),
        ),
      ),
    ),
  );
  const events = (key: string) => logged.filter((message) => Array.isArray(message) && message[0] === key);
  expect(observed).toMatchObject({ _tag: "ModelFailed" });
  expect(events(logKeys.provider.requestFailed)).toMatchObject([[logKeys.provider.requestFailed, { reason: "NetworkError" }]]);
  expect(events(logKeys.provider.requestRetried)).toHaveLength(2);
  // Each retry is logged before its wait: the first wait, then twice it.
  expect(events(logKeys.provider.requestRetried).map((line) => (line as [string, { retry: number; of: number; wait: string }])[1])).toMatchObject([
    { retry: 1, of: 2, wait: "1ms" },
    { retry: 2, of: 2, wait: "2ms" },
  ]);
});

/**
 * A server that writes each response as raw HTTP and closes the connection: the n-th request gets
 * `answers[n]`, or the last one.
 */
const stops: Array<() => unknown> = [];
afterAll(() => {
  for (const stop of stops) stop();
});

function rawServer(answers: ReadonlyArray<string>) {
  let requests = 0;
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket) {
        socket.write(answers[Math.min(requests++, answers.length - 1)] ?? "");
        socket.end();
      },
    },
  });
  return { url: new URL(`http://127.0.0.1:${server.port}`), requests: () => requests, stop: () => server.stop(true) };
}

const asked = (client: Layer.Layer<ModelClient>, provider = "boring") => {
  const logged: Array<unknown> = [];
  return runTest(
    Effect.gen(function* () {
      return yield* (yield* ModelClient).respond(
        { provider: ProviderName.make(provider), model: ModelName.make("boring-1") },
        { system: undefined, tools: [], messages: [{ role: "user", parts: [{ _tag: "Text", text: "hi" }] }] },
        TurnId.make("turn-1"),
      );
    }).pipe(Effect.provide(Layer.mergeAll(client, Logger.layer([Logger.make((options) => logged.push(options.message))], { mergeWithExisting: true })))),
  ).then((observed) => ({
    observed,
    events: (key: string) => logged.filter((message) => Array.isArray(message) && message[0] === key),
  }));
};

/**
 * A Chat Completions client served in this process: the n-th request gets `responses[n]()`, or the
 * last one. `requests` counts the requests made.
 */
const servedInProcess = (responses: ReadonlyArray<() => Response>) => {
  let requests = 0;
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const respond = responses[Math.min(requests, responses.length - 1)];
        requests += 1;
        return HttpClientResponse.fromWeb(request, respond === undefined ? new Response(null, { status: 500 }) : respond());
      }),
    ),
  );
  return {
    client: openAiCompatModelClient({ times: 2, firstWait: "1 millis" }).pipe(
      Layer.provide(OpenAiCompatClient.layer({ apiUrl: "http://127.0.0.1", apiKey: Redacted.make("test-key") }).pipe(Layer.provide(http))),
    ),
    requests: () => requests,
  };
};

/**
 * A response body that the test writes. `written(text)` writes `text` and resolves once the reader
 * has asked for more: the reader has taken `text`, so a test clock moved after it counts from then.
 * `write(text)` writes `text` without waiting, for what the reader may not read past (`[DONE]`).
 */
const writtenBody = () => {
  const encoder = new TextEncoder();
  const waiting: Array<() => void> = [];
  let reads = 0;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>(
    {
      start: (made) => {
        controller = made;
      },
      pull: () => {
        reads += 1;
        for (const resolve of waiting.splice(0)) resolve();
      },
    },
    { highWaterMark: 0 },
  );
  const readAfter = (before: number): Promise<void> =>
    reads > before ? Promise.resolve() : new Promise<void>((resolve) => waiting.push(resolve)).then(() => readAfter(before));
  return {
    response: () => new Response(stream, { headers: { "content-type": "text/event-stream" } }),
    written: (text: string) =>
      Effect.promise(() => {
        const before = reads;
        controller?.enqueue(encoder.encode(text));
        return readAfter(before);
      }),
    write: (text: string) => Effect.sync(() => controller?.enqueue(encoder.encode(text))),
    end: Effect.sync(() => controller?.close()),
  };
};

/** Asks a model through `client` on a test clock while `script` runs: the script writes what is served and moves the clock. */
const askedWhile = <E>(client: Layer.Layer<ModelClient>, script: (events: (key: string) => ReadonlyArray<unknown>) => Effect.Effect<void, E>) => {
  const logged: Array<unknown> = [];
  const events = (key: string) => logged.filter((message) => Array.isArray(message) && message[0] === key);
  return runTest(
    Effect.gen(function* () {
      const asking = yield* Effect.forkChild(
        (yield* ModelClient).respond(
          { provider: ProviderName.make("boring"), model: ModelName.make("boring-1") },
          { system: undefined, tools: [], messages: [{ role: "user", parts: [{ _tag: "Text", text: "hi" }] }] },
          TurnId.make("turn-1"),
        ),
      );
      yield* script(events);
      return yield* Fiber.join(asking);
    }).pipe(Effect.provide(Layer.mergeAll(client, TestClock.layer(), Logger.layer([Logger.make((options) => logged.push(options.message))], { mergeWithExisting: true })))),
  ).then((observed) => ({ observed, events }));
};

/** Yields until `holds` is true, at most 1000 times. */
const until = (holds: () => boolean) => Effect.gen(function* () {
  for (let tries = 0; !holds() && tries < 1000; tries++) yield* Effect.yieldNow;
});

const answer = JSON.stringify({ id: "chatcmpl-1", choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }] });
const jsonWith = (body: string, length: number) =>
  `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${length}\r\n\r\n${body}`;

test("a body that ends before its Content-Length fails the request, which is not made again: the provider had begun to respond", async () => {
  const server = rawServer([jsonWith(answer.slice(0, 40), answer.length), jsonWith(answer, answer.length)]);
  const { observed, events } = await asked(
    openAiCompatModelClient({ times: 2, firstWait: "1 millis" }).pipe(Layer.provide(openAiCompatAt(server.url))),
  );
  server.stop();
  expect(observed as unknown).toMatchObject({ _tag: "ModelFailed" });
  expect(server.requests()).toBe(1);
  expect(events(logKeys.provider.requestRetried)).toEqual([]);
  expect(events(logKeys.provider.notRetried)).toMatchObject([[logKeys.provider.notRetried, { reason: "NetworkError" }]]);
});

test("a rate limit is retried after the wait it says (Retry-After), not the doubled wait", async () => {
  const served = servedInProcess([
    () => new Response("{}", { status: 429, headers: { "content-type": "application/json", "retry-after": "1" } }),
    () => new Response(answer, { headers: { "content-type": "application/json" } }),
  ]);
  const requestsAt999ms: Array<number> = [];
  const { observed, events } = await askedWhile(served.client, (events) =>
    Effect.gen(function* () {
      // The retry is logged before its wait.
      yield* until(() => events(logKeys.provider.requestRetried).length === 1);
      yield* TestClock.adjust("999 millis");
      requestsAt999ms.push(served.requests());
      yield* TestClock.adjust("1 millis");
    }),
  );
  expect(requestsAt999ms).toEqual([1]);
  expect(served.requests()).toBe(2);
  expect(observed as unknown).toMatchObject({ _tag: "ModelResponded" });
  expect(events(logKeys.provider.requestRetried)).toMatchObject([[logKeys.provider.requestRetried, { reason: "RateLimitError", retry: 1, wait: "1s" }]]);
});

test("a rate limit whose wait is longer than the longest to wait out (a usage window) fails at once, with its wait, and is not retried", async () => {
  const window = "HTTP/1.1 429 Too Many Requests\r\ncontent-type: application/json\r\nretry-after: 18000\r\ncontent-length: 2\r\n\r\n{}";
  const server = rawServer([window, jsonWith(answer, answer.length)]);
  const { observed, events } = await asked(
    openAiCompatModelClient({ times: 2, firstWait: "1 millis" }).pipe(Layer.provide(openAiCompatAt(server.url))),
  );
  server.stop();
  expect(server.requests()).toBe(1);
  expect(observed as unknown).toMatchObject({ _tag: "ModelFailed", failure: expect.stringContaining("Retry after 5h") });
  expect(events(logKeys.provider.requestRetried)).toEqual([]);
  expect(events(logKeys.provider.notRetried)).toMatchObject([
    [logKeys.provider.notRetried, { reason: "RateLimitError", why: "the rate limit's wait, 5h, is longer than 1m" }],
  ]);
});

test("a failure before the provider begins to respond is retried", async () => {
  const unavailable = "HTTP/1.1 503 Service Unavailable\r\ncontent-type: text/plain\r\ncontent-length: 4\r\n\r\nbusy";
  const server = rawServer([unavailable, jsonWith(answer, answer.length)]);
  const { observed, events } = await asked(
    openAiCompatModelClient({ times: 2, firstWait: "1 millis" }).pipe(Layer.provide(openAiCompatAt(server.url))),
  );
  server.stop();
  expect(observed).toMatchObject({ _tag: "ModelResponded", parts: [{ _tag: "Text", text: "hi" }] });
  expect(server.requests()).toBe(2);
  expect(events(logKeys.provider.requestRetried)).toHaveLength(1);
});

test("a stream closed before its last chunk fails the request, which is not made again", async () => {
  const completed = { type: "response.completed", response: { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] }] } };
  const event = `data: ${JSON.stringify(completed)}\n\n`;
  const chunk = (text: string) => `${Buffer.byteLength(text).toString(16)}\r\n${text}\r\n`;
  const head = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n";
  const server = rawServer([`${head}${chunk(event.slice(0, 30))}`, `${head}${chunk(event)}0\r\n\r\n`]);
  const { observed, events } = await asked(openAiModelClient({ times: 2, firstWait: "1 millis" }).pipe(Layer.provide(openAiAt(server.url))));
  server.stop();
  expect(observed as unknown).toMatchObject({ _tag: "ModelFailed" });
  expect(server.requests()).toBe(1);
  expect(events(logKeys.provider.notRetried)).toMatchObject([[logKeys.provider.notRetried, { reason: "NetworkError" }]]);
});

test("a body handed over whole whose size is not its Content-Length fails as a transport error; an encoded body is not compared", async () => {
  // Bun's fetch fails a body cut short itself; a client that hands one over is checked here.
  const handingOver = (headers: Record<string, string>) =>
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, new Response(answer, { headers })))),
    );
  const client = (headers: Record<string, string>) =>
    openAiCompatModelClient({ times: 0, firstWait: "1 millis" }).pipe(
      Layer.provide(OpenAiCompatClient.layer({ apiUrl: "http://127.0.0.1", apiKey: Redacted.make("test-key") }).pipe(Layer.provide(handingOver(headers)))),
    );
  const short = await asked(client({ "content-type": "application/json", "content-length": String(answer.length + 10) }));
  expect(short.observed as unknown).toMatchObject({ _tag: "ModelFailed" });
  expect(short.events(logKeys.provider.requestFailed)).toMatchObject([[logKeys.provider.requestFailed, { reason: "NetworkError", retryable: true }]]);
  const encoded = await asked(client({ "content-type": "application/json", "content-encoding": "gzip", "content-length": "7" }));
  expect(encoded.observed).toMatchObject({ _tag: "ModelResponded" });
});

test("a stream closed after a tool call of it was passed on is not made again: the tool has run once, the turn fails, and the call is not sent to the model", async () => {
  const call = { type: "function_call", call_id: "call_1", name: "add", arguments: '{"a":2,"b":3}', status: "completed" };
  const event = `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: call })}\n\n`;
  const opened = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n";
  let requests = 0;
  // The call's event arrives; the connection closes, before the stream's last chunk, once the loop has had time to run it.
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket) {
        requests++;
        socket.write(`${opened}${Buffer.byteLength(event).toString(16)}\r\n${event}\r\n`);
        setTimeout(() => socket.end(), 300);
      },
    },
  });
  stops.push(() => server.stop(true));
  const facts = await runTest(
    Effect.gen(function* () {
      const session = yield* openSession.pipe(Effect.provide(EphemeralSessionStore));
      yield* session.observe(boringOpening(smolCatalog));
      yield* session.observe(userInput("What is 2 + 3?"));
      yield* session.idle;
      return yield* session.facts;
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          BoringModelProvider,
          TurnContextAssembler,
          openAiModelClient({ times: 2, firstWait: "1 millis" }).pipe(Layer.provide(openAiAt(new URL(`http://127.0.0.1:${server.port}`)))),
          CountingTurns,
          SmolToolRunner,
        ),
      ),
    ),
  );
  const tags = facts.map((fact) => (fact._tag === "Observed" ? fact.observation._tag : fact.decision._tag));
  expect(requests).toBe(1);
  expect(tags.filter((tag) => tag === "ToolEnded")).toHaveLength(1);
  expect(facts.some((fact) => fact._tag === "Observed" && fact.observation._tag === "ModelFailed")).toBe(true);
  expect(facts.at(-1) as unknown).toMatchObject({ decision: { _tag: "TurnEnded", ending: { _tag: "Failed" } } });
  expect(conversationOf(facts).flatMap((message) => message.parts.map((part) => part._tag))).toEqual(["Text"]);
});

const chunk = (delta: unknown, finish_reason: string | null = null) => `data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;

test("a stream that sends nothing for ModelStreamIdle fails the request, which is not made again; keep-alive comments count as something", async () => {
  const idle = Layer.succeed(ModelStreamIdle, "100 millis");
  const quiet = writtenBody();
  const silentServer = servedInProcess([quiet.response]);
  const silent = await askedWhile(Layer.mergeAll(silentServer.client, idle), () =>
    Effect.gen(function* () {
      yield* quiet.written(chunk({ role: "assistant", content: "Hal" }));
      yield* TestClock.adjust("100 millis");
    }),
  );
  expect(silent.observed as unknown).toMatchObject({ _tag: "ModelFailed", failure: expect.stringContaining("sent nothing for 100ms") });
  expect(silent.events(logKeys.provider.notRetried)).toHaveLength(1);
  expect(silentServer.requests()).toBe(1);

  // Keep-alive comments 60 ms apart for 420 ms: without them the stream would be quiet for longer than 100 ms.
  const kept = writtenBody();
  const keptServer = servedInProcess([kept.response]);
  const alive = await askedWhile(Layer.mergeAll(keptServer.client, idle), () =>
    Effect.gen(function* () {
      yield* kept.written(chunk({ role: "assistant", content: "Hal" }));
      yield* Effect.forEach([1, 2, 3, 4, 5, 6], () => TestClock.adjust("60 millis").pipe(Effect.andThen(kept.written(": keepalive\n\n"))), { discard: true });
      yield* TestClock.adjust("60 millis");
      yield* kept.written(chunk({ content: "lo" }));
      yield* kept.write(chunk({}, "stop"));
      yield* kept.write("data: [DONE]\n\n");
      yield* kept.end;
    }),
  );
  expect(alive.observed as unknown).toMatchObject({ _tag: "ModelResponded", parts: [{ _tag: "Text", text: "Hallo" }] });
});

test("a failed, retried or not-retried request is logged with the whole error, its reason's description carrying the provider's answer", async () => {
  const body = JSON.stringify({ error: { message: "tools.0.name: bad name" } });
  const refused = rawServer([`HTTP/1.1 400 Bad Request\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\n\r\n${body}`]);
  const failed = await asked(openAiCompatModelClient({ times: 2, firstWait: "1 millis" }).pipe(Layer.provide(openAiCompatAt(refused.url))));
  refused.stop();
  type Logged = [string, { readonly error?: { readonly module: string; readonly reason: { readonly _tag: string; readonly description?: string } } }];
  const [failure] = failed.events(logKeys.provider.requestFailed) as Array<Logged>;
  expect(failure?.[1].error?.reason).toMatchObject({ _tag: "InvalidRequestError", description: expect.stringContaining("tools.0.name: bad name") });

  const limited = "HTTP/1.1 429 Too Many Requests\r\ncontent-type: application/json\r\nretry-after: 1\r\ncontent-length: 2\r\n\r\n{}";
  const busy = rawServer([limited, jsonWith(answer, answer.length)]);
  const retried = await asked(openAiCompatModelClient({ times: 2, firstWait: "1 millis" }).pipe(Layer.provide(openAiCompatAt(busy.url))));
  busy.stop();
  const [retry] = retried.events(logKeys.provider.requestRetried) as Array<Logged>;
  expect(retry?.[1].error?.reason._tag).toBe("RateLimitError");

  const cut = rawServer([jsonWith(answer.slice(0, 40), answer.length)]);
  const notRetried = await asked(openAiCompatModelClient({ times: 2, firstWait: "1 millis" }).pipe(Layer.provide(openAiCompatAt(cut.url))));
  cut.stop();
  const [kept] = notRetried.events(logKeys.provider.notRetried) as Array<Logged>;
  expect(kept?.[1].error?.reason._tag).toBe("NetworkError");
});
