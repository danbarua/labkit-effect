/**
 * The simplest `Turns` and `TurnEndHooks`: turn identities from a counter, and no hooks.
 */

import { Effect, Layer } from "effect";
import { TurnId } from "../agent-core/names.ts";
import { TurnEndHooks, Turns } from "./contracts.ts";

/** No hooks: a turn ends as soon as it may. */
export const NoTurnEndHooks = Layer.succeed(TurnEndHooks, { hooks: [], maxHolds: 0 });

/** Turn identities `turn-1`, `turn-2`, … in the order turns start. */
export const CountingTurns = Layer.sync(Turns, () => {
  const started = { count: 0 };
  return {
    start: Effect.sync(() => {
      started.count += 1;
      return TurnId.make(`turn-${started.count}`);
    }),
  };
});
