/**
 * The stores of an ephemeral session: a session that is not saved. Its facts, its blobs and its
 * compaction summaries are kept in memory and lost when the process ends, so nothing of it is written
 * to disk (the CLI's `--no-session-persistence`).
 *
 * This module is the only place these in-memory stores exist. `withSession` takes them for a session
 * that is not saved (`persist: false`); a session that is saved takes the file stores. The lint rule
 * `no-restricted-imports` reports an import of this module from any other application code
 * (`oxlint.config.ts`), so a saved session cannot fall back to memory. Examples that keep no session,
 * tests and probes import it.
 */

import { Effect, HashMap, Layer, Option, Ref } from "effect";
import type { WindowSummary } from "../agent-context/forks.ts";
import { Summaries } from "../agent-context/compaction.ts";
import type { BlobId } from "../agent-machine/blob.ts";
import type { Fact } from "../agent-machine/fact.ts";
import { Blobs, blobRefOf } from "../agent-session/blobs.ts";
import { SessionStore } from "../agent-session/session-store.ts";

/** A store that keeps a session's facts in memory, starting from `facts`. */
export const ephemeralSessionStore = (facts: ReadonlyArray<Fact> = []) =>
  Layer.effect(
    SessionStore,
    Effect.gen(function* () {
      const kept = yield* Ref.make(facts);
      return SessionStore.of({
        facts: Ref.get(kept),
        append: (more) => Ref.update(kept, (before) => [...before, ...more]),
      });
    }),
  );

/** A store that keeps a new session's facts in memory. */
export const EphemeralSessionStore = ephemeralSessionStore();

/** A blob store that keeps bytes in memory while its layer lasts. A blob is found by its id; its extension names a file only in a folder. */
export const EphemeralBlobs = Layer.effect(
  Blobs,
  Effect.map(Ref.make(HashMap.empty<BlobId, Uint8Array>()), (held) =>
    Blobs.of({
      store: (bytes, mediaType, name) =>
        Effect.suspend(() => {
          const reference = blobRefOf(bytes, mediaType, name);
          return Ref.update(held, HashMap.set(reference.id, bytes)).pipe(Effect.as(reference));
        }),
      read: (id) => Effect.map(Ref.get(held), (all) => Option.getOrUndefined(HashMap.get(all, id))),
    }),
  ),
);

/** Compaction summaries kept in memory while the layer lasts. */
export const EphemeralSummaries = Layer.effect(
  Summaries,
  Effect.gen(function* () {
    const all = yield* Ref.make<ReadonlyArray<WindowSummary>>([]);
    return Summaries.of({
      record: (summary) => Ref.update(all, (before) => [...before, summary]),
      recorded: Ref.get(all),
    });
  }),
);
