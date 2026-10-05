/**
 * A host's own record of a session: `host.json` in the session's folder, next to its facts
 * (`directory.ts`). It holds what a host keeps of a session that is not a fact (its working folder,
 * its title). This module stores and returns it as JSON and does not interpret its contents, which
 * belong to the host.
 */

import { Data, Effect, FileSystem } from "effect";
import { sessionFolderOf, storedSessions } from "./directory.ts";
import { logKeys } from "./log-keys.ts";

/** A session's record could not be written, or read as JSON. */
export class RecordFailed extends Data.TaggedError("RecordFailed")<{ readonly file: string; readonly message: string }> {}

/** Returns the file that holds a session's record. */
export const recordFileOf = (root: string, sessionId: string): string => `${sessionFolderOf(root, sessionId)}/host.json`;

/**
 * Writes `record` as the record of the session `sessionId`, replacing any existing record, and
 * creates the session's folder when it does not exist. The record is written to another file,
 * flushed to the disk, and renamed over the old record, so a reader finds the old record or the new
 * one, never part of one.
 */
export const writeRecord = (root: string, sessionId: string, record: Readonly<Record<string, unknown>>) => {
  const file = recordFileOf(root, sessionId);
  const partial = `${file}.partial`;
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(sessionFolderOf(root, sessionId), { recursive: true });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* fs.open(partial, { flag: "w" });
        yield* handle.writeAll(new TextEncoder().encode(`${JSON.stringify(record)}\n`));
        yield* handle.sync;
      }),
    );
    yield* fs.rename(partial, file);
  }).pipe(Effect.catchTag("PlatformError", (error) => Effect.fail(new RecordFailed({ file, message: `${file} could not be written: ${error.message}` }))));
};

/** Reads the record of the session `sessionId` as JSON, or returns `undefined` when it has none. A file that is not JSON fails with `RecordFailed`. */
export const readRecord = (root: string, sessionId: string) => {
  const file = recordFileOf(root, sessionId);
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(file))) return undefined;
    const text = yield* fs.readFileString(file);
    return yield* Effect.try({
      try: (): unknown => JSON.parse(text),
      catch: (error) => new RecordFailed({ file, message: `${file} is not JSON: ${error instanceof Error ? error.message : String(error)}` }),
    });
  }).pipe(Effect.catchTag("PlatformError", (error) => Effect.fail(new RecordFailed({ file, message: `${file} could not be read: ${error.message}` }))));
};

/**
 * Lists the sessions in `root` that have a facts file, the one written to last first
 * (`storedSessions`), each with its record, or `undefined` when it has none or its record does not
 * read. An unreadable record is logged as a warning (`host_record.unreadable`), and the session is
 * listed without it.
 */
export const recordedSessions = (root: string) =>
  Effect.gen(function* () {
    const stored = yield* storedSessions(root);
    return yield* Effect.forEach(stored, ({ sessionId, at }) =>
      readRecord(root, sessionId).pipe(
        Effect.catchTag("RecordFailed", (error) =>
          Effect.logWarning(logKeys.record.unreadable, { session: sessionId, file: error.file, cause: error.message }).pipe(Effect.as(undefined)),
        ),
        Effect.map((record) => ({ sessionId, at, record })),
      ),
    );
  });
