/**
 * Where a session's facts are kept. The loop requires a store (`openSession`): it writes each fact
 * to the store before it acts on the fact, and reads the facts back from it. There are two stores:
 *
 * - `FileBackedSessionStore` (`file-session-store.ts`): the facts in a file, one JSON line each,
 *   written before `append` returns, and read back when the store is opened.
 * - `ephemeralSessionStore` (`agent-host/ephemeral-session.ts`): the facts in memory, lost when the
 *   process ends, for a session that is not saved.
 *
 * A session opened on a store that already holds facts continues from them.
 */

import { Context, Data, type Effect } from "effect";
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
