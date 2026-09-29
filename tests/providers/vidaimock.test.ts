/**
 * The three provider adapters against VidaiMock, which answers as each provider's API does: a tool
 * turn through the loop, how each HTTP error status becomes an `AiError` reason, retries, and what
 * a failed request records.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect, Exit, Layer, Logger, Schema } from "effect";
import * as AiError from "effect/ai/AiError";
import type { Fact } from "../../src/agent-core/fact.ts";
import { InputText, ModelName, ProviderName, TurnId } from "../../src/agent-core/names.ts";
import type { ModelClient, ModelContext, ProviderRequest } from "../../src/agent-effect/contracts.ts";
import { BoringModelProvider } from "../support/boring.ts";
import { CountingTurns, NoTurnEndHooks } from "../../src/agent-effect/turns.ts";
import { SmolToolRunner, smolCatalog } from "../support/smol-tools.ts";
import { logKeys } from "../../src/agent-effect/log-keys.ts";
import { openSession } from "../../src/agent-effect/loop.ts";
import type { Retries } from "../../src/agent-effect/provider-call.ts";
import { anthropicModelClient, anthropicRequests } from "../../src/agent-effect/providers/anthropic-client.ts";
import { openAiModelClient, openAiRequests } from "../../src/agent-effect/providers/openai-client.ts";
import { openAiCompatModelClient, openAiCompatRequests } from "../../src/agent-effect/providers/openai-compat-client.ts";
import { TurnContextAssembler } from "../../src/agent-effect/turn-context.ts";
import { runTest } from "../support/run.ts";
import { boringOpening } from "../support/boring.ts";
import { anthropicAtMock, openAiAtMock, openAiCompatAtMock, startVidaiMock, type VidaiMock } from "../support/vidaimock.ts";

const state: { mock?: VidaiMock } = {};
beforeAll(async () => {
  state.mock = await startVidaiMock();
});
afterAll(() => state.mock?.stop());
const mock = (): VidaiMock => {
  if (state.mock === undefined) throw new Error("VidaiMock did not start");
  return state.mock;
};

const noRetries: Retries = { times: 0, firstWait: "1 millis" };

/** An adapter at the mock: its requests, and its model client; with `status`, every request is answered with it. */
interface AtMock {
  readonly name: string;
  readonly requests: (status?: number) => Effect.Effect<ProviderRequest>;
  readonly client: (retries: Retries, status?: number) => Layer.Layer<ModelClient>;
}

const adapters: ReadonlyArray<AtMock> = [
  {
    name: "Anthropic Messages",
    requests: (status) => anthropicRequests(noRetries).pipe(Effect.provide(anthropicAtMock(mock(), status))),
    client: (retries, status) => anthropicModelClient(retries).pipe(Layer.provide(anthropicAtMock(mock(), status))),
  },
  {
    name: "OpenAI Responses",
    requests: (status) => openAiRequests(noRetries).pipe(Effect.provide(openAiAtMock(mock(), status))),
    client: (retries, status) => openAiModelClient(retries).pipe(Layer.provide(openAiAtMock(mock(), status))),
  },
  {
    name: "OpenAI-compatible Chat Completions",
    requests: (status) => openAiCompatRequests(noRetries).pipe(Effect.provide(openAiCompatAtMock(mock(), status))),
    client: (retries, status) => openAiCompatModelClient(retries).pipe(Layer.provide(openAiCompatAtMock(mock(), status))),
  },
];

/** One request through `adapter` at the mock, answered with `status`: the error it failed with, if it did. */
const failureOf = async (adapter: AtMock, status: number): Promise<AiError.AiError | undefined> => {
  const context: ModelContext = { system: undefined, tools: [], messages: [{ role: "user", parts: [{ _tag: "Text", text: "hi" }] }] };
  const target = { provider: ProviderName.make("mock"), model: ModelName.make("mock-1") };
  const exit = await Effect.runPromiseExit(
    adapter.requests(status).pipe(Effect.flatMap((respond) => respond(target, context, TurnId.make("turn-1")))),
  );
  return Exit.isFailure(exit) ? exit.cause.reasons.flatMap((cause) => (cause._tag === "Fail" ? [cause.error] : []))[0] : undefined;
};

/** A session with one input, through the loop, with `adapter`'s model client; its facts and log. */
const oneTurn = (client: Layer.Layer<ModelClient>) => {
  const logged: Array<unknown> = [];
  const services = Layer.mergeAll(
    BoringModelProvider,
    client,
    TurnContextAssembler,
    CountingTurns,
    NoTurnEndHooks,
    SmolToolRunner,
    Logger.layer([Logger.make((options) => logged.push(options.message))]),
  );
  return runTest(
    Effect.gen(function* () {
      const session = yield* openSession;
      yield* session.observe(boringOpening(smolCatalog));
      yield* session.observe({ _tag: "InputArrived", from: { _tag: "User" }, text: InputText.make("What is 2 + 3?") });
      return yield* session.facts;
    }).pipe(Effect.provide(services)),
  ).then((facts) => ({ facts, logged }));
};

const tags = (facts: ReadonlyArray<Fact>) =>
  facts.map((fact) => (fact._tag === "Observed" ? fact.observation._tag : fact.decision._tag));

const decodeAiError = Schema.decodeUnknownSync(Schema.toCodecJson(AiError.AiError));

/** How each HTTP status fails a request. */
const reasons: ReadonlyArray<readonly [number, AiError.AiErrorReason["_tag"]]> = [
  [400, "InvalidRequestError"],
  [401, "AuthenticationError"],
  [403, "AuthenticationError"],
  [404, "UnknownError"],
  [429, "RateLimitError"],
  [500, "InternalProviderError"],
  [503, "InternalProviderError"],
  [529, "InternalProviderError"],
];

describe.each([...adapters])("$name at VidaiMock", (adapter) => {
  const client = adapter.client;

  test("a turn with tools: the model calls one, is sent its outcome, and answers", async () => {
    const { facts } = await oneTurn(client(noRetries));
    expect(tags(facts)).toEqual([
      "SessionOpened",
      "InputArrived",
      "TurnStarted",
      "InputDelivered",
      "ModelAsked",
      "ModelResponded",
      "ToolEnded",
      "ModelAsked",
      "ModelResponded",
      "TurnEndReviewed",
      "TurnEnded",
    ]);
    const responses = facts.flatMap((fact) =>
      fact._tag === "Observed" && fact.observation._tag === "ModelResponded" ? [fact.observation] : [],
    );
    expect(responses.map((response) => response.parts.map((part) => part._tag))).toEqual([["ToolCall"], ["Text"]]);
    expect(responses.map((response) => response.ending._tag)).toEqual(["Complete", "Complete"]);
  });

  test.each([...reasons])("HTTP %i fails the request with %s", async (status, reason) => {
    expect((await failureOf(adapter, status))?.reason._tag).toBe(reason);
  });

  test("a rate limit is retried as often as allowed, then the turn fails, recording the error", async () => {
    const { facts, logged } = await oneTurn(client({ times: 2, firstWait: "1 millis" }, 429));
    const retried = logged.filter((message) => Array.isArray(message) && message[0] === logKeys.provider.requestRetried);
    expect(retried).toHaveLength(2);
    const failed = facts.flatMap((fact) =>
      fact._tag === "Observed" && fact.observation._tag === "ModelFailed" ? [fact.observation] : [],
    );
    expect(failed).toHaveLength(1);
    const recorded = failed[0]?.error;
    expect(decodeAiError(JSON.parse(recorded?.body._tag === "Text" ? recorded.body.text : "null")).reason._tag).toBe(
      "RateLimitError",
    );
    expect(tags(facts).at(-1)).toBe("TurnEnded");
  });

  test("a rejected key is not retried", async () => {
    const { logged } = await oneTurn(client({ times: 2, firstWait: "1 millis" }, 401));
    expect(logged.some((message) => Array.isArray(message) && message[0] === logKeys.provider.requestRetried)).toBe(false);
  });
});
