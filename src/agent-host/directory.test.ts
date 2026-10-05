/** A folder of sessions: which it holds, newest first, and what each says of itself. */

import { expect } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { BunServices } from "@effect/platform-bun";
import { DateTime, Effect, Schema } from "effect";
import { boringOpening } from "../../tests/support/boring.ts";
import { runTest } from "../../tests/support/run.ts";
import { test, testFolder, testOrigin } from "../../tests/support/test.ts";
import { Fact } from "../agent-machine/fact.ts";
import { Seq, TurnId } from "../agent-machine/names.ts";
import { latestSession, readSession, sessionFolderOf, storedSessions, storeFileOf, summaryOf } from "./directory.ts";

const line = Schema.encodeSync(Schema.fromJsonString(Fact));

/** Writes session `sessionId` in `root`: its opening and `turns` turns started, its file last written at `at` seconds after the epoch. */
const stored = (root: string, sessionId: string, turns: number, at: number) => {
  const facts: ReadonlyArray<Fact> = [boringOpening([], sessionId), ...Array.from({ length: turns }, (_, at) => ({ _tag: "TurnStarted" as const, turn: TurnId.make(`turn-${at + 1}`) }))].map(
    (observation, at) => ({ _tag: "Observed", seq: Seq.make(at + 1), time: DateTime.makeUnsafe(at * 1000), origin: testOrigin(), observation }),
  );
  mkdirSync(sessionFolderOf(root, sessionId), { recursive: true });
  writeFileSync(storeFileOf(root, sessionId), facts.map((fact) => `${line(fact)}\n`).join(""));
  utimesSync(storeFileOf(root, sessionId), at, at);
};

const run = <A, E>(program: Effect.Effect<A, E, BunServices.BunServices>) => runTest(program.pipe(Effect.provide(BunServices.layer)));

/** What the run gave, or the tag of its failure and what the failure carries. */
const outcome = <A, E extends { readonly _tag: string }>(program: Effect.Effect<A, E, BunServices.BunServices>) =>
  run(program.pipe(Effect.map((value): unknown => value), Effect.catch((error: E) => Effect.succeed({ ...error, failed: error._tag }))));

test("the sessions a folder holds are listed the one written to last first; a folder with no facts file is none", async () => {
  const root = `${testFolder()}/sessions`;
  stored(root, "older", 1, 1_000);
  stored(root, "newer", 2, 2_000);
  mkdirSync(sessionFolderOf(root, "no-facts"), { recursive: true });
  const listed = await run(storedSessions(root));
  expect(listed.map(({ sessionId, at }) => [sessionId, at?.getTime()])).toEqual([
    ["newer", 2_000_000],
    ["older", 1_000_000],
  ]);
  const latest = await run(latestSession(root));
  expect([latest.sessionId, await run(summaryOf(latest.facts))]).toEqual(["newer", { turns: 2, model: "boring/boring-1" }]);
  expect((await run(readSession(root, "older"))).facts.length).toBe(2);
});

test("a folder that is not there holds no session; a session it does not hold is not found", async () => {
  const root = `${testFolder()}/none`;
  expect(await run(storedSessions(root))).toEqual([]);
  expect(await outcome(latestSession(root))).toMatchObject({ failed: "NoSessionStored", root });
  expect(await outcome(readSession(root, "missing"))).toMatchObject({ failed: "SessionNotFound", root, sessionId: "missing" });
});
