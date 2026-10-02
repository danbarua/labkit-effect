/**
 * Where the CLI keeps sessions: each in a folder of its own, `logs/cli/<session>/`, its facts in
 * `facts.jsonl`, in the file-backed session store (`agent-session/file-session-store.ts`), which
 * writes each fact before the session acts on it, and its log lines beside them (`session.ts`).
 * `--continue` goes on from the session written to last, `--resume <session>` from the one named.
 * This module finds and reads them, for picking one.
 */

import { Effect, FileSystem, Option } from "effect";
import type { Fact } from "../../agent-machine/fact.ts";
import { modelOf } from "../../agent-session/configuration/session-setup.ts";
import { readFacts } from "../../agent-session/file-session-store.ts";
import { invalid } from "./invalid.ts";

export const storeFolder = "logs/cli";

/** The folder a session's files are in. */
export const sessionFolderOf = (sessionId: string, folder: string = storeFolder): string => `${folder}/${sessionId}`;

export const storeFileOf = (sessionId: string, folder: string = storeFolder): string => `${sessionFolderOf(sessionId, folder)}/facts.jsonl`;

const unreadable = (error: { readonly message: string }) => invalid(`The session store could not be read: ${error.message}`);

/** The sessions in `folder`, the one written to last first, each with when it was last written to. */
export const storedSessions = (folder: string = storeFolder) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const names = (yield* fs.exists(folder)) ? yield* fs.readDirectory(folder) : [];
    const kept = yield* Effect.filter(names, (name) => fs.exists(storeFileOf(name, folder)));
    const dated = yield* Effect.forEach(kept, (sessionId) =>
      fs.stat(storeFileOf(sessionId, folder)).pipe(Effect.map((info) => ({ sessionId, at: Option.getOrUndefined(info.mtime) }))),
    );
    return dated.sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0));
  }).pipe(Effect.catchTag("PlatformError", (error) => Effect.fail(unreadable(error))));

/** The facts of the session `sessionId` in `folder`. */
export const readSession = (sessionId: string, folder: string = storeFolder) =>
  Effect.gen(function* () {
    const file = storeFileOf(sessionId, folder);
    if (!(yield* (yield* FileSystem.FileSystem).exists(file))) return yield* invalid(`No session ${sessionId} in ${folder}.`);
    const facts: ReadonlyArray<Fact> = (yield* readFacts(file)).facts;
    return { sessionId, facts };
  }).pipe(
    Effect.catchTags({
      PlatformError: (error) => Effect.fail(unreadable(error)),
      SessionStoreFailed: (error) => Effect.fail(invalid(error.message)),
    }),
  );

/** The facts of the session written to last in `folder`. */
export const latestSession = (folder: string = storeFolder) =>
  Effect.gen(function* () {
    const latest = (yield* storedSessions(folder))[0];
    if (latest === undefined) return yield* invalid(`No session to continue: ${folder} holds none.`);
    return yield* readSession(latest.sessionId, folder);
  });

/** What a session's facts say of it, for picking one: how many turns it started, and the model it asks now. */
export const summaryOf = (facts: ReadonlyArray<Fact>) =>
  Effect.map(modelOf(facts), (model) => ({
    turns: facts.filter((fact) => fact._tag === "Observed" && fact.observation._tag === "TurnStarted").length,
    model: `${model.provider}/${model.model}`,
  }));
