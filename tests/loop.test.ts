/** The loop around the core, with stub services: what it does regardless of which adapters run. */

import { expect } from "bun:test";
import { test } from "./support/test.ts";
import { Effect, Layer, Logger, PubSub, References } from "effect";
import { ModelName, ModelText, ProviderName, SessionId, StopReason, TurnId } from "../src/agent-core/names.ts";
import { CurrentWork, type Work } from "../src/agent-effect/work.ts";
import type { Observation } from "../src/agent-core/observation.ts";
import { BoringContextAssembler } from "./support/boring.ts";
import { CountingTurns, NoTurnEndHooks } from "../src/agent-effect/turns.ts";
import { ModelClient, ModelProvider, TurnEndHooks } from "../src/agent-effect/contracts.ts";
import { logKeys } from "../src/agent-effect/log-keys.ts";
import { openSession } from "../src/agent-effect/loop.ts";
import { receivedJson } from "../src/agent-effect/received.ts";
import { SmolToolRunner } from "./support/smol-tools.ts";
import { runTest } from "./support/run.ts";
import { boringOpening } from "./support/boring.ts";

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
      const session = yield* openSession;
      yield* session.observe(boringOpening());
      yield* session.idle;
      yield* session.observe({ _tag: "InputArrived", from: { _tag: "User" }, text: "hi" } as unknown as Observation);
      yield* session.idle;
    }).pipe(
      Effect.provide(
        Layer.mergeAll(provider, client, BoringContextAssembler, CountingTurns, NoTurnEndHooks, SmolToolRunner, Logger.layer([capture])),
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
    ["InputDelivered", "ModelAsked", "TurnEnded"].map((decision) => ({
      message: [logKeys.loop.decisionRecorded, expect.objectContaining({ decision })],
      annotations: { session: SessionId.make("s1"), origin },
    })),
  );
  expect(worked).toEqual([expected]);
});

/** A model that answers every request with text, and a loop over it with the given turn-end hooks. */
async function answeringTurn(hooks: ReadonlyArray<() => ReadonlyArray<string>>, maxHolds: number) {
  const logged: Array<unknown> = [];
  const capture = Logger.make((options) => {
    logged.push(options.message);
  });
  const client = Layer.succeed(ModelClient, {
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
  const provider = Layer.succeed(ModelProvider, {
    select: () => Effect.succeed({ provider: ProviderName.make("stub"), model: ModelName.make("stub-1") }),
  });
  const turnEndHooks = Layer.succeed(TurnEndHooks, {
    hooks: hooks.map((hook) => () => Effect.sync(hook)),
    maxHolds,
  });
  const facts = await runTest(
    Effect.gen(function* () {
      const session = yield* openSession;
      yield* session.observe(boringOpening());
      yield* session.idle;
      yield* session.observe({ _tag: "InputArrived", from: { _tag: "User" }, text: "hi" } as unknown as Observation);
      yield* session.idle;
      return yield* session.facts;
    }).pipe(
      Effect.provide(
        Layer.mergeAll(provider, client, BoringContextAssembler, CountingTurns, turnEndHooks, SmolToolRunner, Logger.layer([capture])),
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
    "ModelAsked",
    "ModelResponded",
    "InputArrived",
    "InputDelivered",
    "TurnEndReviewed",
    "ModelAsked",
    "ModelResponded",
    "TurnEndReviewed",
    "TurnEnded",
  ]);
  expect(facts[6] as unknown).toMatchObject({
    observation: { from: { _tag: "System" }, text: "Write the session up before stopping." },
  });
  expect(logged).toContainEqual([logKeys.loop.turnHeld, { hold: 1, maxHolds: 5, feedback: 1 }]);
});

test("a hook that never lets go holds the turn at most maxHolds times, then the turn ends", async () => {
  const { tags, logged } = await answeringTurn([() => ["Not yet."]], 2);
  expect(tags.filter((tag) => tag === "ModelResponded")).toHaveLength(3);
  expect(tags.slice(-3)).toEqual(["TurnHoldsExhausted", "TurnEndReviewed", "TurnEnded"]);
  expect(logged).toContainEqual([logKeys.loop.holdsExhausted, { holds: 2, maxHolds: 2 }]);
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
        const session = yield* openSession;
        yield* session.observe(boringOpening());
        yield* session.idle;
        const subscription = yield* session.subscribe;
        yield* session.observe({ _tag: "InputArrived", from: { _tag: "User" }, text: "hi" } as unknown as Observation);
        yield* session.idle;
        return { received: yield* PubSub.takeAll(subscription), facts: yield* session.facts };
      }),
    ).pipe(Effect.provide(Layer.mergeAll(provider, client, BoringContextAssembler, CountingTurns, NoTurnEndHooks, SmolToolRunner))),
  );
  expect([...received]).toEqual(facts.slice(1));
});
