/** Context assembly on its own: a request in, an assembled context out. */

import { expect, test } from "bun:test";
import { Effect, Layer, Logger } from "effect";
import { TestClock } from "effect/testing";
import { type AssembleContext, assemble, type ModelChoice, type Providers } from "../src/agent-context/assemble.ts";
import { logKeys } from "../src/agent-context/log-keys.ts";
import {
  BoringSystemPromptProvider,
  BoringToolCatalog,
  ContextWindowAwareModelSelector,
  FixedModelSelector,
  SystemTimeNoticeProvider,
} from "../src/agent-context/providers.ts";
import { ModelName, ProviderName } from "../src/agent-core/names.ts";

const model = (name: string, contextWindow: number): ModelChoice => ({
  provider: ProviderName.make("boring"),
  model: ModelName.make(name),
  endpoint: new URL("http://provider.invalid/v1/messages"),
  contextWindow,
});
const small = model("boring-500k", 500_000);
const large = model("boring-1m", 1_000_000);

const providers: Providers = {
  systemPrompts: [BoringSystemPromptProvider],
  toolCatalogs: [BoringToolCatalog],
  notices: [SystemTimeNoticeProvider],
  modelSelectors: [FixedModelSelector(small), ContextWindowAwareModelSelector(large)],
};

const conversation = (text: string): AssembleContext => ({
  messages: [{ role: "user", parts: [{ _tag: "Text", text }] }],
});

/** Runs assembly at a fixed time, collecting what it logs. */
const run = (with_: Providers, request: AssembleContext) => {
  const logged: Array<unknown> = [];
  const capture = Logger.make((options) => {
    logged.push(options.message);
  });
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-09-28T12:00:00.000Z"));
      return yield* assemble(with_, request);
    }).pipe(Effect.provide(Layer.mergeAll(TestClock.layer(), Logger.layer([capture])))),
  ).then((assembled) => ({ assembled, logged }));
};

test("one provider of each kind: the conversation passes through, each provider's output is in place", async () => {
  const request = conversation("Ping?");
  const { assembled, logged } = await run(providers, request);
  expect(assembled as unknown).toEqual({
    system: ["You are a helpful assistant."],
    tools: [{ name: "echo", description: 'Answers "PONG".', input: { type: "object", properties: {} } }],
    messages: request.messages,
    notices: ["The current time is 2026-09-28T12:00:00.000Z."],
    model: small,
  });
  expect(logged).toEqual([]);
});

test("the outputs of providers of one kind are appended in the order the providers are listed", async () => {
  const { assembled } = await run(
    {
      ...providers,
      systemPrompts: [BoringSystemPromptProvider, { system: () => Effect.succeed(["Answer briefly."]) }],
      toolCatalogs: [BoringToolCatalog, BoringToolCatalog],
    },
    conversation("Ping?"),
  );
  expect(assembled.system).toEqual(["You are a helpful assistant.", "Answer briefly."]);
  expect(assembled.tools.map((tool) => tool.name as string)).toEqual(["echo", "echo"]);
});

test("a conversation estimated not to fit the 500k model goes to the 1M model, and the move is logged", async () => {
  const { assembled, logged } = await run(providers, conversation("x".repeat(2_400_000)));
  expect(assembled.model).toEqual(large);
  expect(logged).toEqual([
    [
      logKeys.selection.modelUpgraded,
      {
        from: "boring-500k",
        fromWindow: 500_000,
        to: "boring-1m",
        toWindow: 1_000_000,
        estimatedTokens: expect.any(Number),
        reason: "the assembled context is estimated not to fit the model chosen so far",
      },
    ],
  ]);
});
