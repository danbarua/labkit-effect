/** Counting a request's input tokens before it is sent, through the providers' count endpoints. */

import { afterAll, expect } from "bun:test";
import { Effect } from "effect";
import { anthropicAt, openAiAt } from "../../../tests/support/providers.ts";
import { runTest } from "../../../tests/support/run.ts";
import { test } from "../../../tests/support/test.ts";
import { ModelName, ProviderName } from "../../agent-machine/names.ts";
import type { ModelContext } from "../contracts.ts";
import { anthropicInputTokens } from "./anthropic-count.ts";
import { openAiInputTokens } from "./openai-count.ts";

const stops: Array<() => unknown> = [];
afterAll(() => {
  for (const stop of stops) stop();
});

const counting = (counted: number) => {
  const asked: Array<{ path: string; body: Record<string, unknown> }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      asked.push({ path: new URL(request.url).pathname, body: (await request.json()) as Record<string, unknown> });
      return Response.json({ input_tokens: counted });
    },
  });
  stops.push(() => server.stop(true));
  return { url: server.url, asked };
};

const context: ModelContext = { system: "Be brief.", tools: [], messages: [{ role: "user", parts: [{ _tag: "Text", text: "hello" }] }] };

test("Anthropic counts the request's body, without the output limit, at /v1/messages/count_tokens", async () => {
  const provider = counting(42);
  const counted = await runTest(
    Effect.flatMap(anthropicInputTokens(), (count) => count({ provider: ProviderName.make("anthropic"), model: ModelName.make("claude-sonnet-5-5") }, context)).pipe(
      Effect.provide(anthropicAt(new URL("/v1/messages", provider.url))),
    ),
  );
  expect(counted).toBe(42);
  expect(provider.asked[0]?.path).toBe("/v1/messages/count_tokens");
  expect(provider.asked[0]?.body).toMatchObject({ model: "claude-sonnet-5-5", system: "Be brief." });
  expect(provider.asked[0]?.body).not.toHaveProperty("max_tokens");
});

test("OpenAI counts the request's input at /responses/input_tokens", async () => {
  const provider = counting(17);
  const counted = await runTest(
    Effect.flatMap(openAiInputTokens(), (count) => count({ provider: ProviderName.make("openai"), model: ModelName.make("gpt-5.5") }, context)).pipe(
      Effect.provide(openAiAt(provider.url)),
    ),
  );
  expect(counted).toBe(17);
  expect(provider.asked[0]?.path).toBe("/responses/input_tokens");
  expect(provider.asked[0]?.body).toMatchObject({ model: "gpt-5.5", instructions: "Be brief." });
});
