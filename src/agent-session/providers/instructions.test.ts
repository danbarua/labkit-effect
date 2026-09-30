/**
 * An instruction in the middle of the conversation, as each adapter sends it: a `system` message to
 * the Anthropic Messages API and to Chat Completions, a `developer` message to OpenAI Responses.
 * What is sent is checked on a recording server; that the provider takes it, against VidaiMock.
 */

import { afterAll, beforeAll, expect } from "bun:test";
import { test } from "../../../tests/support/test.ts";
import { Effect, Exit, Layer } from "effect";
import { ModelName, ProviderName, TurnId } from "../../agent-machine/names.ts";
import { ModelClient, type ModelContext } from "../contracts.ts";
import { anthropicModelClient } from "./anthropic-client.ts";
import { openAiModelClient } from "./openai-client.ts";
import { openAiCompatModelClient } from "./openai-compat-client.ts";
import { anthropicAt, openAiAt, openAiCompatAt, recordingServer } from "../../../tests/support/providers.ts";
import { runTest } from "../../../tests/support/run.ts";
import { anthropicAtMock, openAiAtMock, openAiCompatAtMock, startVidaiMock, type VidaiMock } from "../../../tests/support/vidaimock.ts";

const state: { mock?: VidaiMock } = {};
beforeAll(async () => {
  state.mock = await startVidaiMock();
});
afterAll(() => state.mock?.stop());
const mock = (): VidaiMock => {
  if (state.mock === undefined) throw new Error("VidaiMock did not start");
  return state.mock;
};

const noRetries = { times: 0, firstWait: "1 millis" } as const;

const context: ModelContext = {
  system: undefined,
  tools: [],
  messages: [
    { role: "user", parts: [{ _tag: "Text", text: "What day is it?" }] },
    { role: "instruction", parts: [{ _tag: "Text", text: "The current time is 2026-09-29T12:00:00.000Z." }] },
  ],
};

const respond = (client: Layer.Layer<ModelClient>) =>
  Effect.gen(function* () {
    return yield* (yield* ModelClient).respond(
      { provider: ProviderName.make("any"), model: ModelName.make("any-1") },
      context,
      TurnId.make("turn-1"),
    );
  }).pipe(Effect.provide(client));

const answers = {
  anthropic: { content: [{ type: "text", text: "Tuesday." }], stop_reason: "end_turn" },
  openAi: { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Tuesday." }] }] },
  openAiCompat: { choices: [{ message: { role: "assistant", content: "Tuesday." }, finish_reason: "stop" }] },
};

test("the Anthropic adapter sends an instruction as a system message after the input", async () => {
  const server = recordingServer([answers.anthropic]);
  await runTest(respond(anthropicModelClient(noRetries).pipe(Layer.provide(anthropicAt(server.url)))));
  await server.stop();
  expect((server.bodies[0] as { messages: unknown }).messages).toEqual([
    { role: "user", content: [{ type: "text", text: "What day is it?" }] },
    { role: "system", content: [{ type: "text", text: "The current time is 2026-09-29T12:00:00.000Z." }] },
  ]);
});

test("the OpenAI Responses adapter sends an instruction as a developer message after the input", async () => {
  const server = recordingServer([answers.openAi]);
  await runTest(respond(openAiModelClient(noRetries).pipe(Layer.provide(openAiAt(server.url)))));
  await server.stop();
  expect((server.bodies[0] as { input: unknown }).input).toEqual([
    { role: "user", content: [{ type: "input_text", text: "What day is it?" }] },
    { role: "developer", content: [{ type: "input_text", text: "The current time is 2026-09-29T12:00:00.000Z." }] },
  ]);
});

test("the Chat Completions adapter sends an instruction as a system message after the input", async () => {
  const server = recordingServer([answers.openAiCompat]);
  await runTest(respond(openAiCompatModelClient(noRetries).pipe(Layer.provide(openAiCompatAt(server.url)))));
  await server.stop();
  expect((server.bodies[0] as { messages: unknown }).messages).toEqual([
    { role: "user", content: [{ type: "text", text: "What day is it?" }] },
    { role: "system", content: [{ type: "text", text: "The current time is 2026-09-29T12:00:00.000Z." }] },
  ]);
});

test.each([
  ["Anthropic Messages", () => anthropicModelClient(noRetries).pipe(Layer.provide(anthropicAtMock(mock())))],
  ["OpenAI Responses", () => openAiModelClient(noRetries).pipe(Layer.provide(openAiAtMock(mock())))],
  ["Chat Completions", () => openAiCompatModelClient(noRetries).pipe(Layer.provide(openAiCompatAtMock(mock())))],
])("%s at VidaiMock takes a request with an instruction", async (_name, client) => {
  const exit = await Effect.runPromiseExit(respond(client()));
  expect(Exit.isSuccess(exit) && exit.value._tag).toBe("ModelResponded");
});
