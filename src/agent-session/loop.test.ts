/** The loop around the core, with stub services: what it does regardless of which adapters run. */

import { expect } from "bun:test";
import { test } from "../../tests/support/test.ts";
import { Effect, Layer, Logger, PubSub, References } from "effect";
import { ModelName, ModelText, ProviderName, SessionId, StopReason, TurnId } from "../agent-machine/names.ts";
import { CurrentWork, type Work } from "./work.ts";
import type { Observation } from "../agent-machine/observation.ts";
import { BoringContextAssembler, BoringModelProvider } from "../../tests/support/boring.ts";
import { CountingTurns } from "./turns.ts";
import { MaxHolds, ModelClient, ModelProvider, TurnEndHooks } from "./contracts.ts";
import { logKeys } from "./log-keys.ts";
import { openSession } from "./loop.ts";
import { EphemeralSessionStore } from "./session-store.ts";
import { receivedJson } from "./received.ts";
import { SmolToolRunner } from "../../tests/support/smol-tools.ts";
import { runTest } from "../../tests/support/run.ts";
import { boringOpening } from "../../tests/support/boring.ts";

test("while a request is carried out, CurrentWork and every log line name its session and turn; every line names the test", async () => {
  const logged: Array<{ message: unknown; annotations: Record<string, unknown> }> = [];
  const worked: Array<Work> = [];
  const capture = Logger.make((options) => {
    logged.push({ message: options.message, annotations: { ...options.fiber.getRef(References.CurrentLogAnnotations) } });
  });
  const client = Layer.succeed(ModelClient, {
    respond: (target, _context, turn) =>
      Effect.gen(function* () {
        yield* Effect.logInfo("stub.responding");
        worked.push(yield* CurrentWork);
      }).pipe(
        Effect.as({
          _tag: "ModelResponded" as const,
          turn,
          provider: target.provider,
          model: target.model,
          parts: [{ _tag: "Text" as const, text: ModelText.make("ok") }],
          stop: StopReason.make("end_turn"),
          ending: { _tag: "Complete" },
          metadata: receivedJson({}),
        }),
      ),
  });
  const provider = Layer.succeed(ModelProvider, {
    select: () =>
      Effect.succeed({
        provider: ProviderName.make("stub"),
        model: ModelName.make("stub-1"),
      }),
  });
  await runTest(
    Effect.gen(function* () {
      const session = yield* openSession.pipe(Effect.provide(EphemeralSessionStore));
      yield* session.observe(boringOpening());
      yield* session.idle;
      yield* session.observe({ _tag: "InputArrived", from: { _tag: "User" }, text: "hi" } as unknown as Observation);
      yield* session.idle;
    }).pipe(
      Effect.provide(
        Layer.mergeAll(provider, client, BoringContextAssembler, CountingTurns, SmolToolRunner, Logger.layer([capture], { mergeWithExisting: true })),
      ),
    ),
  );
  const expected = { session: SessionId.make("s1"), turn: TurnId.make("turn-1") };
  const origin = {
    _tag: "Test",
    name: "while a request is carried out, CurrentWork and every log line name its session and turn; every line names the test",
  };
  expect(logged).toContainEqual({ message: ["stub.responding"], annotations: { ...expected, origin } });
  // Every decision recorded is also logged, for whoever is debugging the loop.
  expect(logged.filter((line) => Array.isArray(line.message) && line.message[0] === logKeys.loop.decisionRecorded)).toEqual(
    ["InputDelivered", "AskModel", "TurnCompleted", "TurnEnded"].map((decision) => ({
      message: [logKeys.loop.decisionRecorded, expect.objectContaining({ decision })],
      annotations: { session: SessionId.make("s1"), origin },
    })),
  );
  expect(worked).toEqual([expected]);
});

/** A model that answers every request with text. */
const answering = Layer.succeed(ModelClient, {
  respond: (target, _context, turn) =>
    Effect.succeed({
      _tag: "ModelResponded" as const,
      turn,
      provider: target.provider,
      model: target.model,
      parts: [{ _tag: "Text" as const, text: ModelText.make("Done.") }],
      stop: StopReason.make("end_turn"),
      ending: { _tag: "Complete" },
      metadata: receivedJson({}),
    }),
});

const stubProvider = Layer.succeed(ModelProvider, {
  select: () => Effect.succeed({ provider: ProviderName.make("stub"), model: ModelName.make("stub-1") }),
});

/** A loop over the answering model, with the given turn-end hooks. */
async function answeringTurn(hooks: ReadonlyArray<() => ReadonlyArray<string>>, maxHolds: number) {
  const logged: Array<unknown> = [];
  const capture = Logger.make((options) => {
    logged.push(options.message);
  });
  const turnEndHooks = Layer.mergeAll(
    Layer.succeed(
      TurnEndHooks,
      hooks.map((hook) => () => Effect.sync(hook)),
    ),
    Layer.succeed(MaxHolds, maxHolds),
  );
  const facts = await runTest(
    Effect.gen(function* () {
      const session = yield* openSession.pipe(Effect.provide(EphemeralSessionStore));
      yield* session.observe(boringOpening());
      yield* session.idle;
      yield* session.observe({ _tag: "InputArrived", from: { _tag: "User" }, text: "hi" } as unknown as Observation);
      yield* session.idle;
      return yield* session.facts;
    }).pipe(
      Effect.provide(
        Layer.mergeAll(stubProvider, answering, BoringContextAssembler, CountingTurns, turnEndHooks, SmolToolRunner, Logger.layer([capture], { mergeWithExisting: true })),
      ),
    ),
  );
  const tags = facts.map((fact) => (fact._tag === "Observed" ? fact.observation._tag : fact.decision._tag));
  return { facts, tags, logged };
}

test("a turn-end hook's feedback holds the turn open; the turn ends when the hooks have nothing more", async () => {
  const feedback = ["Write the session up before stopping."];
  const { facts, tags, logged } = await answeringTurn([() => feedback.splice(0)], 5);
  expect(tags).toEqual([
    "SessionOpened",
    "InputArrived",
    "TurnStarted",
    "InputDelivered",
    "AskModel",
    "ModelRequestDispatched",
    "ModelResponded",
    "TurnCompleted",
    "InputArrived",
    "InputDelivered",
    "TurnEndReviewed",
    "TellModel",
    "ModelRequestDispatched",
    "ModelResponded",
    "TurnCompleted",
    "TurnEndReviewed",
    "TurnEnded",
  ]);
  expect(facts[8] as unknown).toMatchObject({
    observation: { from: { _tag: "System" }, text: "Write the session up before stopping." },
  });
  expect(logged).toContainEqual([logKeys.loop.turnHeld, { hold: 1, maxHolds: 5, feedback: 1 }]);
});

test("a hook that never lets go holds the turn at most maxHolds times, then the turn ends", async () => {
  const { facts, tags, logged } = await answeringTurn([() => ["Not yet."]], 2);
  expect(tags.filter((tag) => tag === "ModelResponded")).toHaveLength(3);
  expect(tags.slice(-3)).toEqual(["TurnHoldsExhausted", "TurnEndReviewed", "TurnEnded"]);
  // What the hooks would still have said is on record.
  expect(facts.find((fact) => fact._tag === "Observed" && fact.observation._tag === "TurnHoldsExhausted") as unknown).toMatchObject({
    observation: { holds: 2, feedback: ["Not yet."] },
  });
  expect(logged).toContainEqual([logKeys.loop.holdsExhausted, { holds: 2, maxHolds: 2, feedback: ["Not yet."] }]);
});

test("a hook that holds the turn its maxHolds times and then lets go ends it with no holds run out", async () => {
  const feedback = ["Write the session up before stopping."];
  const { tags, logged } = await answeringTurn([() => feedback.splice(0)], 1);
  expect(tags.filter((tag) => tag === "ModelResponded")).toHaveLength(2);
  expect(tags).not.toContain("TurnHoldsExhausted");
  expect(tags.slice(-2)).toEqual(["TurnEndReviewed", "TurnEnded"]);
  expect(logged.some((line) => Array.isArray(line) && line[0] === logKeys.loop.holdsExhausted)).toBe(false);
});

test("an interruption while the turn-end hooks run stops them: their feedback is not given, the model is not asked again, and the turn ends Interrupted", async () => {
  const hookRunning = Promise.withResolvers<void>();
  const logged: Array<unknown> = [];
  const capture = Logger.make((options) => {
    logged.push(options.message);
  });
  const hooks = Layer.mergeAll(
    Layer.succeed(TurnEndHooks, [() => Effect.sync(() => hookRunning.resolve()).pipe(Effect.andThen(Effect.never))]),
    Layer.succeed(MaxHolds, 5),
  );
  const facts = await runTest(
    Effect.gen(function* () {
      const session = yield* openSession.pipe(Effect.provide(EphemeralSessionStore));
      yield* session.observe(boringOpening());
      yield* session.idle;
      yield* session.observe({ _tag: "InputArrived", from: { _tag: "User" }, text: "hi" } as unknown as Observation);
      yield* Effect.promise(() => hookRunning.promise);
      yield* session.observe({ _tag: "TurnInterrupted", turn: TurnId.make("turn-1") });
      yield* session.idle;
      return yield* session.facts;
    }).pipe(
      Effect.provide(
        Layer.mergeAll(stubProvider, answering, BoringContextAssembler, CountingTurns, hooks, SmolToolRunner, Logger.layer([capture], { mergeWithExisting: true })),
      ),
    ),
  );
  const tags = facts.map((fact) => (fact._tag === "Observed" ? fact.observation._tag : fact.decision._tag));
  expect(tags.slice(4)).toEqual(["AskModel", "ModelRequestDispatched", "ModelResponded", "TurnCompleted", "TurnInterrupted", "TurnEndReviewed", "TurnEnded"]);
  expect(facts.at(-2) as unknown).toMatchObject({ origin: { _tag: "Harness", part: "loop" }, observation: { _tag: "TurnEndReviewed" } });
  expect(facts.at(-1) as unknown).toMatchObject({ decision: { ending: { _tag: "Interrupted" } } });
  expect(logged).toContainEqual([logKeys.loop.reviewStopped, { turn: "turn-1" }]);
});

test("a subscriber receives every fact recorded after it subscribed, in order", async () => {
  const client = Layer.succeed(ModelClient, {
    respond: (target, _context, turn) =>
      Effect.succeed({
        _tag: "ModelResponded" as const,
        turn,
        provider: target.provider,
        model: target.model,
        parts: [{ _tag: "Text" as const, text: ModelText.make("ok") }],
        stop: StopReason.make("end_turn"),
        ending: { _tag: "Complete" },
        metadata: receivedJson({}),
      }),
  });
  const provider = Layer.succeed(ModelProvider, {
    select: () => Effect.succeed({ provider: ProviderName.make("stub"), model: ModelName.make("stub-1") }),
  });
  const { received, facts } = await runTest(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* openSession.pipe(Effect.provide(EphemeralSessionStore));
        yield* session.observe(boringOpening());
        yield* session.idle;
        const subscription = yield* session.subscribe;
        yield* session.observe({ _tag: "InputArrived", from: { _tag: "User" }, text: "hi" } as unknown as Observation);
        yield* session.idle;
        return { received: yield* PubSub.takeAll(subscription), facts: yield* session.facts };
      }),
    ).pipe(Effect.provide(Layer.mergeAll(provider, client, BoringContextAssembler, CountingTurns, SmolToolRunner))),
  );
  expect([...received]).toEqual(facts.slice(1));
});

test("a request that dies of a defect is logged with what it died of, and recorded as failed, so the turn ends", async () => {
  const logged: Array<unknown> = [];
  const dying = Layer.succeed(ModelClient, { respond: () => Effect.die(new Error("No request is configured for provider boring")) });
  const facts = await runTest(
    Effect.gen(function* () {
      const session = yield* openSession.pipe(Effect.provide(EphemeralSessionStore));
      yield* session.observe(boringOpening());
      yield* session.observe({ _tag: "InputArrived", from: { _tag: "User" }, text: "hello" } as unknown as Observation);
      yield* session.idle;
      return yield* session.facts;
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          BoringModelProvider,
          BoringContextAssembler,
          dying,
          CountingTurns,
          SmolToolRunner,
          Logger.layer([Logger.make((options) => logged.push(options.message))], { mergeWithExisting: true }),
        ),
      ),
    ),
  );
  expect(facts.slice(-2) as unknown).toMatchObject([
    { origin: { _tag: "Harness", part: "loop" }, observation: { _tag: "ModelFailed", failure: "The request died: No request is configured for provider boring" } },
    { decision: { _tag: "TurnEnded", ending: { _tag: "Failed" } } },
  ]);
  expect(logged).toContainEqual([
    logKeys.loop.requestDied,
    expect.objectContaining({ request: "RequestModelResponse", turn: "turn-1", defect: expect.stringContaining("No request is configured for provider boring") }),
  ]);
});
