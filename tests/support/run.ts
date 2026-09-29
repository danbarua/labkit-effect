/**
 * Runs a test's program with its log lines written to `logs/test.log`, one JSON object per line,
 * instead of the console. `tests/support/preload.ts` empties the file when a test run starts. A test
 * that provides its own logger (to assert on what is logged) replaces this one for its program.
 */

import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer, Logger } from "effect";

export const testLogPath = "logs/test.log";

const TestLogs = Logger.layer([Logger.toFile(Logger.formatJson, testLogPath)]).pipe(Layer.provide(BunFileSystem.layer));

export const runTest = <A, E>(program: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(program.pipe(Effect.provide(TestLogs)));
