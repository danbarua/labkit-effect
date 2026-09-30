/**
 * Failures VidaiMock cannot play, since it always answers whole: a provider that cannot be reached,
 * and a response whose body does not arrive whole. The others (HTTP statuses, retries) are tested
 * against it in `vidaimock.test.ts`.
 */

import { expect } from "bun:test";
import { test } from "../../../tests/support/test.ts";
import { OpenAiClient as OpenAiCompatClient } from "@effect/ai-openai-compat";
import { Effect, Layer, Logger, Redacted } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { ModelName, ProviderName, TurnId } from "../../agent-machine/names.ts";
import { ModelClient } from "../contracts.ts";
import { logKeys } from "../log-keys.ts";
import { anthropicModelClient } from "./anthropic-client.ts";
import { openAiModelClient } from "./openai-client.ts";
import { openAiCompatModelClient } from "./openai-compat-client.ts";
import { anthropicAt, openAiAt, openAiCompatAt } from "../../../tests/support/providers.ts";
import { runTest } from "../../../tests/support/run.ts";

test("a provider that cannot be reached fails as a network error, retried first", async () => {
  const gone = Bun.serve({ port: 0, fetch: () => new Response() });
  const url = gone.url;
  await gone.stop(true);
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
          Logger.layer([Logger.make((options) => logged.push(options.message))]),
        ),
      ),
    ),
  );
  const events = (key: string) => logged.filter((message) => Array.isArray(message) && message[0] === key);
  expect(observed).toMatchObject({ _tag: "ModelFailed" });
  expect(events(logKeys.provider.requestFailed)).toMatchObject([[logKeys.provider.requestFailed, { reason: "NetworkError" }]]);
  expect(events(logKeys.provider.requestRetried)).toHaveLength(2);
});

/**
 * A server that writes each response as raw HTTP and closes the connection: the n-th request gets
 * `answers[n]`, or the last one.
 */
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
    }).pipe(Effect.provide(Layer.mergeAll(client, Logger.layer([Logger.make((options) => logged.push(options.message))])))),
  ).then((observed) => ({
    observed,
    events: (key: string) => logged.filter((message) => Array.isArray(message) && message[0] === key),
  }));
};

const answer = JSON.stringify({ id: "chatcmpl-1", choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }] });
const jsonWith = (body: string, length: number) =>
  `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${length}\r\n\r\n${body}`;

test("a body that ends before its Content-Length fails as a transport error, and is retried", async () => {
  const server = rawServer([jsonWith(answer.slice(0, 40), answer.length), jsonWith(answer, answer.length)]);
  const { observed, events } = await asked(
    openAiCompatModelClient({ times: 2, firstWait: "1 millis" }).pipe(Layer.provide(openAiCompatAt(server.url))),
  );
  server.stop();
  expect(observed).toMatchObject({ _tag: "ModelResponded", parts: [{ _tag: "Text", text: "hi" }] });
  expect(server.requests()).toBe(2);
  expect(events(logKeys.provider.requestRetried)).toMatchObject([[logKeys.provider.requestRetried, { reason: "NetworkError" }]]);
});

test("a stream closed before its last chunk fails as a transport error, and the retried request streams again", async () => {
  const completed = { type: "response.completed", response: { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] }] } };
  const event = `data: ${JSON.stringify(completed)}\n\n`;
  const chunk = (text: string) => `${Buffer.byteLength(text).toString(16)}\r\n${text}\r\n`;
  const head = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n";
  const server = rawServer([`${head}${chunk(event.slice(0, 30))}`, `${head}${chunk(event)}0\r\n\r\n`]);
  const { observed, events } = await asked(openAiModelClient({ times: 2, firstWait: "1 millis" }).pipe(Layer.provide(openAiAt(server.url))));
  server.stop();
  expect(observed).toMatchObject({ _tag: "ModelResponded", parts: [{ _tag: "Text", text: "hi" }] });
  expect(server.requests()).toBe(2);
  expect(events(logKeys.provider.requestRetried)).toMatchObject([[logKeys.provider.requestRetried, { reason: "NetworkError" }]]);
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
