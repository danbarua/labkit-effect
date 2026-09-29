/** A fallback chain from Anthropic to OpenAI, through the loop, over the stand-in providers of the example. */

import { expect, test } from "bun:test";
import { Effect, Exit, Layer, Logger } from "effect";
import * as AiError from "effect/ai/AiError";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { InputText, SessionId, TurnId } from "../../src/agent-core/names.ts";
import { ModelClient, ModelProvider, type ProviderRequest } from "../../src/agent-effect/contracts.ts";
import {
  anthropic,
  anthropicThenOpenAi,
  answers,
  failsWith,
  openAi,
} from "../../src/agent-effect/examples/example-model-fallback.ts";
import { BoringContextAssembler, CountingTurns, NoTurnEndHooks } from "../../src/agent-effect/examples/example-providers.ts";
import { SmolToolRunner } from "../../src/agent-effect/examples/example-smol-tools.ts";
import { logKeys } from "../../src/agent-effect/log-keys.ts";
import { openSession } from "../../src/agent-effect/loop.ts";
import { FallbackModelClient } from "../../src/agent-effect/model-fallback.ts";
import { AgentTelemetry } from "../../src/instrumentation/telemetry.ts";
import { runTest } from "../support/run.ts";

/** `request`, counting how often it is made. */
const counted = (request: ProviderRequest) => {
  const made = { count: 0 };
  const wrapped: ProviderRequest = (target, context, turn) =>
    Effect.suspend(() => {
      made.count += 1;
      return request(target, context, turn);
    });
  return { request: wrapped, made };
};

/** One turn through the loop, with Anthropic chosen and the chain given; the facts and what was logged. */
const oneTurn = (requests: { readonly anthropic: ProviderRequest; readonly openAi: ProviderRequest }) => {
  const logged: Array<unknown> = [];
  const services = Layer.mergeAll(
    Layer.succeed(ModelProvider, { select: () => Effect.succeed(anthropic) }),
    anthropicThenOpenAi(requests),
    BoringContextAssembler,
    CountingTurns,
    NoTurnEndHooks,
    SmolToolRunner,
    Logger.layer([Logger.make((options) => logged.push(options.message))]),
  );
  return runTest(
    Effect.gen(function* () {
      const session = yield* openSession;
      yield* session.observe({ _tag: "SessionOpened", session: SessionId.make("s1") });
      yield* session.observe({ _tag: "InputArrived", from: { _tag: "User" }, text: InputText.make("hello") });
      return yield* session.facts;
    }).pipe(Effect.provide(services)),
  ).then((facts) => ({ facts, logged }));
};

const observed = (facts: Awaited<ReturnType<typeof oneTurn>>["facts"]) =>
  facts.flatMap((fact) => (fact._tag === "Observed" ? [fact.observation] : []));
const ending = (facts: Awaited<ReturnType<typeof oneTurn>>["facts"]) =>
  facts.flatMap((fact) => (fact._tag === "Decided" && fact.decision._tag === "TurnEnded" ? [fact.decision.ending] : []));

test("Anthropic cannot serve the request, so OpenAI answers it", async () => {
  const { facts, logged } = await oneTurn({
    anthropic: failsWith(new AiError.InternalProviderError({ description: "overloaded" })),
    openAi: answers("Hello from OpenAI."),
  });
  expect(observed(facts).find((observation) => observation._tag === "ModelResponded")).toMatchObject({
    provider: openAi.provider,
    model: openAi.model,
  });
  expect(ending(facts)).toEqual([{ _tag: "Answered" }]);
  expect(logged).toContainEqual([
    logKeys.provider.fellBack,
    {
      from: { provider: "anthropic", model: "claude-sonnet-5" },
      to: { provider: "openai", model: "gpt-5.6" },
      reason: "InternalProviderError",
      message: expect.stringContaining("overloaded"),
    },
  ]);
});

test("both providers cannot serve the request, so the turn fails with the last failure", async () => {
  const { facts } = await oneTurn({
    anthropic: failsWith(new AiError.InternalProviderError({ description: "overloaded" })),
    openAi: failsWith(new AiError.QuotaExhaustedError({})),
  });
  const failure = "ExampleProvider.respond: Quota exhausted. Check your account billing and usage limits.";
  expect(observed(facts).find((observation) => observation._tag === "ModelFailed") as unknown).toMatchObject({ failure });
  expect(ending(facts) as unknown).toEqual([{ _tag: "Failed", failure }]);
});

test("a failure another provider would not fix (a rejected key) fails the turn; OpenAI is not asked", async () => {
  const openAiRequest = counted(answers("Hello from OpenAI."));
  const { facts, logged } = await oneTurn({
    anthropic: failsWith(new AiError.AuthenticationError({ kind: "InvalidKey" })),
    openAi: openAiRequest.request,
  });
  expect(openAiRequest.made.count).toBe(0);
  expect(ending(facts) as unknown).toEqual([
    { _tag: "Failed", failure: "ExampleProvider.respond: InvalidKey: Verify your API key is correct" },
  ]);
  expect(logged.some((message) => Array.isArray(message) && message[0] === logKeys.provider.fellBack)).toBe(false);
});

test("a fallback to a provider with no request configured is a defect when the layer is built", async () => {
  const exit = await Effect.runPromiseExit(
    Layer.build(FallbackModelClient({ requests: new Map([[anthropic.provider, answers("hi")]]), fallbacks: [openAi] })).pipe(
      Effect.scoped,
    ),
  );
  expect(Exit.isFailure(exit) && Exit.hasDies(exit)).toBe(true);
});

test("each attempt runs in its own span, named for its provider and model", async () => {
  const spans = new InMemorySpanExporter();
  const chain = anthropicThenOpenAi({
    anthropic: failsWith(new AiError.InternalProviderError({ description: "overloaded" })),
    openAi: answers("Hello from OpenAI."),
  });
  const attempts = await runTest(
    Effect.gen(function* () {
      const client = yield* ModelClient;
      yield* client.respond(anthropic, { system: undefined, tools: [], messages: [] }, TurnId.make("turn-1"));
      // Read before the telemetry layer is released: shutting it down clears the in-memory exporter.
      return spans.getFinishedSpans().map((span) => ({ name: span.name, attributes: span.attributes }));
    }).pipe(Effect.provide(Layer.mergeAll(chain, AgentTelemetry({ spans: new SimpleSpanProcessor(spans) })))),
  );
  expect(attempts).toEqual([
    { name: "agent.model.attempt", attributes: { provider: "anthropic", model: "claude-sonnet-5" } },
    { name: "agent.model.attempt", attributes: { provider: "openai", model: "gpt-5.6" } },
  ]);
});
