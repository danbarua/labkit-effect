/**
 * Runs a test's program in a scope of its own (a session lives in one), with the test as the origin
 * of the observations it gives a session, and with its log lines written to `log.jsonl` in the
 * test's folder (`testFolder()`), one JSON object per line, instead of the console, without the
 * environment's secrets (`agent-host/redaction.ts`), at the level `LABKIT_LOG_LEVEL` names, info by
 * default (`agent-host/log-level.ts`). Model requests' body captures, at debug, go to
 * `http-captures/` in the test's folder (`instrumentation/http-captures.ts`). A test that provides
 * its own logger (to assert on what is logged) replaces this one for its program. When
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is set, the test's spans, log lines and metrics are also sent there
 * as OTLP, as the service `labkit-tests`, with the test's name and file as resource attributes.
 */

import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { join } from "node:path";
import { Effect, Layer, Logger, type Scope } from "effect";
import { logLevelOf, withLogLevel } from "../../src/agent-host/log-level.ts";
import { redacting, withTooShortWarning, secretsOf } from "../../src/agent-host/redaction.ts";
import { HttpCaptures, capturesFolderIn } from "../../src/instrumentation/http-captures.ts";
import { OtlpSpansAndMetrics, otlpLogger } from "../../src/instrumentation/telemetry.ts";
import { reportedBy } from "../../src/agent-session/origin.ts";
import { testFolder, testOrigin } from "./test.ts";

const testLogs = (folder: string) => {
  const secrets = secretsOf(process.env);
  return withTooShortWarning(
    secrets,
    Layer.mergeAll(
      Logger.layer([Logger.toFile(redacting(secrets, Logger.formatJson), join(folder, "log.jsonl")), otlpLogger("labkit-tests")]),
      Layer.succeed(HttpCaptures, { folder: capturesFolderIn(folder), secrets }),
    ),
  ).pipe(Layer.provide(BunFileSystem.layer));
};

export const runTest = <A, E>(program: Effect.Effect<A, E, Scope.Scope>): Promise<A> =>
  Effect.runPromise(
    Effect.suspend(() => {
      const origin = testOrigin();
      return program.pipe(
        reportedBy(origin),
        Effect.annotateLogs({ origin }),
        Effect.scoped,
        Effect.provide(Layer.mergeAll(withLogLevel(logLevelOf(process.env), testLogs(testFolder())), OtlpSpansAndMetrics("labkit-tests"))),
      );
    }),
  );
