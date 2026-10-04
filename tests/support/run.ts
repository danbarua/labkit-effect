/**
 * Runs a test's program in a scope of its own (a session lives in one), with the test as the origin
 * of the observations it gives a session, and with its log lines written to `log.jsonl` in the
 * test's folder (`testFolder()`), one JSON object per line, instead of the console, without the
 * environment's secrets (`agent-host/redaction.ts`). A test that provides its own logger (to assert
 * on what is logged) replaces this one for its program.
 */

import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { join } from "node:path";
import { Effect, Layer, Logger, type Scope } from "effect";
import { redacting, sayingTooShort, secretsOf } from "../../src/agent-host/redaction.ts";
import { reportedBy } from "../../src/agent-session/origin.ts";
import { testFolder, testOrigin } from "./test.ts";

const testLogs = (folder: string) => {
  const secrets = secretsOf(process.env);
  return sayingTooShort(secrets, Logger.layer([Logger.toFile(redacting(secrets, Logger.formatJson), join(folder, "log.jsonl"))])).pipe(Layer.provide(BunFileSystem.layer));
};

export const runTest = <A, E>(program: Effect.Effect<A, E, Scope.Scope>): Promise<A> =>
  Effect.runPromise(
    Effect.suspend(() => {
      const origin = testOrigin();
      return program.pipe(reportedBy(origin), Effect.annotateLogs({ origin }), Effect.scoped, Effect.provide(testLogs(testFolder())));
    }),
  );
