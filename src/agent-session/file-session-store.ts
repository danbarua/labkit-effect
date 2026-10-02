/**
 * A session's facts in a file, one JSON line per fact (`FileBackedSessionStore`). Facts are written
 * before `append` returns, and the file is read when the store is opened, so a store opened on a
 * file that holds facts is the session gone on from them.
 *
 * - One process writes a file at a time: it holds `<file>.lock`, which holds its process id, for as
 *   long as the store is open. A lock whose process has ended (one that was killed) is taken over,
 *   and that is logged.
 * - A file is read as facts in order: the first fact 1, each the one after the one before; a file
 *   that is not is refused. A last line without its line break is a write the process did not
 *   finish: it is not read, and is cut off before the file is written to again, which is logged.
 * - Each `append` writes its facts and flushes them to the disk (`fsync`) before it returns, so
 *   what the session does after writing a fact down (a tool it runs) follows the fact being on the
 *   disk, a power cut included. A new file's folder is flushed too, so the file is found after one.
 * - A write that fails is said, with the file and the facts it did not write, and nothing is
 *   written after it.
 *
 * The format is the facts' schema as it is today; a file written before the schema changed may not
 * read back, and is deleted rather than converted.
 */

import { Effect, FileSystem, Layer, Ref, Schema } from "effect";
import { Fact } from "../agent-machine/fact.ts";
import { SessionStore, SessionStoreFailed } from "./session-store.ts";

const FactLine = Schema.fromJsonString(Fact);
const encodeLine = Schema.encodeSync(FactLine);
const decodeLine = Schema.decodeUnknownEffect(FactLine);

/** A session's file as read: its facts, and what follows its last complete line, if anything. */
export interface StoredFile {
  readonly facts: ReadonlyArray<Fact>;
  /** The bytes the complete lines take. */
  readonly bytes: number;
  /** What follows the last line break: the start of a line whose write did not finish. */
  readonly torn: string;
}

const failed = (message: string) => new SessionStoreFailed({ message });

/** The facts in `file`, in order; a file whose lines are not one session's facts in order is refused. */
export const readFacts = (file: string) =>
  Effect.gen(function* () {
    const text = yield* (yield* FileSystem.FileSystem).readFileString(file);
    const end = text.lastIndexOf("\n") + 1;
    const lines = text.slice(0, end).split("\n").slice(0, -1);
    const facts = yield* Effect.forEach(lines, (line, at) =>
      decodeLine(line).pipe(Effect.mapError((error) => failed(`${file} line ${at + 1} is not a fact as the session records them now; delete the file. ${error.message}`))),
    );
    const misplaced = facts.findIndex((fact, at) => fact.seq !== at + 1);
    if (misplaced >= 0)
      return yield* failed(`${file} line ${misplaced + 1} holds fact ${facts[misplaced]?.seq} where fact ${misplaced + 1} belongs: it is not one session's facts in order. Delete the file.`);
    const stored: StoredFile = { facts, bytes: Buffer.byteLength(text.slice(0, end)), torn: text.slice(end) };
    return stored;
  }).pipe(Effect.catchTag("PlatformError", (error) => Effect.fail(failed(`${file} could not be read: ${error.message}`))));

/** Whether the process `pid` is running. */
const running = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // The process exists, and belongs to another user.
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

/**
 * Holds `file`'s lock for as long as the scope lasts. A lock held by a running process is not
 * taken; one whose process has ended is taken over, and that is logged.
 */
const locked = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const lock = `${file}.lock`;
    const take = fs.writeFileString(lock, String(process.pid), { flag: "wx" });
    const taken = yield* take.pipe(
      Effect.as(true),
      Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.succeed(false)),
    );
    if (!taken) {
      const holder = Number(yield* fs.readFileString(lock));
      if (Number.isInteger(holder) && running(holder))
        return yield* failed(`${file} is open in another process (pid ${holder}). Close it there, or wait for it to end.`);
      yield* Effect.logWarning("session_store.lock_taken_over", { file, lock, holder, reason: "the process holding the lock has ended" });
      yield* fs.remove(lock);
      yield* take;
    }
    yield* Effect.addFinalizer(() => fs.remove(lock).pipe(Effect.ignore));
  }).pipe(Effect.catchTag("PlatformError", (error) => Effect.fail(failed(`${file}.lock could not be taken: ${error.message}`))));

/**
 * Flushes the folder `file` is in to the disk, so that a file just made there is found after a power
 * cut. A file system that cannot flush a folder is logged, and the store goes on.
 */
const folderSynced = (file: string) =>
  Effect.gen(function* () {
    const folder = file.slice(0, file.lastIndexOf("/"));
    const handle = yield* (yield* FileSystem.FileSystem).open(folder, { flag: "r" });
    yield* handle.sync;
  }).pipe(
    Effect.scoped,
    Effect.catchTag("PlatformError", (error) => Effect.logWarning("session_store.folder_not_flushed", { file, error: error.message })),
  );

/**
 * The session store kept in `file`, open for as long as the layer is: its lock taken, its facts
 * read, a line whose write did not finish cut off, and the file held open to append to.
 */
export const FileBackedSessionStore = (file: string) =>
  Layer.effect(
    SessionStore,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(file.slice(0, file.lastIndexOf("/")), { recursive: true }).pipe(
        Effect.mapError((error) => failed(`The folder for ${file} could not be made: ${error.message}`)),
      );
      yield* locked(file);
      const stored = (yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false))) ? yield* readFacts(file) : { facts: [], bytes: 0, torn: "" };
      if (stored.torn !== "") {
        yield* Effect.logWarning("session_store.torn_line_cut", { file, bytes: Buffer.byteLength(stored.torn), start: stored.torn.slice(0, 200) });
        yield* fs.truncate(file, stored.bytes).pipe(Effect.mapError((error) => failed(`${file} could not be cut to its last complete line: ${error.message}`)));
      }
      const created = !(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)));
      // Open for appending for as long as the store is; a file made here is made now.
      const opened = yield* fs.open(file, { flag: "a" }).pipe(Effect.mapError((error) => failed(`${file} could not be opened: ${error.message}`)));
      if (created) yield* folderSynced(file);
      const kept = yield* Ref.make<ReadonlyArray<Fact>>(stored.facts);
      return {
        facts: Ref.get(kept),
        // The write, its flush to the disk, and what is kept go together: a write that landed is
        // never left uncounted, and the facts count as written only once they are on the disk.
        append: (more) =>
          Effect.uninterruptible(
            Effect.gen(function* () {
              if (more.length === 0) return;
              const notWritten = (error: { readonly message: string }) =>
                failed(`Facts ${more[0]?.seq} to ${more.at(-1)?.seq} could not be written to ${file}: ${error.message}`);
              yield* opened.writeAll(new TextEncoder().encode(more.map((fact) => `${encodeLine(fact)}\n`).join(""))).pipe(Effect.mapError(notWritten));
              yield* opened.sync.pipe(Effect.mapError(notWritten));
              yield* Ref.update(kept, (before) => [...before, ...more]);
            }),
          ),
      };
    }),
  );
