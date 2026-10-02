/**
 * A folder of sessions: each in a folder of its own, `<root>/<session>/`, its facts in
 * `facts.jsonl`, in the file-backed session store (`agent-session/file-session-store.ts`), which
 * writes each fact before the session acts on it. This module finds and reads them, for picking one
 * or going on from one.
 */

import { Data, Effect, FileSystem, Option } from "effect";
import type { Fact } from "../agent-machine/fact.ts";
import { modelOf } from "../agent-session/configuration/session-setup.ts";
import { readFacts } from "../agent-session/file-session-store.ts";

/** The folder of sessions could not be read, for the reason given. */
export class DirectoryUnreadable extends Data.TaggedError("DirectoryUnreadable")<{ readonly message: string }> {}

/** `root` holds no session `sessionId`. */
export class SessionNotFound extends Data.TaggedError("SessionNotFound")<{ readonly root: string; readonly sessionId: string }> {}

/** `root` holds no session at all. */
export class NoSessionStored extends Data.TaggedError("NoSessionStored")<{ readonly root: string }> {}

/** The folder a session's files are in. */
export const sessionFolderOf = (root: string, sessionId: string): string => `${root}/${sessionId}`;

/** The file a session's facts are in. */
export const storeFileOf = (root: string, sessionId: string): string => `${sessionFolderOf(root, sessionId)}/facts.jsonl`;

/** The sessions in `root`, the one written to last first, each with when it was last written to. A folder with no facts file is no session. */
export const storedSessions = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const names = (yield* fs.exists(root)) ? yield* fs.readDirectory(root) : [];
    const kept = yield* Effect.filter(names, (name) => fs.exists(storeFileOf(root, name)));
    const dated = yield* Effect.forEach(kept, (sessionId) =>
      fs.stat(storeFileOf(root, sessionId)).pipe(Effect.map((info) => ({ sessionId, at: Option.getOrUndefined(info.mtime) }))),
    );
    return dated.sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0));
  }).pipe(Effect.catchTag("PlatformError", (error) => Effect.fail(new DirectoryUnreadable({ message: error.message }))));

/** The facts of the session `sessionId` in `root`. A facts file that does not read fails as the store says (`SessionStoreFailed`). */
export const readSession = (root: string, sessionId: string) =>
  Effect.gen(function* () {
    const file = storeFileOf(root, sessionId);
    if (!(yield* (yield* FileSystem.FileSystem).exists(file))) return yield* new SessionNotFound({ root, sessionId });
    const facts: ReadonlyArray<Fact> = (yield* readFacts(file)).facts;
    return { sessionId, facts };
  }).pipe(Effect.catchTag("PlatformError", (error) => Effect.fail(new DirectoryUnreadable({ message: error.message }))));

/** The facts of the session written to last in `root`. */
export const latestSession = (root: string) =>
  Effect.gen(function* () {
    const latest = (yield* storedSessions(root))[0];
    if (latest === undefined) return yield* new NoSessionStored({ root });
    return yield* readSession(root, latest.sessionId);
  });

/** What a session's facts say of it, for picking one: how many turns it started, and the model it asks now. */
export const summaryOf = (facts: ReadonlyArray<Fact>) =>
  Effect.map(modelOf(facts), (model) => ({
    turns: facts.filter((fact) => fact._tag === "Observed" && fact.observation._tag === "TurnStarted").length,
    model: `${model.provider}/${model.model}`,
  }));
