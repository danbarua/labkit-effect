/**
 * The CLI's session store: each session's facts, one JSON line per fact, in
 * `logs/sessions/<session>.jsonl`, appended as they are recorded. `--continue` goes on from the
 * file written to last, `--resume <session>` from the one named.
 *
 * The files are throwaway. Their format is the facts' schema as it is today; a file written before
 * the schema changed may not read back, and is deleted rather than converted.
 */

import { Effect, Fiber, FileSystem, Option, PubSub, Ref, Schema } from "effect";
import { Fact } from "../../agent-machine/fact.ts";
import type { Session } from "../../agent-session/loop.ts";
import { modelOf } from "../../agent-session/configuration/session-setup.ts";
import { invalid } from "./invalid.ts";

export const storeFolder = "logs/sessions";

export const storeFileOf = (sessionId: string): string => `${storeFolder}/${sessionId}.jsonl`;

const encode = Schema.encodeSync(Fact);
const decode = Schema.decodeUnknownEffect(Fact);

/**
 * Appends the session's facts to `file` as they are recorded, in order, each once: a new fact
 * wakes the writer, which writes the facts from where it had got to; facts already in the file
 * (a session gone on from) are not written again. `finish` stops it and writes the rest.
 */
export const storing = (session: Session, file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(storeFolder, { recursive: true });
    const written = yield* Ref.make((yield* session.facts).length);
    const writeRest = Effect.gen(function* () {
      const all = yield* session.facts;
      const from = yield* Ref.getAndSet(written, all.length);
      if (from === all.length) return;
      yield* fs.writeFileString(file, all.slice(from).map((fact) => `${JSON.stringify(encode(fact))}\n`).join(""), { flag: "a" });
    }).pipe(Effect.orDie);
    const recorded = yield* session.subscribe;
    yield* writeRest;
    const follower = yield* Effect.forkScoped(Effect.forever(PubSub.take(recorded).pipe(Effect.andThen(writeRest))));
    return { finish: Fiber.interrupt(follower).pipe(Effect.andThen(writeRest)) };
  });

const unreadable = (error: { readonly message: string }) => invalid(`The session store could not be read: ${error.message}`);

/** The sessions in the store, the one written to last first, each with when it was last written to. */
export const storedSessions = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const names = (yield* fs.exists(storeFolder)) ? (yield* fs.readDirectory(storeFolder)).filter((name) => name.endsWith(".jsonl")) : [];
  const dated = yield* Effect.forEach(names, (name) =>
    fs.stat(`${storeFolder}/${name}`).pipe(Effect.map((info) => ({ sessionId: name.slice(0, -".jsonl".length), at: Option.getOrUndefined(info.mtime) }))),
  );
  return dated.sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0));
}).pipe(Effect.catchTag("PlatformError", (error) => Effect.fail(unreadable(error))));

/** The facts of the session `sessionId` in the store. */
export const readSession = (sessionId: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = storeFileOf(sessionId);
    if (!(yield* fs.exists(file))) return yield* invalid(`No session ${sessionId} in ${storeFolder}.`);
    const lines = (yield* fs.readFileString(file)).split("\n").filter((line) => line !== "");
    const facts = yield* Effect.forEach(lines, (line, at) =>
      decode(JSON.parse(line)).pipe(Effect.mapError((error) => invalid(`${file} line ${at + 1} is not a fact as the session records them now; delete the file. ${error.message}`))),
    );
    return { sessionId, facts };
  }).pipe(Effect.catchTag("PlatformError", (error) => Effect.fail(unreadable(error))));

/** The facts of the session written to last. */
export const latestSession = Effect.gen(function* () {
  const latest = (yield* storedSessions)[0];
  if (latest === undefined) return yield* invalid(`No session to continue: ${storeFolder} holds none.`);
  return yield* readSession(latest.sessionId);
});

/** What a session's facts say of it, for picking one: how many turns it started, and the model it asks now. */
export const summaryOf = (facts: ReadonlyArray<Fact>) =>
  Effect.map(modelOf(facts), (model) => ({
    turns: facts.filter((fact) => fact._tag === "Observed" && fact.observation._tag === "TurnStarted").length,
    model: `${model.provider}/${model.model}`,
  }));
