/** The loop takes observations while a request is being carried out. */

import { expect } from "bun:test";
import { Deferred, Effect, Layer } from "effect";
import { ModelText, StopReason, TurnId } from "../src/agent-core/names.ts";
import type { Observation } from "../src/agent-core/observation.ts";
import { ModelClient, type ModelContext } from "../src/agent-effect/contracts.ts";
import { openSession } from "../src/agent-effect/loop.ts";
import { receivedJson } from "../src/agent-effect/received.ts";
import { TurnContextAssembler } from "../src/agent-effect/turn-context.ts";
import { CountingTurns, NoTurnEndHooks } from "../src/agent-effect/turns.ts";
import { BoringModelProvider, boringOpening } from "./support/boring.ts";
import { runTest } from "./support/run.ts";
import { SmolToolRunner } from "./support/smol-tools.ts";
import { test } from "./support/test.ts";

/**
 * A model that answers each request once `gates` lets it (one gate per request, in order), and
 * keeps what each request was sent, and whether one was interrupted while it waited.
 */
function gated(gates: ReadonlyArray<Deferred.Deferred<void>>) {
  const seen: Array<ModelContext> = [];
  const watch = { interrupted: false };
  const layer = Layer.succeed(ModelClient, {
    respond: (target, context, turn) => {
      const gate = gates[seen.length];
      seen.push(context);
      return (gate === undefined ? Effect.void : Deferred.await(gate)).pipe(
        Effect.onInterrupt(() => Effect.sync(() => void (watch.interrupted = true))),
        Effect.as({
          _tag: "ModelResponded" as const,
          turn,
          provider: target.provider,
          model: target.model,
          parts: [{ _tag: "Text" as const, text: ModelText.make(`answer ${seen.length}`) }],
          stop: StopReason.make("stop"),
          ending: { _tag: "Complete" as const },
          metadata: receivedJson({}),
        }),
      );
    },
  });
  return { layer, seen, watch };
}

const services = (model: Layer.Layer<ModelClient>) =>
  Layer.mergeAll(BoringModelProvider, TurnContextAssembler, model, CountingTurns, NoTurnEndHooks, SmolToolRunner);

const input = (text: string) => ({ _tag: "InputArrived", from: { _tag: "User" }, text }) as unknown as Observation;

const tags = (facts: ReadonlyArray<{ _tag: string; observation?: { _tag: string }; decision?: { _tag: string } }>) =>
  facts.map((fact) => fact.observation?._tag ?? fact.decision?._tag);

test("observe returns once the observation is recorded; input given while the model is asked is taken when it answers", async () => {
  const { before, after, seen } = await runTest(
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const model = gated([gate]);
      return yield* Effect.gen(function* () {
        const session = yield* openSession;
        yield* session.observe(boringOpening());
        yield* session.observe(input("first"));
        yield* session.observe(input("second"));
        const before = yield* session.facts;
        yield* Deferred.succeed(gate, undefined);
        yield* session.idle;
        return { before, after: yield* session.facts, seen: model.seen };
      }).pipe(Effect.provide(services(model.layer)));
    }),
  );
  expect(tags(before)).toEqual(["SessionOpened", "InputArrived", "TurnStarted", "InputDelivered", "ModelAsked", "InputArrived"]);
  expect(tags(after).slice(6)).toEqual([
    "ModelResponded",
    "InputDelivered",
    "TurnEndReviewed",
    "ModelAsked",
    "ModelResponded",
    "TurnEndReviewed",
    "TurnEnded",
  ]);
  expect(seen).toHaveLength(2);
});

test("an interruption while the model is asked ends the turn and the request; nothing comes of the request", async () => {
  const { facts, interrupted } = await runTest(
    Effect.gen(function* () {
      const never = yield* Deferred.make<void>();
      const model = gated([never]);
      return yield* Effect.gen(function* () {
        const session = yield* openSession;
        yield* session.observe(boringOpening());
        yield* session.observe(input("hello"));
        yield* session.observe({ _tag: "TurnInterrupted", turn: TurnId.make("turn-1") });
        yield* session.idle;
        return { facts: yield* session.facts, interrupted: model.watch.interrupted };
      }).pipe(Effect.provide(services(model.layer)));
    }),
  );
  expect(tags(facts)).toEqual([
    "SessionOpened",
    "InputArrived",
    "TurnStarted",
    "InputDelivered",
    "ModelAsked",
    "TurnInterrupted",
    "TurnEnded",
  ]);
  expect(facts.at(-1) as unknown).toMatchObject({ decision: { ending: { _tag: "Interrupted" } } });
  expect(interrupted).toBe(true);
});
