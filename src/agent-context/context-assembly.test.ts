/** Context assembly on its own, with test layers for the services that it needs. */

import { expect } from "bun:test";
import { test, testOrigin } from "../../tests/support/test.ts";
import { DateTime, Effect, Layer, Logger } from "effect";
import { TestClock } from "effect/testing";
import type { Fact } from "../agent-machine/fact.ts";
import {
  assemble,
  Conversation,
  opening,
  type ModelChoice,
  type ModelSelector,
  ModelSelectors,
  type NoticeProvider,
  Notices,
  type SystemPromptProvider,
  SystemPrompts,
} from "./assemble.ts";
import type { ContextMessage } from "../agent-session/contracts.ts";
import { logKeys } from "./log-keys.ts";
import {
  ContextWindowAwareModelSelector,
  FixedModelSelector,
  SystemTimeNoticeProvider,
} from "./example-providers.ts";
import { ModelName, ProviderName, Seq, SessionId } from "../agent-machine/names.ts";
import { BoringSystemPromptProvider, BoringTools } from "../../tests/support/boring.ts";
import { type ToolSource, ToolSources } from "../agent-session/tool-sources.ts";
import { runTest } from "../../tests/support/run.ts";

const model = (name: string, contextWindow: number): ModelChoice => ({
  provider: ProviderName.make("boring"),
  model: ModelName.make(name),
  endpoint: new URL("http://provider.invalid/v1/messages"),
  contextWindow,
});
const small = model("boring-500k", 500_000);
const large = model("boring-1m", 1_000_000);

/** The providers, one of each kind, as layers; a test replaces the ones it varies. */
interface Setup {
  readonly systemPrompts: ReadonlyArray<SystemPromptProvider>;
  readonly toolSources: ReadonlyArray<ToolSource>;
  readonly notices: ReadonlyArray<NoticeProvider>;
  readonly modelSelectors: readonly [ModelSelector, ...ReadonlyArray<ModelSelector>];
}

const oneOfEach: Setup = {
  systemPrompts: [BoringSystemPromptProvider],
  toolSources: [BoringTools],
  notices: [SystemTimeNoticeProvider],
  modelSelectors: [FixedModelSelector(small), ContextWindowAwareModelSelector(large)],
};

const conversation = (text: string): ReadonlyArray<ContextMessage> => [
  { role: "user", parts: [{ _tag: "Text", text }] },
];

/**
 * Opens a session with the setup's providers, then assembles a request over `messages` at a fixed
 * time, from the session's facts; collects what it logs.
 */
const run = (setup: Setup, messages: ReadonlyArray<ContextMessage>) => {
  const logged: Array<unknown> = [];
  const capture = Logger.make((options) => {
    logged.push(options.message);
  });
  const layers = Layer.mergeAll(
    Layer.succeed(Conversation, { messages: () => Effect.succeed(messages) }),
    Layer.succeed(SystemPrompts, setup.systemPrompts),
    Layer.succeed(ToolSources, setup.toolSources),
    Layer.succeed(Notices, setup.notices),
    Layer.succeed(ModelSelectors, setup.modelSelectors),
    TestClock.layer(),
    Logger.layer([capture], { mergeWithExisting: true }),
  );
  return runTest(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-09-28T12:00:00.000Z"));
      const observation = yield* opening(SessionId.make("s1"), { provider: small.provider, model: small.model });
      const facts: ReadonlyArray<Fact> = [
        { _tag: "Observed", seq: Seq.make(1), time: yield* DateTime.now, origin: testOrigin(), observation },
      ];
      return yield* assemble(facts);
    }).pipe(Effect.provide(layers)),
  ).then((assembled) => ({ assembled, logged }));
};

test("with one provider of each kind, a request carries the system prompt and tools recorded at opening, the conversation, and the notices", async () => {
  const messages = conversation("Ping?");
  const { assembled, logged } = await run(oneOfEach, messages);
  expect(assembled as unknown).toEqual({
    system: ["You are a helpful assistant."],
    tools: [{ name: "echo", description: 'Answers "PONG".', input: { type: "object", properties: {} }, kind: "other", replay: "safe" }],
    messages,
    notices: ["The current time is 2026-09-28T12:00:00.000Z."],
    model: small,
  });
  expect(logged).toEqual([]);
});

test("the system prompts are joined, and the tool sources' tools joined, in the order they are listed; a namespaced source's tools are offered under its namespace", async () => {
  const { assembled } = await run(
    {
      ...oneOfEach,
      systemPrompts: [BoringSystemPromptProvider, { system: Effect.succeed(["Answer briefly."]) }],
      toolSources: [BoringTools, { ...BoringTools, namespace: "mcp__boring" }],
    },
    conversation("Ping?"),
  );
  expect(assembled.system).toEqual(["You are a helpful assistant.\n\nAnswer briefly."]);
  expect(assembled.tools.map((tool) => tool.name as string)).toEqual(["echo", "mcp__boring__echo"]);
});

test("a conversation estimated not to fit the 500k model goes to the 1M model, and the move is logged", async () => {
  const { assembled, logged } = await run(oneOfEach, conversation("x".repeat(2_400_000)));
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
