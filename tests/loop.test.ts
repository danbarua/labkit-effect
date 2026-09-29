/** The loop around the core, with stub services: what it does regardless of which adapters run. */

import { expect, test } from "bun:test";
import { Effect, Layer, Logger, References } from "effect";
import { ModelName, ModelText, ProviderName, StopReason, TurnId } from "../src/agent-core/names.ts";
import type { Observation } from "../src/agent-core/observation.ts";
import { BoringContextAssembler, CountingTurns, NoTurnEndHooks } from "../src/agent-effect/boring.ts";
import { ModelClient, ModelProvider, TurnEndHooks } from "../src/agent-effect/contracts.ts";
import { logKeys } from "../src/agent-effect/log-keys.ts";
import { openSession } from "../src/agent-effect/loop.ts";
import { receivedJson } from "../src/agent-effect/received.ts";
import { SmolToolRunner } from "../src/agent-effect/smol-tools.ts";

test("a log line written while a request is carried out carries the request's turn", async () => {
  const logged: Array<{ message: unknown; annotations: Record<string, unknown> }> = [];
  const capture = Logger.make((options) => {
    logged.push({ message: options.message, annotations: { ...options.fiber.getRef(References.CurrentLogAnnotations) } });
  });
  const client = Layer.succeed(ModelClient, {
    respond: (target, _context, turn) =>
      Effect.logInfo("stub.responding").pipe(
        Effect.as({
          _tag: "ModelResponded" as const,
          turn,
          provider: target.provider,
          model: target.model,
          parts: [{ _tag: "Text" as const, text: ModelText.make("ok") }],
          stop: StopReason.make("end_turn"),
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
  await Effect.runPromise(
    Effect.gen(function* () {
      const session = yield* openSession;
      yield* session.observe({ _tag: "SessionOpened", session: "s1" } as unknown as Observation);
      yield* session.observe({ _tag: "InputArrived", from: { _tag: "User" }, text: "hi" } as unknown as Observation);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(provider, client, BoringContextAssembler, CountingTurns, NoTurnEndHooks, SmolToolRunner, Logger.layer([capture])),
      ),
    ),
  );
  expect(logged).toContainEqual({ message: ["stub.responding"], annotations: { turn: TurnId.make("turn-1") } });
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
  const facts = await Effect.runPromise(
    Effect.gen(function* () {
      const session = yield* openSession;
      yield* session.observe({ _tag: "SessionOpened", session: "s1" } as unknown as Observation);
      yield* session.observe({ _tag: "InputArrived", from: { _tag: "User" }, text: "hi" } as unknown as Observation);
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
  expect(tags.at(-1)).toBe("TurnEnded");
  expect(logged).toContainEqual([logKeys.loop.holdsExhausted, { holds: 2, maxHolds: 2 }]);
});
