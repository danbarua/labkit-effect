/**
 * When a user's change of a session's configuration is made. A change is a fact once it is observed
 * (`ModelChangeArrived`); when it is observed is decided here, outside the core: at once while no
 * turn runs; while one runs, it is held and made when the turn ends (`settle`), so the model that
 * started a turn completes it. Changes held are merged in the order they came (`merge`: the later's
 * fields win). What the system changes, a fallback to another model when one cannot answer, does not
 * come here: it is observed at once, and the core takes it between steps, so the turn can complete.
 *
 * A change held is not a fact until it is made: if the process ends while it is held, it is lost.
 */

import { Effect, Ref, Semaphore } from "effect";

export interface ConfigurationGate<C, E> {
  /** Makes `change` at once while no turn runs, and says so; holds it while one does. */
  readonly submit: (change: C) => Effect.Effect<"made" | "held", E>;
  /** Makes the change held, if there is one and no turn runs: for a host to run when a turn ends, and before one starts. */
  readonly settle: Effect.Effect<void, E>;
  /** The change held, if any: what the next turn will run with, beside the facts. */
  readonly held: Effect.Effect<C | undefined>;
}

export const makeConfigurationGate = <C, E>(options: {
  /** Whether a turn runs now. */
  readonly running: Effect.Effect<boolean>;
  /** A change held, and one that came after it, as one change. */
  readonly merge: (held: C, next: C) => C;
  /** Makes a change: observes it, or sets what it sets. */
  readonly make: (change: C) => Effect.Effect<void, E>;
}): Effect.Effect<ConfigurationGate<C, E>> =>
  Effect.gen(function* () {
    const held = yield* Ref.make<C | undefined>(undefined);
    // One at a time: a change submitted while the held one is being made waits for it, so none is lost.
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
