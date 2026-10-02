/**
 * An earlier response's thinking and other parts, on a later request: to where they came from, as
 * they were received; elsewhere, thinking as its text, and anything else left out and logged. Where
 * they came from is the provider for Anthropic and Responses, and the provider's same model for
 * Chat Completions, where one server serves many models and a router many vendors.
 */

import { afterAll, expect } from "bun:test";
import { Effect, Layer, Logger } from "effect";
import { ModelName, ProviderName, ThinkingText, TurnId } from "../../agent-machine/names.ts";
import { anthropicAt, openAiAt, openAiCompatAt } from "../../../tests/support/providers.ts";
import { runTest } from "../../../tests/support/run.ts";
import { anthropicStream, chatStream, openAiStream } from "../../../tests/support/streams.ts";
import { test } from "../../../tests/support/test.ts";
import { type ContextPart, ModelClient, type ModelContext } from "../contracts.ts";
import { logKeys } from "../log-keys.ts";
import { receivedJson } from "../received.ts";
import { AnthropicModelClient } from "./anthropic-client.ts";
import { OpenAiCompatModelClient } from "./openai-compat-client.ts";
import { OpenAiModelClient } from "./openai-client.ts";

const stops: Array<() => unknown> = [];
afterAll(() => {
  for (const stop of stops) stop();
});

/** A server for all three APIs that answers "ok", keeping each request's body. */
const server = () => {
  const bodies: Array<Record<string, unknown>> = [];
  const served = Bun.serve({
    port: 0,
    async fetch(request) {
      bodies.push((await request.json()) as Record<string, unknown>);
      const path = new URL(request.url).pathname;
      if (path === "/v1/messages") return anthropicStream({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" });
      if (path === "/responses") return openAiStream({ id: "r", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }] });
      return chatStream({ id: "c", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });
    },
  });
  stops.push(() => served.stop(true));
  return { url: served.url, bodies };
};

const clients = {
  anthropic: (url: URL) => AnthropicModelClient.pipe(Layer.provide(anthropicAt(new URL("/v1/messages", url)))),
  responses: (url: URL) => OpenAiModelClient.pipe(Layer.provide(openAiAt(url))),
  chat: (url: URL) => OpenAiCompatModelClient.pipe(Layer.provide(openAiCompatAt(url))),
};

const from = (model: string) => ({ _tag: "Response" as const, model: ModelName.make(model), turn: TurnId.make("turn-1") });

/** The assistant message `parts` came in, between two of the user's, sent to `provider`/`model` through `client`. */
async function sent(client: keyof typeof clients, provider: string, model: string, parts: ReadonlyArray<ContextPart>) {
  const { url, bodies } = server();
  const logged: Array<unknown> = [];
  const context: ModelContext = {
    system: undefined,
    tools: [],
    messages: [
      { role: "user", parts: [{ _tag: "Text", text: "Hello" }] },
      { role: "assistant", parts },
      { role: "user", parts: [{ _tag: "Text", text: "Again" }] },
    ],
  };
  await runTest(
    Effect.gen(function* () {
      yield* (yield* ModelClient).respond({ provider: ProviderName.make(provider), model: ModelName.make(model) }, context, TurnId.make("turn-2"));
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          clients[client](url),
          Logger.layer([Logger.make((options) => void logged.push(options.message))], { mergeWithExisting: true }),
        ),
      ),
    ),
  );
  const left = logged.filter((line) => Array.isArray(line) && line[0] === logKeys.provider.partLeftOut) as Array<[string, { readonly parts: ReadonlyArray<unknown> }]>;
  return { body: bodies[0] ?? {}, leftOut: left.flatMap(([, details]) => details.parts) };
}

const thinking = (provider: string, model: string, received: unknown): ContextPart => ({
  _tag: "Thinking",
  provider: ProviderName.make(provider),
  from: from(model),
  text: ThinkingText.make("Add them."),
  received: receivedJson(received as never),
});

const answer: ContextPart = { _tag: "Text", text: "Adding." };

test("Anthropic: its own thinking from another of its models goes back as received; another provider's as text", async () => {
  const block = { type: "thinking", thinking: "Add them.", signature: "sig" };
  const own = await sent("anthropic", "anthropic", "claude-b", [thinking("anthropic", "claude-a", block), answer]);
  expect((own.body["messages"] as ReadonlyArray<unknown>)[1]).toEqual({ role: "assistant", content: [block, { type: "text", text: "Adding." }] });
  const other = await sent("anthropic", "anthropic", "claude-b", [thinking("openai", "gpt-a", { type: "reasoning", summary: [] }), answer]);
  expect((other.body["messages"] as ReadonlyArray<unknown>)[1]).toEqual({
    role: "assistant",
    content: [
      { type: "text", text: "Add them." },
      { type: "text", text: "Adding." },
    ],
  });
});

test("Responses: another provider's thinking goes as an assistant message holding its text, in its place", async () => {
  const { body } = await sent("responses", "openai", "gpt-b", [thinking("anthropic", "claude-a", { type: "thinking", thinking: "Add them.", signature: "sig" }), answer]);
  expect((body["input"] as ReadonlyArray<unknown>).slice(1, 3)).toEqual([
    { role: "assistant", content: [{ type: "output_text", text: "Add them." }] },
    { role: "assistant", content: [{ type: "output_text", text: "Adding." }] },
  ]);
});

test("Chat Completions: the same model's thinking and fields go back as received; another model's thinking as text, and its other fields left out", async () => {
  const refusal: ContextPart = { _tag: "Unrecognised", provider: ProviderName.make("localhost"), from: from("qwen"), received: receivedJson({ refusal: "none of it" }) };
  const parts = [thinking("localhost", "qwen", { reasoning_content: "Add them." }), answer, refusal];
  const same = await sent("chat", "localhost", "qwen", parts);
  expect((same.body["messages"] as ReadonlyArray<unknown>)[1]).toEqual({
    role: "assistant",
    content: [{ type: "text", text: "Adding." }],
    reasoning_content: "Add them.",
    refusal: "none of it",
  });
  const other = await sent("chat", "localhost", "llama", parts);
  expect((other.body["messages"] as ReadonlyArray<unknown>)[1]).toEqual({
    role: "assistant",
    content: [
      { type: "text", text: "Add them." },
      { type: "text", text: "Adding." },
    ],
  });
  expect(other.leftOut).toMatchObject([{ part: "Unrecognised", from: "localhost/qwen", reason: "produced by localhost/qwen, not localhost/llama" }]);
});
