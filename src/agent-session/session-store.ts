/**
 * Where a session's facts are kept. The loop needs one to run (`openSession`): it writes each fact
 * down before it acts on it, and reads the facts back from it. There are two:
 *
 * - `EphemeralSessionStore`: the facts in memory, gone when the process ends.
 * - `FileBackedSessionStore` (`file-session-store.ts`): the facts in a file, one JSON line each,
 *   written before `append` returns, and read back when the store is opened.
 *
 * A store opened on facts already kept is a session gone on from them: the loop starts from them.
 */

import { Context, Data, Effect, Layer, Ref } from "effect";
import type { Fact } from "../agent-machine/fact.ts";

/** Writing facts down failed, for the reason given. Nothing after it is written. */
export class SessionStoreFailed extends Data.TaggedError("SessionStoreFailed")<{ readonly message: string }> {}

export class SessionStore extends Context.Service<
  SessionStore,
  {
    /** The session's facts, in order. */
    readonly facts: Effect.Effect<ReadonlyArray<Fact>>;
    /** Writes `facts` down after those already kept, and returns once they are written. */
    readonly append: (facts: ReadonlyArray<Fact>) => Effect.Effect<void, SessionStoreFailed>;
  }
>()("agent-session/SessionStore") {}

/** A session's facts in memory, starting from `facts`: gone when the process ends. */
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

/** A new session's facts in memory: gone when the process ends. */
export const EphemeralSessionStore = ephemeralSessionStore();
