/**
 * The bodies of each model request's HTTP exchange, captured through the `HttpClient` that every
 * provider's client is given (`capturingHttp`), as each adapter sends and reads them.
 */

import { afterAll, expect } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AnthropicClient } from "@effect/ai-anthropic";
import { OpenAiClient } from "@effect/ai-openai";
import { OpenAiClient as OpenAiCompatClient } from "@effect/ai-openai-compat";
import { Context, Effect, Layer, Logger, type LogLevel, Redacted, References, Tracer } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { ModelName, ProviderName, TurnId } from "../agent-machine/names.ts";
import { ModelClient, type ProviderRequest } from "../agent-session/contracts.ts";
import { logKeys } from "../agent-session/log-keys.ts";
import { FallbackModelClient } from "../agent-session/model-fallback.ts";
import type { Retries } from "../agent-session/provider-call.ts";
import { anthropicRequests } from "../agent-session/providers/anthropic-client.ts";
import { openAiRequests } from "../agent-session/providers/openai-client.ts";
import { openAiCompatRequests } from "../agent-session/providers/openai-compat-client.ts";
import { xAiRequests } from "../agent-session/providers/xai-client.ts";
import { runTest } from "../../tests/support/run.ts";
import { anthropicStream, chatStream, openAiStream } from "../../tests/support/streams.ts";
import { test, testFolder } from "../../tests/support/test.ts";
import { type CaptureSettings, HttpCaptures, capturesFolderIn, capturingClient, capturingHttp, eventBlocksOf } from "./http-captures.ts";
import { type SpanLine, SpansTo } from "./telemetry.ts";

const stops: Array<() => unknown> = [];
afterAll(() => {
  for (const stop of stops) stop();
});

/** A server that answers the n-th request with `answers[n]()`, or the last one, keeping each request's body as the bytes received. */
const served = (answers: ReadonlyArray<() => Response>) => {
  const bodies: Array<Uint8Array<ArrayBuffer>> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      bodies.push(new Uint8Array(await request.arrayBuffer()));
      const answer = answers[Math.min(bodies.length - 1, answers.length - 1)];
      if (answer === undefined) throw new Error("no answer is scripted");
      return answer();
    },
  });
  stops.push(() => server.stop(true));
  return { url: new URL(server.url.origin), bodies };
};

/** `response` with its body read to text, so that a test knows what it streamed, and `headers` added. */
const answered = async (response: Response, headers: Record<string, string> = {}) => {
  const text = await response.text();
  return { text, answer: () => new Response(text, { status: response.status, headers: { ...Object.fromEntries(response.headers), ...headers } }) };
};

type Adapter = (http: Layer.Layer<HttpClient.HttpClient>, url: URL, retries: Retries) => Effect.Effect<ProviderRequest>;

const key = Redacted.make("test-key");

/** Each adapter, made with its provider's client over `http`, pointed at `url`. */
const adapters: Record<"anthropic" | "openai" | "xai" | "localhost", Adapter> = {
  anthropic: (http, url, retries) => anthropicRequests(retries).pipe(Effect.provide(AnthropicClient.layer({ apiUrl: url.origin, apiKey: key }).pipe(Layer.provide(http)))),
  openai: (http, url, retries) => openAiRequests(retries).pipe(Effect.provide(OpenAiClient.layer({ apiUrl: url.origin, apiKey: key }).pipe(Layer.provide(http)))),
  xai: (http, url, retries) => xAiRequests(retries).pipe(Effect.provide(OpenAiClient.layer({ apiUrl: url.origin, apiKey: key }).pipe(Layer.provide(http)))),
  localhost: (http, url, retries) => openAiCompatRequests(retries).pipe(Effect.provide(OpenAiCompatClient.layer({ apiUrl: url.origin, apiKey: key }).pipe(Layer.provide(http)))),
};

interface Logged {
  readonly message: unknown;
  readonly spanId: string | undefined;
}

interface Asked {
  readonly provider: keyof typeof adapters;
  readonly url: URL;
  readonly retries?: Retries;
  readonly level?: LogLevel.LogLevel;
  /** The capture settings; absent, those `runTest` gives; undefined, none. */
  readonly captures?: CaptureSettings | undefined;
  readonly text?: string;
}

/**
 * Asks the adapter of `provider` once, through the fallback chain (so in an `agent.model.attempt`
 * span), with its HTTP client capturing; returns the capture lines logged, with the span each was
 * logged in, and the attempt spans.
 */
const ask = async (asked: Asked) => {
  const logged: Array<Logged> = [];
  const spans: Array<SpanLine> = [];
  const provider = ProviderName.make(asked.provider);
  const settings = "captures" in asked ? Effect.provideService(HttpCaptures, asked.captures) : <A, E, R>(effect: Effect.Effect<A, E, R>) => effect;
  const observed = await runTest(
    Effect.gen(function* () {
      return yield* (yield* ModelClient).respond(
        { provider, model: ModelName.make("boring-1") },
        { system: undefined, tools: [], messages: [{ role: "user", parts: [{ _tag: "Text", text: asked.text ?? "hi" }] }] },
        TurnId.make("turn-1"),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.unwrap(
            Effect.map(adapters[asked.provider](capturingHttp(FetchHttpClient.layer), asked.url, asked.retries ?? { times: 0, firstWait: "1 millis" }), (request) =>
              FallbackModelClient({ requests: new Map([[provider, request]]), fallbacks: [] }),
            ),
          ),
          SpansTo((line) => void spans.push(line)),
          Logger.layer(
            [Logger.make((options) => logged.push({ message: options.message, spanId: Context.getOrUndefined(options.fiber.context, Tracer.ParentSpan)?.spanId }))],
            { mergeWithExisting: true },
          ),
        ),
      ),
      settings,
      Effect.provideService(References.MinimumLogLevel, asked.level ?? "Debug"),
    ),
  );
  const captures = logged.flatMap(({ message, spanId }) => {
    if (!Array.isArray(message) || message[0] !== logKeys.provider.payloadCaptured) return [];
    return [{ fields: message[1] as Record<string, unknown> & { body: string; body_uri: string; size: number; sha256: string; redacted: number }, spanId }];
  });
  return { observed, captures, attempts: spans.filter((span) => span.name === "agent.model.attempt") };
};

/** The bytes of the file a capture line points to. */
const fileOf = async (line: { readonly body_uri: string }) => new Uint8Array(await Bun.file(fileURLToPath(line.body_uri)).arrayBuffer());

const answers = {
  anthropic: () => anthropicStream({ id: "msg_1", type: "message", role: "assistant", model: "boring-1", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }),
  openai: () => openAiStream({ id: "r", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }] }),
  xai: () => openAiStream({ id: "r", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }] }),
  localhost: () => chatStream({ id: "c", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }),
};

test.each(["anthropic", "openai", "xai", "localhost"] as const)(
  "%s: a streamed request's body is captured as the server received it, and its events as they arrived, each line in the attempt's span",
  async (provider) => {
    const stream = await answered(answers[provider](), { "x-request-id": "req_42" });
    const server = served([stream.answer]);
    const { observed, captures, attempts } = await ask({ provider, url: server.url });
    expect(observed).toMatchObject({ _tag: "ModelResponded" });
    expect(captures.map(({ fields }) => fields.body)).toEqual(["request", "response_events"]);
    const [request, events] = captures;
    expect(await fileOf(request!.fields)).toEqual(server.bodies[0]!);
    expect(request!.fields).toMatchObject({ method: "POST", redacted: 0 });
    expect(request!.fields).not.toHaveProperty("status");
    const blocks = JSON.parse(await Bun.file(fileURLToPath(events!.fields.body_uri)).text()) as ReadonlyArray<string>;
    expect(blocks.join("")).toBe(stream.text);
    expect(blocks.every((block) => block.endsWith("\n\n"))).toBe(true);
    // The Chat Completions adapter stops reading at `[DONE]`, before the stream's end; a stream whose last event is `[DONE]` is complete all the same.
    expect(events!.fields).toMatchObject({ status: 200, content_type: "text/event-stream", request_id: "req_42", complete: true });
    for (const { fields } of captures) {
      const bytes = await fileOf(fields);
      expect(fields.size).toBe(bytes.byteLength);
      expect(fields.sha256).toBe(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"));
    }
    expect(attempts).toHaveLength(1);
    expect(captures.map(({ spanId }) => spanId)).toEqual([attempts[0]!.spanId, attempts[0]!.spanId]);
  },
);

test("a Chat Completions stream whose connection drops before [DONE] is captured, and not complete", async () => {
  const sent = 'data: {"id":"c","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"o"},"finish_reason":null}]}\n\n';
  // A server that sends the headers and one chunk of a chunked body, then closes the connection without its last chunk.
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket) {
        const size = new TextEncoder().encode(sent).byteLength.toString(16);
        socket.write(`HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n${size}\r\n${sent}\r\n`);
        socket.end();
      },
    },
  });
  stops.push(() => server.stop(true));
  const { observed, captures } = await ask({ provider: "localhost", url: new URL(`http://127.0.0.1:${server.port}`) });
  expect(observed).toMatchObject({ _tag: "ModelFailed" });
  const events = captures.find(({ fields }) => fields.body === "response_events");
  // Bun's fetch drops the bytes it holds unread when the connection closes, so the adapter gets the
  // event only when it read it before the close; the capture holds what the adapter got.
  const received = (JSON.parse(new TextDecoder().decode(await fileOf(events!.fields))) as ReadonlyArray<string>).join("");
  expect(sent.startsWith(received)).toBe(true);
  expect(events!.fields).toMatchObject({ status: 200, complete: false });
});

test("events are split after each blank line, whichever line ending it has, and an event cut short is the last block", () => {
  const text = "data: 1\n\ndata: 2\r\n\r\n: ping\r\rdata: 3\ndata: 4\n\nda";
  expect(eventBlocksOf(text)).toEqual(["data: 1\n\n", "data: 2\r\n\r\n", ": ping\r\r", "data: 3\ndata: 4\n\n", "da"]);
});

test("a response read whole is captured as its JSON body, with its status", async () => {
  const whole = { id: "c", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] };
  const server = served([() => Response.json(whole, { headers: { "request-id": "req_7" } })]);
  const { captures } = await ask({ provider: "localhost", url: server.url });
  const response = captures.find(({ fields }) => fields.body === "response");
  expect(JSON.parse(new TextDecoder().decode(await fileOf(response!.fields)))).toEqual(whole);
  expect(response!.fields).toMatchObject({ status: 200, request_id: "req_7" });
  expect(response!.fields).not.toHaveProperty("as");
});

test("a failed status's body is captured as the response; a body that is not JSON is captured as a JSON string marked as text", async () => {
  const error = { type: "error", error: { type: "invalid_request_error", message: "bad" } };
  const json = await ask({ provider: "anthropic", url: served([() => Response.json(error, { status: 400 })]).url });
  const failedJson = json.captures.find(({ fields }) => fields.body === "response");
  expect(JSON.parse(new TextDecoder().decode(await fileOf(failedJson!.fields)))).toEqual(error);
  expect(failedJson!.fields).toMatchObject({ status: 400 });

  const html = await ask({ provider: "anthropic", url: served([() => new Response("<h1>Bad request</h1>", { status: 400, headers: { "content-type": "text/html" } })]).url });
  const failedText = html.captures.find(({ fields }) => fields.body === "response");
  expect(JSON.parse(new TextDecoder().decode(await fileOf(failedText!.fields)))).toBe("<h1>Bad request</h1>");
  expect(failedText!.fields).toMatchObject({ status: 400, content_type: "text/html", as: "text" });
});

test("a retried request captures each attempt's request and response", async () => {
  const stream = await answered(answers.openai());
  const server = served([() => new Response("busy", { status: 503 }), stream.answer]);
  const { captures, attempts } = await ask({ provider: "openai", url: server.url, retries: { times: 1, firstWait: "1 millis" } });
  expect(captures.map(({ fields }) => fields.body)).toEqual(["request", "response", "request", "response_events"]);
  expect(await fileOf(captures[0]!.fields)).toEqual(server.bodies[0]!);
  expect(await fileOf(captures[2]!.fields)).toEqual(server.bodies[1]!);
  expect(new Set(captures.map(({ fields }) => fields["capture_id"])).size).toBe(4);
  expect(new Set(captures.map(({ spanId }) => spanId))).toEqual(new Set([attempts[0]!.spanId]));
});

test("a request that fails before any response is still captured, in the attempt's span", async () => {
  // Port 1 on this machine has no server: the connection is refused at once.
  const { observed, captures, attempts } = await ask({ provider: "localhost", url: new URL("http://127.0.0.1:1") });
  expect(observed).toMatchObject({ _tag: "ModelFailed" });
  expect(captures.map(({ fields }) => fields.body)).toEqual(["request"]);
  expect(captures[0]!.spanId).toBe(attempts[0]!.spanId);
});

test("a request is sent before its body's capture is logged: capturing does not hold the send back", async () => {
  const order: Array<string> = [];
  // The send is noted when the client is called; the capture is logged only after its file is written.
  const inner = HttpClient.make((request) =>
    Effect.sync(() => {
      order.push("sent");
      return HttpClientResponse.fromWeb(request, Response.json({}));
    }),
  );
  const noting = Logger.make((options) => {
    const [key, fields]: ReadonlyArray<unknown> = Array.isArray(options.message) ? options.message : [];
    if (key === logKeys.provider.payloadCaptured && typeof fields === "object" && fields !== null && "body" in fields && fields.body === "request") order.push("captured");
  });
  await runTest(
    capturingClient(inner)
      .execute(HttpClientRequest.post("http://localhost/v1/chat/completions").pipe(HttpClientRequest.bodyText('{"model":"m"}', "application/json")))
      .pipe(
        Effect.provide(Logger.layer([noting], { mergeWithExisting: true })),
        Effect.provideService(HttpCaptures, { folder: join(testFolder(), "captures"), secrets: { values: [], tooShort: [] } }),
        Effect.provideService(References.MinimumLogLevel, "Debug"),
      ),
  );
  expect(order).toEqual(["sent", "captured"]);
});

test("a secret value in a body is replaced by <redacted>, and the line counts it", async () => {
  const secret = "sk-test-0123456789abcdef";
  const server = served([(await answered(answers.localhost())).answer]);
  const folder = join(testFolder(), "captures");
  const { captures } = await ask({ provider: "localhost", url: server.url, captures: { folder, secrets: { values: [secret], tooShort: [] } }, text: `my key is ${secret}` });
  const request = captures.find(({ fields }) => fields.body === "request");
  const text = new TextDecoder().decode(await fileOf(request!.fields));
  expect(text).not.toContain(secret);
  expect(text).toContain("my key is <redacted>");
  expect(request!.fields.redacted).toBe(1);
  expect(fileURLToPath(request!.fields.body_uri).startsWith(folder)).toBe(true);
});

test("at log level info, no capture is written and no line logged", async () => {
  const server = served([(await answered(answers.anthropic())).answer]);
  const { observed, captures } = await ask({ provider: "anthropic", url: server.url, level: "Info" });
  expect(observed).toMatchObject({ _tag: "ModelResponded" });
  expect(captures).toEqual([]);
  expect(() => readdirSync(capturesFolderIn(testFolder()))).toThrow();
});

test("with no capture folder set, no capture is written and no line logged", async () => {
  const server = served([(await answered(answers.anthropic())).answer]);
  const { observed, captures } = await ask({ provider: "anthropic", url: server.url, captures: undefined });
  expect(observed).toMatchObject({ _tag: "ModelResponded" });
  expect(captures).toEqual([]);
  expect(() => readdirSync(capturesFolderIn(testFolder()))).toThrow();
});
