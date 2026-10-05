/**
 * The simplest `Turns`: turn identities from a counter.
 */

import { Effect, Layer, Ref } from "effect";
import { TurnId } from "../agent-machine/names.ts";
import { Turns } from "./contracts.ts";
import { SessionStore } from "./session-store.ts";

/**
 * Turn identities `turn-1`, `turn-2`, … in the order turns start, counting on from `already`: the
 * number of turns a session that is gone on from has started, so none of its identities is used again.
 */
export const countingTurnsAfter = (already: number) =>
  Layer.effect(
    Turns,
    Effect.map(Ref.make(already), (started) => ({
      start: Effect.map(Ref.updateAndGet(started, (count) => count + 1), (count) => TurnId.make(`turn-${count}`)),
    })),
  );

/** Turn identities `turn-1`, `turn-2`, … in the order turns start. */
export const CountingTurns = countingTurnsAfter(0);

/** Turn identities `turn-1`, `turn-2`, … counting on from the turns the session's store already holds. */
export const CountingTurnsInStore = Layer.unwrap(
  Effect.gen(function* () {
    const facts = yield* (yield* SessionStore).facts;
    return countingTurnsAfter(facts.filter((fact) => fact._tag === "Observed" && fact.observation._tag === "TurnStarted").length);
  }),
);
