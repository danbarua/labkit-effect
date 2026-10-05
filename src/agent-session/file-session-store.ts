/**
 * A session's facts in a file, one JSON line per fact (`FileBackedSessionStore`). Facts are written
 * before `append` returns, and the file is read when the store is opened, so a session opened on a
 * file that holds facts continues from them.
 *
 * - **Lock.** One process writes a file at a time. While the store is open, the process holds
 *   `<file>.lock`, which contains its process id. A lock whose process has ended (a killed process,
 *   say) is taken over, and the takeover is logged as a warning.
 * - **Reading.** A file is read as facts 1 to n, in order; a file that is not is refused. A last
 *   line without its line break is a write that the process did not finish: it is not read, and it
 *   is cut off before the file is written to again. The cut is logged as a warning.
 * - **Flushing.** Each `append` writes its facts and flushes them to the disk (`fsync`) before it
 *   returns, so whatever the session does after writing a fact (running a tool, say) happens after
 *   the fact is on the disk, through a power cut as well. The folder of a new file is flushed too,
 *   so the file is found after a power cut.
 * - **Failure.** A write that fails returns an error naming the file and the facts that were not
 *   written, and nothing is written after it.
 *
 * The format is the facts' schema as it is today. A file written before the schema changed may not
 * read back; the store refuses it, and the error tells the user to delete the file. Old files are
 * not converted.
 */

import { Effect, FileSystem, Layer, Ref, Schema } from "effect";
import { Fact } from "../agent-machine/fact.ts";
import { SessionStore, SessionStoreFailed } from "./session-store.ts";
import { logKeys } from "./log-keys.ts";

const FactLine = Schema.fromJsonString(Fact);
const encodeLine = Schema.encodeSync(FactLine);
const decodeLine = Schema.decodeUnknownEffect(FactLine);

/** A session's file as read: its facts, and the text after its last complete line, if any. */
export interface StoredFile {
  readonly facts: ReadonlyArray<Fact>;
  /** The number of bytes that the complete lines take. */
  readonly bytes: number;
  /** The text after the last line break: the start of a line whose write did not finish. */
  readonly torn: string;
}

const failed = (message: string) => new SessionStoreFailed({ message });

/** Reads the facts in `file`, in order. Fails when the lines are not one session's facts in order. */
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
 * Takes `file`'s lock and holds it until the scope closes. Fails when a running process holds the
 * lock. A lock whose process has ended, or whose file names no process, is taken over, and the
 * takeover is logged as a warning.
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
      const held = yield* fs.readFileString(lock);
      const holder = Number(held);
      // A process id is a positive integer: 0 and a negative number name process groups to `kill`.
      const names = Number.isInteger(holder) && holder > 0;
      if (names && running(holder))
        return yield* failed(`${file} is open in another process (pid ${holder}). Close it there, or wait for it to end.`);
      yield* Effect.logWarning(logKeys.sessionStore.lockTakenOver, {
        file,
        lock,
        held,
        ...(names ? { holder } : {}),
        reason: names ? "the process holding the lock has ended" : "the lock file names no process",
      });
      yield* fs.remove(lock);
      yield* take;
    }
    yield* Effect.addFinalizer(() => fs.remove(lock).pipe(Effect.ignore));
  }).pipe(Effect.catchTag("PlatformError", (error) => Effect.fail(failed(`${file}.lock could not be taken: ${error.message}`))));

/**
 * Flushes the folder that contains `file` to the disk, so that a file just created there is found
 * after a power cut. When the file system cannot flush the folder, that is logged as a warning and
 * the store opens anyway.
 */
const folderSynced = (file: string) =>
  Effect.gen(function* () {
    const folder = file.slice(0, file.lastIndexOf("/"));
    const handle = yield* (yield* FileSystem.FileSystem).open(folder, { flag: "r" });
    yield* handle.sync;
  }).pipe(
    Effect.scoped,
    Effect.catchTag("PlatformError", (error) => Effect.logWarning(logKeys.sessionStore.folderNotFlushed, { file, error: error.message })),
  );

/**
 * The session store kept in `file`, open for as long as the layer lasts. Opening it takes the lock,
 * reads the facts, cuts off a line whose write did not finish, and opens the file for appending.
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
        yield* Effect.logWarning(logKeys.sessionStore.tornLineCut, { file, bytes: Buffer.byteLength(stored.torn), start: stored.torn.slice(0, 200) });
        yield* fs.truncate(file, stored.bytes).pipe(Effect.mapError((error) => failed(`${file} could not be cut to its last complete line: ${error.message}`)));
      }
      const created = !(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)));
      // The file stays open for appending while the store is open; opening it creates a new file.
      const opened = yield* fs.open(file, { flag: "a" }).pipe(Effect.mapError((error) => failed(`${file} could not be opened: ${error.message}`)));
      if (created) yield* folderSynced(file);
      const kept = yield* Ref.make<ReadonlyArray<Fact>>(stored.facts);
      return {
        facts: Ref.get(kept),
        // The write, the flush and the update of the kept facts are uninterruptible together, so a
        // write that reached the file is always counted, and facts count as written only once they
        // are on the disk.
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
