/**
 * Decides when a user's change of a session's configuration is made. A change becomes a fact when it
 * is observed (`ModelChangeArrived`); this gate, outside the core, decides when that happens:
 * - While no turn runs, the change is made at once.
 * - While a turn runs, the change is held and made when the host settles the gate after the turn
 *   ends (`settle`), so the model that started a turn completes it. Held changes are merged in the
 *   order they came (`merge`: the later change's fields win).
 *
 * A change made by the system (a fallback to another model when one cannot answer) does not go
 * through the gate: it is observed at once, and the core takes it between steps, so the turn can
 * complete.
 *
 * A held change is not a fact until it is made: if the process ends while it is held, it is lost.
 */

import { Effect, Ref, Semaphore } from "effect";

export interface ConfigurationGate<C, E> {
  /** Makes `change` at once while no turn runs and returns "made"; holds it while a turn runs and returns "held". */
  readonly submit: (change: C) => Effect.Effect<"made" | "held", E>;
  /** Makes the held change, if there is one and no turn runs. A host runs it when a turn ends, and before a turn starts. */
  readonly settle: Effect.Effect<void, E>;
  /** Returns the held change, if any: what the next turn will run with, in addition to the facts. */
  readonly held: Effect.Effect<C | undefined>;
}

export const makeConfigurationGate = <C, E>(options: {
  /** Whether a turn runs now. */
  readonly running: Effect.Effect<boolean>;
  /** Merges a held change and a later change into one change. */
  readonly merge: (held: C, next: C) => C;
  /** Makes a change: observes it, or applies it directly. */
  readonly make: (change: C) => Effect.Effect<void, E>;
}): Effect.Effect<ConfigurationGate<C, E>> =>
  Effect.gen(function* () {
    const held = yield* Ref.make<C | undefined>(undefined);
    // One operation at a time: a change submitted while the held change is being made waits for it, so no change is lost.
    const lock = yield* Semaphore.make(1);
    return {
      submit: (change) =>
        lock.withPermit(
          Effect.gen(function* () {
            if (!(yield* options.running)) {
              const before = yield* Ref.getAndSet(held, undefined);
              yield* options.make(before === undefined ? change : options.merge(before, change));
              return "made" as const;
            }
            yield* Ref.update(held, (before) => (before === undefined ? change : options.merge(before, change)));
            return "held" as const;
          }),
        ),
      settle: lock.withPermit(
        Effect.gen(function* () {
          if (yield* options.running) return;
          const change = yield* Ref.getAndSet(held, undefined);
          if (change !== undefined) yield* options.make(change);
        }),
      ),
      held: Ref.get(held),
    };
  });
