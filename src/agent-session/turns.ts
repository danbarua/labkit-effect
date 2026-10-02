/**
 * The simplest `Turns` and `TurnEndHooks`: turn identities from a counter, and no hooks.
 */

import { Effect, Layer } from "effect";
import { TurnId } from "../agent-machine/names.ts";
import { TurnEndHooks, Turns } from "./contracts.ts";
import { SessionStore } from "./session-store.ts";

/** No hooks: a turn ends as soon as it may. */
export const NoTurnEndHooks = Layer.succeed(TurnEndHooks, { hooks: [], maxHolds: 0 });

/**
 * Turn identities `turn-1`, `turn-2`, … in the order turns start, counting on from `already`: the
 * number of turns a session that is gone on from has started, so none of its identities is used again.
 */
export const countingTurnsAfter = (already: number) =>
  Layer.sync(Turns, () => {
    const started = { count: already };
    return {
      start: Effect.sync(() => {
        started.count += 1;
        return TurnId.make(`turn-${started.count}`);
      }),
    };
  });

/** Turn identities `turn-1`, `turn-2`, … in the order turns start. */
export const CountingTurns = countingTurnsAfter(0);

/** Turn identities `turn-1`, `turn-2`, … counting on from the turns the session's store already holds. */
export const CountingTurnsInStore = Layer.unwrap(
  Effect.gen(function* () {
    const facts = yield* (yield* SessionStore).facts;
    return countingTurnsAfter(facts.filter((fact) => fact._tag === "Observed" && fact.observation._tag === "TurnStarted").length);
  }),
);
