/** A model request that fails: which failures are retried, and what the core and the log see. */

import { afterAll, expect, test } from "bun:test";
import { Effect, Layer, Logger } from "effect";
import { ModelName, ProviderName, TurnId } from "../../src/agent-core/names.ts";
import { anthropicModelClient } from "../../src/agent-effect/anthropic-client.ts";
import { ModelClient } from "../../src/agent-effect/contracts.ts";
import { logKeys } from "../../src/agent-effect/log-keys.ts";
import { anthropicAt } from "../support/providers.ts";
import { runTest } from "../support/run.ts";

const servers: Array<{ stop: (force: boolean) => unknown }> = [];
afterAll(() => {
  for (const server of servers) server.stop(true);
});

const answer = { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" };

/** A provider that answers each request with the next scripted status and body. */
function scripted(replies: ReadonlyArray<{ status: number; body: unknown }>) {
  const hits = { count: 0 };
  const server = Bun.serve({
    port: 0,
    fetch() {
      const reply = replies[Math.min(hits.count, replies.length - 1)];
      hits.count += 1;
      return Response.json(reply?.body, { status: reply?.status ?? 500 });
    },
  });
  servers.push(server);
  return { url: server.url, hits };
}

/** One request through the Anthropic client with quick retries, collecting what is logged. */
async function request(url: URL) {
  const logged: Array<{ level: string; message: unknown }> = [];
  const capture = Logger.make((options) => {
    logged.push({ level: options.logLevel, message: options.message });
  });
  const observed = await runTest(
    Effect.gen(function* () {
      return yield* (yield* ModelClient).respond(
        { provider: ProviderName.make("boring"), model: ModelName.make("boring-1") },
        { system: undefined, tools: [], messages: [{ role: "user", parts: [{ _tag: "Text", text: "hi" }] }] },
        TurnId.make("turn-1"),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          anthropicModelClient({ times: 2, firstWait: "1 millis" }).pipe(Layer.provide(anthropicAt(url))),
          Logger.layer([capture]),
        ),
      ),
    ),
  );
  const events = (key: string) =>
    logged.filter((entry) => Array.isArray(entry.message) && entry.message[0] === key).map((entry) => entry.message);
  return { observed, events };
}

test("a rate limit is retried, and the retry is logged", async () => {
  const provider = scripted([
    { status: 429, body: { type: "error", error: { type: "rate_limit_error", message: "slow down" } } },
    { status: 200, body: answer },
  ]);
  const { observed, events } = await request(provider.url);
  expect(observed).toMatchObject({ _tag: "ModelResponded" });
  expect(provider.hits.count).toBe(2);
  expect(events(logKeys.provider.requestRetried)).toMatchObject([[logKeys.provider.requestRetried, { reason: "RateLimitError" }]]);
});

test("a rejected key is not retried: the turn's model request fails, and the whole error is logged", async () => {
  const provider = scripted([{ status: 401, body: { type: "error", error: { type: "authentication_error" } } }]);
  const { observed, events } = await request(provider.url);
  expect(observed).toMatchObject({ _tag: "ModelFailed", turn: "turn-1" });
  expect(provider.hits.count).toBe(1);
  expect(events(logKeys.provider.requestRetried)).toEqual([]);
  expect(events(logKeys.provider.requestFailed)).toMatchObject([
    [logKeys.provider.requestFailed, { reason: "AuthenticationError", retryable: false }],
  ]);
});

test("a provider that keeps failing is tried the allowed number of times, then the request fails", async () => {
  const provider = scripted([{ status: 500, body: { type: "error", error: { type: "api_error" } } }]);
  const { observed, events } = await request(provider.url);
  expect(observed).toMatchObject({ _tag: "ModelFailed" });
  expect(provider.hits.count).toBe(3);
  expect(events(logKeys.provider.requestRetried)).toMatchObject([
    [logKeys.provider.requestRetried, { reason: "InternalProviderError", retry: 1, of: 2 }],
    [logKeys.provider.requestRetried, { reason: "InternalProviderError", retry: 2, of: 2 }],
  ]);
  expect(events(logKeys.provider.requestFailed)).toMatchObject([
    [logKeys.provider.requestFailed, { reason: "InternalProviderError", retryable: true }],
  ]);
});

test("a provider that cannot be reached fails as a network error, retried first", async () => {
  const gone = Bun.serve({ port: 0, fetch: () => new Response() });
  const url = gone.url;
  await gone.stop(true);
  const { observed, events } = await request(url);
  expect(observed).toMatchObject({ _tag: "ModelFailed" });
  expect(events(logKeys.provider.requestFailed)).toMatchObject([
    [logKeys.provider.requestFailed, { reason: "NetworkError" }],
  ]);
  expect(events(logKeys.provider.requestRetried)).toHaveLength(2);
});
