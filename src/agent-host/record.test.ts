/** A host's record of a session: what it writes and reads back, and the sessions listed with theirs. */

import { expect } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { BunServices } from "@effect/platform-bun";
import { DateTime, Effect, FileSystem, Layer, Logger, Schema } from "effect";
import { boringOpening } from "../../tests/support/boring.ts";
import { runTest } from "../../tests/support/run.ts";
import { test, testFolder, testOrigin } from "../../tests/support/test.ts";
import { Fact } from "../agent-machine/fact.ts";
import { Seq } from "../agent-machine/names.ts";
import { sessionFolderOf, storeFileOf } from "./directory.ts";
import { readRecord, recordedSessions, recordFileOf, writeRecord } from "./record.ts";

const line = Schema.encodeSync(Schema.fromJsonString(Fact));

/** Session `sessionId` in `root`: its opening only, its file last written at `at` seconds after the epoch. */
const stored = (root: string, sessionId: string, at: number) => {
  const opening: Fact = { _tag: "Observed", seq: Seq.make(1), time: DateTime.makeUnsafe(0), origin: testOrigin(), observation: boringOpening([], sessionId) };
  mkdirSync(sessionFolderOf(root, sessionId), { recursive: true });
  writeFileSync(storeFileOf(root, sessionId), `${line(opening)}\n`);
  utimesSync(storeFileOf(root, sessionId), at, at);
};

/** The program's result and the log lines (message and fields) it made, at warning and above. */
const run = <A, E>(program: Effect.Effect<A, E, BunServices.BunServices>) => {
  const logged: Array<unknown> = [];
  const capture = Logger.make((options) => {
    if (options.logLevel === "Warn" || options.logLevel === "Error") logged.push(options.message);
  });
  return runTest(
    program.pipe(
      Effect.map((value): unknown => value),
      Effect.catch((error: E) => Effect.succeed({ failed: (error as { readonly _tag?: string })._tag, error })),
      Effect.provide(Layer.mergeAll(BunServices.layer, Logger.layer([capture], { mergeWithExisting: true }))),
    ),
  ).then((result) => ({ result, logged }));
};

test("H16: a record is written whole and read back as the JSON it was; writing again replaces it; a session with none gives undefined", async () => {
  const root = `${testFolder()}/sessions`;
  expect((await run(readRecord(root, "s1"))).result).toBeUndefined();
  await run(writeRecord(root, "s1", { cwd: "/work/a", title: "First" }));
  expect((await run(readRecord(root, "s1"))).result).toEqual({ cwd: "/work/a", title: "First" });
  await run(writeRecord(root, "s1", { cwd: "/work/b" }));
  expect((await run(readRecord(root, "s1"))).result).toEqual({ cwd: "/work/b" });
  // The folder is made for a session that has no facts yet, and nothing but the record is left in it.
  expect(readdirSync(sessionFolderOf(root, "s1"))).toEqual(["host.json"]);
});

test("H16: a record that is not JSON fails as RecordFailed naming its file, and the session beside it with a good one reads", async () => {
  const root = `${testFolder()}/sessions`;
  await run(writeRecord(root, "good", { cwd: "/work" }));
  mkdirSync(sessionFolderOf(root, "bad"), { recursive: true });
  writeFileSync(recordFileOf(root, "bad"), "{ not json");
  expect((await run(readRecord(root, "bad"))).result).toMatchObject({ failed: "RecordFailed", error: { file: recordFileOf(root, "bad") } });
  expect((await run(readRecord(root, "good"))).result).toEqual({ cwd: "/work" });
});

test("H16: a record that cannot be written fails as RecordFailed, and the record already there is left as it was", async () => {
  const root = `${testFolder()}/sessions`;
  await run(writeRecord(root, "s1", { cwd: "/work" }));
  // The partial file's name is taken by a folder, so the write cannot be made.
  mkdirSync(`${recordFileOf(root, "s1")}.partial`);
  expect((await run(writeRecord(root, "s1", { cwd: "/elsewhere" }))).result).toMatchObject({ failed: "RecordFailed", error: { file: recordFileOf(root, "s1") } });
  expect(JSON.parse(readFileSync(recordFileOf(root, "s1"), "utf8"))).toEqual({ cwd: "/work" });
});

test("H17: the sessions with facts are listed the one written to last first, each with its record or undefined; a record that does not read is logged and lists as none", async () => {
  const root = `${testFolder()}/sessions`;
  stored(root, "older", 1_000);
  stored(root, "newer", 2_000);
  stored(root, "broken", 3_000);
  await run(writeRecord(root, "older", { cwd: "/work/a", title: "Older" }));
  writeFileSync(recordFileOf(root, "broken"), "nope");
  // A record without facts is no session.
  await run(writeRecord(root, "draft-only", { cwd: "/work/c" }));
  expect(existsSync(recordFileOf(root, "draft-only"))).toBe(true);

  const { result, logged } = await run(recordedSessions(root));
  expect((result as ReadonlyArray<{ sessionId: string; at: Date; record: unknown }>).map(({ sessionId, at, record }) => [sessionId, at.getTime(), record])).toEqual([
    ["broken", 3_000_000, undefined],
    ["newer", 2_000_000, undefined],
    ["older", 1_000_000, { cwd: "/work/a", title: "Older" }],
  ]);
  expect(logged).toEqual([["host_record.unreadable", expect.objectContaining({ session: "broken", file: recordFileOf(root, "broken") })]]);
});

test("a record is flushed to the disk before it is renamed over the old one", async () => {
  const root = testFolder();
  const events: Array<string> = [];
  // The file system as Bun gives it, with each flush of an opened file and each rename noted.
  const noting = Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const base = yield* FileSystem.FileSystem;
      const open: typeof base.open = (path, options) =>
        base.open(path, options).pipe(
          Effect.map(
            (opened) =>
              new Proxy(opened, {
                get: (target, key) => (key === "sync" ? target.sync.pipe(Effect.tap(() => Effect.sync(() => events.push("flush")))) : Reflect.get(target, key)),
              }),
          ),
        );
      const rename: typeof base.rename = (from, to) => base.rename(from, to).pipe(Effect.tap(() => Effect.sync(() => events.push("rename"))));
      return { ...base, open, rename };
    }),
  ).pipe(Layer.provide(BunServices.layer));
  await Effect.runPromise(writeRecord(root, "s1", { cwd: "/work" }).pipe(Effect.provide(noting)));
  expect(events).toEqual(["flush", "rename"]);
});
