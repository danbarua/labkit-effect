/**
 * A folder of sessions: each session in its own folder, `<root>/<session>/`, with its facts in
 * `facts.jsonl`, kept by the file-backed session store (`agent-session/file-session-store.ts`). This
 * module lists and reads the sessions, so a host can offer them to pick from or continue one.
 */

import { Array as Arr, Data, Effect, FileSystem, Option, Order } from "effect";
import type { Fact } from "../agent-machine/fact.ts";
import { modelOf } from "../agent-session/configuration/session-setup.ts";
import { readFacts } from "../agent-session/file-session-store.ts";

/** The folder of sessions could not be read, for the reason in `message`. */
export class DirectoryUnreadable extends Data.TaggedError("DirectoryUnreadable")<{ readonly message: string }> {}

/** `root` holds no session `sessionId`. */
export class SessionNotFound extends Data.TaggedError("SessionNotFound")<{ readonly root: string; readonly sessionId: string }> {}

/** `root` holds no session at all. */
export class NoSessionStored extends Data.TaggedError("NoSessionStored")<{ readonly root: string }> {}

/** Returns the folder that holds a session's files. */
export const sessionFolderOf = (root: string, sessionId: string): string => `${root}/${sessionId}`;

/** Returns the file that holds a session's facts. */
export const storeFileOf = (root: string, sessionId: string): string => `${sessionFolderOf(root, sessionId)}/facts.jsonl`;

/** Lists the sessions in `root`, the one written to last first, each with its last write time. A folder with no facts file is not a session. */
export const storedSessions = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const names = (yield* fs.exists(root)) ? yield* fs.readDirectory(root) : [];
    const kept = yield* Effect.filter(names, (name) => fs.exists(storeFileOf(root, name)));
    const dated = yield* Effect.forEach(kept, (sessionId) =>
      fs.stat(storeFileOf(root, sessionId)).pipe(Effect.map((info) => ({ sessionId, at: Option.getOrUndefined(info.mtime) }))),
    );
    // The one written to last first; a session whose time cannot be read sorts as the oldest.
    return Arr.sort(dated, Order.mapInput(Order.flip(Order.Number), (each: (typeof dated)[number]) => each.at?.getTime() ?? 0));
  }).pipe(Effect.catchTag("PlatformError", (error) => Effect.fail(new DirectoryUnreadable({ message: error.message }))));

/** Reads the facts of the session `sessionId` in `root`. A facts file that does not read fails with the store's error (`SessionStoreFailed`). */
export const readSession = (root: string, sessionId: string) =>
  Effect.gen(function* () {
    const file = storeFileOf(root, sessionId);
    if (!(yield* (yield* FileSystem.FileSystem).exists(file))) return yield* new SessionNotFound({ root, sessionId });
    const facts: ReadonlyArray<Fact> = (yield* readFacts(file)).facts;
    return { sessionId, facts };
  }).pipe(Effect.catchTag("PlatformError", (error) => Effect.fail(new DirectoryUnreadable({ message: error.message }))));

/** Reads the facts of the session written to last in `root`. */
export const latestSession = (root: string) =>
  Effect.gen(function* () {
    const latest = (yield* storedSessions(root))[0];
    if (latest === undefined) return yield* new NoSessionStored({ root });
    return yield* readSession(root, latest.sessionId);
  });

/** Returns a session's summary, for picking one: how many turns it started, and the model it asks now. */
export const summaryOf = (facts: ReadonlyArray<Fact>) =>
  Effect.map(modelOf(facts), (model) => ({
    turns: facts.filter((fact) => fact._tag === "Observed" && fact.observation._tag === "TurnStarted").length,
    model: `${model.provider}/${model.model}`,
  }));
