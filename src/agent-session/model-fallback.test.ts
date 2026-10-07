/**
 * `FallbackModelClient` over the real Anthropic and OpenAI adapters, with VidaiMock answering as each
 * provider does, or failing with the HTTP status given; through the loop.
 */

import { afterAll, beforeAll, expect } from "bun:test";
import { test } from "../../tests/support/test.ts";
import { Effect, Exit, Layer, Logger, Schema } from "effect";
import * as AiError from "effect/ai/AiError";
import type { Fact } from "../agent-machine/fact.ts";
import { InputText, ModelName, ProviderName, SessionId, TurnId } from "../agent-machine/names.ts";
import type { Observation } from "../agent-machine/observation.ts";
import type { Received } from "../agent-machine/received.ts";
import { ModelClient, type Target } from "./contracts.ts";
import { ModelFromFacts } from "./configuration/model-choice.ts";
import { openedWith } from "./configuration/session-setup.ts";
import { BoringContextAssembler } from "../../tests/support/boring.ts";
import { CountingTurns } from "./turns.ts";
import { SmolToolRunner } from "../../tests/support/smol-tools.ts";
import { logKeys } from "./log-keys.ts";
import { openSession } from "./loop.ts";
import { EphemeralSessionStore } from "./session-store.ts";
import { FallbackModelClient } from "./model-fallback.ts";
import type { Retries } from "./provider-call.ts";
import { anthropicRequests } from "./providers/anthropic-client.ts";
import { Report } from "./report.ts";
import { openAiRequests } from "./providers/openai-client.ts";
import { type SpanLine, SpansTo } from "../instrumentation/telemetry.ts";
import { observedAttempts } from "../instrumentation/model-attempts.ts";
import { runTest } from "../../tests/support/run.ts";
import { anthropicAtMock, openAiAtMock, startVidaiMock, type VidaiMock } from "../../tests/support/vidaimock.ts";

const state: { mock?: VidaiMock } = {};
beforeAll(async () => {
  state.mock = await startVidaiMock();
});
afterAll(() => state.mock?.stop());
const mock = (): VidaiMock => {
  if (state.mock === undefined) throw new Error("VidaiMock did not start");
  return state.mock;
};

const anthropic: Target = { provider: ProviderName.make("anthropic"), model: ModelName.make("claude-sonnet-5") };
const openAi: Target = { provider: ProviderName.make("openai"), model: ModelName.make("gpt-5.6") };
const noRetries: Retries = { times: 0, firstWait: "1 millis" };

/** Anthropic, then OpenAI, each at the mock, each attempt observed as the hosts observe it; a provider given a status fails every request with it. */
const chain = (status: { readonly anthropic?: number; readonly openAi?: number }) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const requests = new Map([
        [anthropic.provider, observedAttempts(yield* anthropicRequests(noRetries))],
        [openAi.provider, observedAttempts(yield* openAiRequests(noRetries))],
      ]);
      return FallbackModelClient({ requests, fallbacks: [openAi] });
    }),
  ).pipe(Layer.provide(Layer.mergeAll(anthropicAtMock(mock(), status.anthropic), openAiAtMock(mock(), status.openAi))));

/**
 * A session that starts on Anthropic and asks the model its facts name, with one turn per input:
 * the model observations recorded, how each turn ended, and how often the chain fell back.
 */
const oneTurn = async (
  status: { readonly anthropic?: number; readonly openAi?: number },
  inputs: ReadonlyArray<string> = ["hello"],
) => {
  const logged: Array<unknown> = [];
  const facts: ReadonlyArray<Fact> = await runTest(
    Effect.gen(function* () {
      const session = yield* openSession.pipe(Effect.provide(EphemeralSessionStore));
      yield* session.observe(openedWith({ session: SessionId.make("s1"), model: anthropic, system: undefined, tools: [] }));
      yield* session.idle;
      yield* Effect.forEach(
        inputs,
        (input) =>
          session
            .observe({ _tag: "InputArrived", from: { _tag: "User" }, text: InputText.make(input) })
            .pipe(Effect.andThen(session.idle)),
        { discard: true },
      );
      return yield* session.facts;
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ModelFromFacts,
          chain(status),
          BoringContextAssembler,
          CountingTurns,
          SmolToolRunner,
          Logger.layer([Logger.make((options) => logged.push(options.message))], { mergeWithExisting: true }),
        ),
      ),
    ),
  );
  const observed = facts.flatMap((fact): ReadonlyArray<Observation> => (fact._tag === "Observed" ? [fact.observation] : []));
  const ended = facts.flatMap((fact) => (fact._tag === "Decided" && fact.decision._tag === "TurnEnded" ? [fact.decision.ending._tag] : []));
  const fellBack = logged.filter((message) => Array.isArray(message) && message[0] === logKeys.provider.fellBack).length;
  return { model: observed.filter((observation) => observation._tag.startsWith("Model")), ended, fellBack };
};

const decodeAiError = Schema.decodeUnknownSync(Schema.toCodecJson(AiError.AiError));
const reasonIn = (error: Received): string =>
  decodeAiError(JSON.parse(error.body._tag === "Text" ? error.body.text : "null")).reason._tag;

test("Anthropic is overloaded (HTTP 529), so OpenAI answers; the failed attempt is recorded with its error", async () => {
  const { model, ended, fellBack } = await oneTurn({ anthropic: 529 });
  expect(model.map((observation) => observation._tag)).toEqual([
    "ModelRequestDispatched",
    "ModelAttemptFailed",
    "ModelRequestDispatched",
    "ModelChangeArrived",
    "ModelResponded",
  ]);
  const [first, attempt, second, change, response] = model;
  expect(first).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5" });
  expect(second).toMatchObject({ provider: "openai", model: "gpt-5.6" });
  expect(attempt).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5" });
  expect(attempt?._tag === "ModelAttemptFailed" ? reasonIn(attempt.error) : undefined).toBe("InternalProviderError");
  expect(change).toMatchObject({ provider: "openai", model: "gpt-5.6" });
  expect(response).toMatchObject({ provider: "openai", model: "gpt-5.6" });
  expect(ended).toEqual(["Completed"]);
  expect(fellBack).toBe(1);
});

test("Anthropic's rate limit (HTTP 429) falls back too", async () => {
  const { model, ended } = await oneTurn({ anthropic: 429 });
  expect(model.map((observation) => observation._tag)).toEqual([
    "ModelRequestDispatched",
    "ModelAttemptFailed",
    "ModelRequestDispatched",
    "ModelChangeArrived",
    "ModelResponded",
  ]);
  expect(ended).toEqual(["Completed"]);
});

test("after falling back, the session stays on OpenAI: the next turn asks it first, and Anthropic is not tried again", async () => {
  const { model, ended, fellBack } = await oneTurn({ anthropic: 529 }, ["hello", "and again"]);
  expect(model.map((observation) => observation._tag)).toEqual([
    "ModelRequestDispatched",
    "ModelAttemptFailed",
    "ModelRequestDispatched",
    "ModelChangeArrived",
    "ModelResponded",
    "ModelRequestDispatched",
    "ModelResponded",
  ]);
  expect(model.at(-2)).toMatchObject({ provider: "openai", model: "gpt-5.6" });
  expect(model.at(-1)).toMatchObject({ provider: "openai", model: "gpt-5.6" });
  expect(ended).toEqual(["Completed", "Completed"]);
  expect(fellBack).toBe(1);
});

test("both providers are down, so the turn fails with OpenAI's error; Anthropic's is recorded as the failed attempt", async () => {
  const { model, ended } = await oneTurn({ anthropic: 503, openAi: 429 });
  expect(model.map((observation) => observation._tag)).toEqual(["ModelRequestDispatched", "ModelAttemptFailed", "ModelRequestDispatched", "ModelFailed"]);
  const [, attempt, , failed] = model;
  expect(attempt?._tag === "ModelAttemptFailed" ? reasonIn(attempt.error) : undefined).toBe("InternalProviderError");
  expect(failed?._tag === "ModelFailed" ? reasonIn(failed.error) : undefined).toBe("RateLimitError");
  expect(ended).toEqual(["Failed"]);
});

test("Anthropic rejects the key (HTTP 401): the turn fails with it, and OpenAI is not asked", async () => {
  const { model, ended, fellBack } = await oneTurn({ anthropic: 401 });
  expect(model.map((observation) => observation._tag)).toEqual(["ModelRequestDispatched", "ModelFailed"]);
  expect(model[1]?._tag === "ModelFailed" ? reasonIn(model[1].error) : undefined).toBe("AuthenticationError");
  expect(ended).toEqual(["Failed"]);
  expect(fellBack).toBe(0);
});

test("a fallback to a provider with no request configured is a defect when the layer is built", async () => {
  const exit = await Effect.runPromiseExit(
    Layer.build(
      Layer.unwrap(
        anthropicRequests(noRetries).pipe(
          Effect.map((request) => FallbackModelClient({ requests: new Map([[anthropic.provider, request]]), fallbacks: [openAi] })),
        ),
      ).pipe(Layer.provide(anthropicAtMock(mock()))),
    ).pipe(Effect.scoped),
  );
  expect(Exit.isFailure(exit) && Exit.hasDies(exit)).toBe(true);
});

test("each attempt runs in its own span, with its provider and model, and, when it fails, the HTTP status of its response that was not 2xx", async () => {
  const spans: Array<SpanLine> = [];
  const reported: Array<Observation> = [];
  const attempts = await runTest(
    Effect.gen(function* () {
      const client = yield* ModelClient;
      const context = { system: undefined, tools: [], messages: [{ role: "user" as const, parts: [{ _tag: "Text" as const, text: "hi" }] }] };
      yield* client.respond(anthropic, context, TurnId.make("turn-1"));
      return spans.map((span) => ({ name: span.name, attributes: span.attributes }));
    }).pipe(
      Effect.provide(Layer.mergeAll(chain({ anthropic: 529 }), SpansTo((line) => spans.push(line)))),
      // Outside the loop, so the test records what is reported itself.
      Effect.provideService(Report, (observation) => Effect.sync(() => reported.push(observation))),
    ),
  );
  const attemptSpans = attempts.filter((span) => span.name === "agent.model.attempt");
  expect(attemptSpans.map(({ attributes }) => [attributes["provider"], attributes["model"], attributes["outcome"], attributes["http_status"]])).toEqual([
    ["anthropic", "claude-sonnet-5", "failed", 529],
    ["openai", "gpt-5.6", "responded", undefined],
  ]);
  expect(reported.map((observation) => observation._tag)).toEqual(["ModelAttemptFailed", "ModelRequestDispatched", "ModelChangeArrived"]);
});
