/**
 * Where a host's log lines go: to stderr, or to a file, and as OTLP when `OTEL_EXPORTER_OTLP_ENDPOINT`
 * is set (`instrumentation/telemetry.ts`), named after `service`. Each redacts the environment's
 * secrets (`redaction.ts`), read when the layer is built, and first logs a warning naming the
 * secrets too short to search for. Each also names the folder of the model requests' body captures
 * (`instrumentation/http-captures.ts`), `http-captures/` in the logs' folder, redacted with the same
 * secrets.
 */

import { Effect, FileSystem, Layer, Logger, Path } from "effect";
import { HttpCaptures, capturesFolderIn } from "../instrumentation/http-captures.ts";
import { otlpLogger } from "../instrumentation/telemetry.ts";
import { redacting, withTooShortWarning, secretsOf } from "./redaction.ts";

/**
 * Writes log lines to stderr, for a host whose stdout carries something else (an answer printed
 * alone, a protocol). Captures go to `http-captures/` in `logsFolder`, the folder of the host's log
 * files.
 */
export const LogsToStderr = (service: string, logsFolder: string) =>
  Layer.unwrap(
    Effect.sync(() => {
      const secrets = secretsOf(process.env);
      return withTooShortWarning(
        secrets,
        Layer.mergeAll(
          Logger.layer([Logger.withConsoleError(redacting(secrets, Logger.formatLogFmt)), otlpLogger(service)]),
          Layer.succeed(HttpCaptures, { folder: capturesFolderIn(logsFolder), secrets }),
        ),
      );
    }),
  );

/**
 * Writes log lines to the file at `path`, creating its folder when missing, for a host whose terminal
 * shows only the conversation. The secrets are read from `env`.
 */
export const LogsToFile = (path: string, service: string, env: Readonly<Record<string, string | undefined>> = process.env) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const folder = (yield* Path.Path).dirname(path);
      yield* (yield* FileSystem.FileSystem).makeDirectory(folder, { recursive: true });
      const secrets = secretsOf(env);
      return withTooShortWarning(
        secrets,
        Layer.mergeAll(
          Logger.layer([Logger.toFile(redacting(secrets, Logger.formatLogFmt), path, { batchWindow: "100 millis" }), otlpLogger(service)]),
          Layer.succeed(HttpCaptures, { folder: capturesFolderIn(folder), secrets }),
        ),
      );
    }),
  ).pipe(Layer.orDie);
