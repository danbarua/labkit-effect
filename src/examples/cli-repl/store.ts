/**
 * The CLI's session store: each session's facts, one JSON line per fact, in
 * `logs/sessions/<session>.jsonl`, appended as they are recorded. `--continue` goes on from the
 * file written to last.
 *
 * The files are throwaway. Their format is the facts' schema as it is today; a file written before
 * the schema changed may not read back, and is deleted rather than converted.
 */

import { Effect, Fiber, FileSystem, Option, PubSub, Ref, Schema } from "effect";
import { Fact } from "../../agent-machine/fact.ts";
import type { Session } from "../../agent-session/loop.ts";
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

/** The facts in the session file written to last, and its session's id. */
export const latestSession = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const names = (yield* fs.exists(storeFolder)) ? (yield* fs.readDirectory(storeFolder)).filter((name) => name.endsWith(".jsonl")) : [];
  const dated = yield* Effect.forEach(names, (name) =>
    fs.stat(`${storeFolder}/${name}`).pipe(Effect.map((info) => ({ name, at: Option.match(info.mtime, { onNone: () => 0, onSome: (date) => date.getTime() }) }))),
  );
  const latest = dated.sort((a, b) => b.at - a.at)[0];
  if (latest === undefined) return yield* invalid(`No session to continue: ${storeFolder} holds none.`);
  const file = `${storeFolder}/${latest.name}`;
  const lines = (yield* fs.readFileString(file)).split("\n").filter((line) => line !== "");
  const facts = yield* Effect.forEach(lines, (line, at) =>
    decode(JSON.parse(line)).pipe(Effect.mapError((error) => invalid(`${file} line ${at + 1} is not a fact as the session records them now; delete the file. ${error.message}`))),
  );
  return { sessionId: latest.name.slice(0, -".jsonl".length), facts };
}).pipe(Effect.catchTag("PlatformError", (error) => Effect.fail(invalid(`The session store could not be read: ${error.message}`))));
