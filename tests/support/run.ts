/**
 * Runs a test's program in a scope of its own (a session lives in one), with the test as the origin of the observations it gives a session, and
 * with its log lines written to `logs/test.log`, one JSON object per line and each naming the test,
 * instead of the console. `tests/support/preload.ts` empties the file when a test run starts. A test
 * that provides its own logger (to assert on what is logged) replaces this one for its program.
 */

import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer, Logger, type Scope } from "effect";
import { reportedBy } from "../../src/agent-session/origin.ts";
import { testOrigin } from "./test.ts";

export const testLogPath = "logs/test.log";

const TestLogs = Logger.layer([Logger.toFile(Logger.formatJson, testLogPath)]).pipe(Layer.provide(BunFileSystem.layer));

export const runTest = <A, E>(program: Effect.Effect<A, E, Scope.Scope>): Promise<A> =>
  Effect.runPromise(
    Effect.suspend(() => {
      const origin = testOrigin();
      return program.pipe(reportedBy(origin), Effect.annotateLogs({ origin }), Effect.scoped);
    }).pipe(Effect.provide(TestLogs)),
  );
