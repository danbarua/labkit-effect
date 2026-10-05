/**
 * Where a session's facts are kept. The loop requires a store (`openSession`): it writes each fact
 * to the store before it acts on the fact, and reads the facts back from it. There are two stores:
 *
 * - `EphemeralSessionStore`: the facts in memory, lost when the process ends.
 * - `FileBackedSessionStore` (`file-session-store.ts`): the facts in a file, one JSON line each,
 *   written before `append` returns, and read back when the store is opened.
 *
 * A session opened on a store that already holds facts continues from them.
 */

import { Context, Data, Effect, Layer, Ref } from "effect";
import type { Fact } from "../agent-machine/fact.ts";

/** Writing facts to the store failed, for the reason in `message`. Nothing after it is written. */
export class SessionStoreFailed extends Data.TaggedError("SessionStoreFailed")<{ readonly message: string }> {}

export class SessionStore extends Context.Service<
  SessionStore,
  {
    /** The session's facts, in order. */
    readonly facts: Effect.Effect<ReadonlyArray<Fact>>;
    /** Appends `facts` after those already kept, and returns once they are written. */
    readonly append: (facts: ReadonlyArray<Fact>) => Effect.Effect<void, SessionStoreFailed>;
  }
>()("agent-session/SessionStore") {}

/** A store that keeps a session's facts in memory, starting from `facts`. The facts are lost when the process ends. */
export const ephemeralSessionStore = (facts: ReadonlyArray<Fact> = []) =>
  Layer.effect(
    SessionStore,
    Effect.gen(function* () {
      const kept = yield* Ref.make(facts);
      return {
        facts: Ref.get(kept),
        append: (more) => Ref.update(kept, (before) => [...before, ...more]),
      };
    }),
  );

/** A store that keeps a new session's facts in memory. The facts are lost when the process ends. */
export const EphemeralSessionStore = ephemeralSessionStore();
