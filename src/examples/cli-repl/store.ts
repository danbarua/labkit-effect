/**
 * The CLI's session store: each session's facts, one JSON line per fact, in
 * `logs/sessions/<session>.jsonl`, appended as they are recorded. `--continue` goes on from the
 * file written to last, `--resume <session>` from the one named.
 *
 * - One process writes a session's file at a time: it holds `<file>.lock`, which holds its process
 *   id, for as long as it has the session open. A lock whose process has ended (one that was
 *   killed) is taken over.
 * - A file is read as facts in order, the first fact 1 and each the one after the one before. A
 *   last line without its line break is a write the process did not finish: it is not read, and is
 *   cut off before the file is written to again.
 * - A write that fails is said, with the file and the error, and the session stops: it does not go
 *   on with facts the file does not hold.
 *
 * The files are throwaway. Their format is the facts' schema as it is today; a file written before
 * the schema changed may not read back, and is deleted rather than converted.
 */

import { Deferred, Effect, Fiber, FileSystem, Option, PubSub, Ref, Schema } from "effect";
import type { CliError } from "effect/cli";
import { Fact } from "../../agent-machine/fact.ts";
import type { Session } from "../../agent-session/loop.ts";
import { modelOf } from "../../agent-session/configuration/session-setup.ts";
import { invalid } from "./invalid.ts";

export const storeFolder = "logs/sessions";

export const storeFileOf = (sessionId: string, folder: string = storeFolder): string => `${folder}/${sessionId}.jsonl`;

const lockFileOf = (file: string): string => `${file}.lock`;

const FactLine = Schema.fromJsonString(Fact);
const encodeLine = Schema.encodeSync(FactLine);
const decodeLine = Schema.decodeUnknownEffect(FactLine);

/** A session's file as read: its facts, and what follows its last complete line, if anything. */
export interface Stored {
  readonly facts: ReadonlyArray<Fact>;
  /** The bytes the complete lines take. */
  readonly bytes: number;
  /** What follows the last line break: the start of a line whose write did not finish. */
  readonly torn: string;
}

/** The facts in `file`, in order; a file whose lines are not one session's facts in order is refused. */
export const readFacts = (file: string) =>
  Effect.gen(function* () {
    const text = yield* (yield* FileSystem.FileSystem).readFileString(file);
    const end = text.lastIndexOf("\n") + 1;
    const lines = text.slice(0, end).split("\n").slice(0, -1);
    const facts = yield* Effect.forEach(lines, (line, at) =>
      decodeLine(line).pipe(Effect.mapError((error) => invalid(`${file} line ${at + 1} is not a fact as the session records them now; delete the file. ${error.message}`))),
    );
    const misplaced = facts.findIndex((fact, at) => fact.seq !== at + 1);
    if (misplaced >= 0)
      return yield* invalid(`${file} line ${misplaced + 1} holds fact ${facts[misplaced]?.seq} where fact ${misplaced + 1} belongs: it is not one session's facts in order. Delete the file.`);
    const stored: Stored = { facts, bytes: Buffer.byteLength(text.slice(0, end)), torn: text.slice(end) };
    return stored;
  });

const unreadable = (error: { readonly message: string }) => invalid(`The session store could not be read: ${error.message}`);

/** The sessions in `folder`, the one written to last first, each with when it was last written to. */
export const storedSessions = (folder: string = storeFolder) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const names = (yield* fs.exists(folder)) ? (yield* fs.readDirectory(folder)).filter((name) => name.endsWith(".jsonl")) : [];
    const dated = yield* Effect.forEach(names, (name) =>
      fs.stat(`${folder}/${name}`).pipe(Effect.map((info) => ({ sessionId: name.slice(0, -".jsonl".length), at: Option.getOrUndefined(info.mtime) }))),
    );
    return dated.sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0));
  }).pipe(Effect.catchTag("PlatformError", (error) => Effect.fail(unreadable(error))));

/** The facts of the session `sessionId` in `folder`. */
export const readSession = (sessionId: string, folder: string = storeFolder) =>
  Effect.gen(function* () {
    const file = storeFileOf(sessionId, folder);
    if (!(yield* (yield* FileSystem.FileSystem).exists(file))) return yield* invalid(`No session ${sessionId} in ${folder}.`);
    return { sessionId, facts: (yield* readFacts(file)).facts };
  }).pipe(Effect.catchTag("PlatformError", (error) => Effect.fail(unreadable(error))));

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
const locked = (file: string, sessionId: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const lock = lockFileOf(file);
    const take = fs.writeFileString(lock, String(process.pid), { flag: "wx" });
    const taken = yield* take.pipe(
      Effect.as(true),
      Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.succeed(false)),
    );
    if (!taken) {
      const holder = Number(yield* fs.readFileString(lock));
      if (Number.isInteger(holder) && running(holder))
        return yield* invalid(`Session ${sessionId} is open in another process (pid ${holder}). Close it there, or wait for it to end.`);
      yield* Effect.logWarning("cli.session_store.lock_taken_over", { file, lock, holder, reason: "the process holding the lock has ended" });
      yield* fs.remove(lock);
      yield* take;
    }
    yield* Effect.addFinalizer(() => fs.remove(lock).pipe(Effect.ignore));
  });

/** A write to the store that failed: what is said, and the session stops. */
const notWritten = (file: string, from: number, error: { readonly message: string }): CliError.UserError =>
  invalid(`The session's facts could not be written to ${file}: ${error.message}. The facts from ${from + 1} on are not in the file, and the session stops.`);

/**
 * Opens `file` for the session's facts, for as long as the scope lasts: takes its lock, checks that
 * the file holds the facts `stored` (the session's facts as read when it was chosen: none for a new
 * session), cuts off a line whose write did not finish, and appends each fact recorded after them,
 * in order, each once. A new fact wakes the writer, which writes the facts from where it had got
 * to. `failed` fails when a write fails; `finish` stops the writer and writes the rest.
 */
export const journal = (session: Session, file: string, sessionId: string, stored: ReadonlyArray<Fact>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(file.slice(0, file.lastIndexOf("/")), { recursive: true });
    yield* locked(file, sessionId);
    if (yield* fs.exists(file)) {
      const now = yield* readFacts(file);
      if (now.facts.length !== stored.length)
        return yield* invalid(`Session ${sessionId} was written to after it was read (${stored.length} facts then, ${now.facts.length} now). Open it again.`);
      if (now.torn !== "") {
        yield* Effect.logWarning("cli.session_store.torn_line_cut", { file, bytes: Buffer.byteLength(now.torn), start: now.torn.slice(0, 200) });
        yield* fs.truncate(file, now.bytes);
      }
    } else if (stored.length > 0) return yield* invalid(`Session ${sessionId}'s file is gone: ${file}.`);
    const written = yield* Ref.make(stored.length);
    const failed = yield* Deferred.make<never, CliError.UserError>();
    // An append and the count of what is written go together: interrupting the writer waits for an
    // append under way, which would otherwise land on disk uncounted and be written again.
    const writeRest = Effect.uninterruptible(
      Effect.gen(function* () {
        const all = yield* session.facts;
        const from = yield* Ref.get(written);
        if (from === all.length) return;
        yield* fs.writeFileString(file, all.slice(from).map((fact) => `${encodeLine(fact)}\n`).join(""), { flag: "a" }).pipe(
          Effect.tapError((error) => Effect.logError("cli.session_store.write_failed", { file, from: from + 1, to: all.length, error: error.message })),
          Effect.mapError((error) => notWritten(file, from, error)),
        );
        yield* Ref.set(written, all.length);
      }),
    );
    const recorded = yield* session.subscribe;
    yield* writeRest;
    const follower = yield* Effect.forkScoped(
      Effect.forever(PubSub.take(recorded).pipe(Effect.andThen(writeRest))).pipe(Effect.catch((error) => Deferred.fail(failed, error))),
    );
    return { failed: Deferred.await(failed), finish: Fiber.interrupt(follower).pipe(Effect.andThen(writeRest)) };
  }).pipe(Effect.catchTag("PlatformError", (error) => Effect.fail(invalid(`The session store could not be opened: ${error.message}`))));
