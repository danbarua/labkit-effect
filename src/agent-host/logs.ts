/**
 * Where a host's log lines go: to stderr, or to a file. Both redact the environment's secrets
 * (`redaction.ts`), read when the layer is built, and first log a warning naming the secrets too
 * short to search for.
 */

import { Effect, FileSystem, Layer, Logger, Path } from "effect";
import { redacting, sayingTooShort, secretsOf } from "./redaction.ts";

/** Writes log lines to stderr, for a host whose stdout carries something else (an answer printed alone, a protocol). */
export const LogsToStderr = Layer.unwrap(
  Effect.sync(() => {
    const secrets = secretsOf(process.env);
    return sayingTooShort(secrets, Logger.layer([Logger.withConsoleError(redacting(secrets, Logger.formatLogFmt))]));
  }),
);

/**
 * Writes log lines to the file at `path`, creating its folder when missing, for a host whose terminal
 * shows only the conversation. The secrets are read from `env`.
 */
export const LogsToFile = (path: string, env: Readonly<Record<string, string | undefined>> = process.env) =>
  Layer.unwrap(
    Effect.gen(function* () {
      yield* (yield* FileSystem.FileSystem).makeDirectory((yield* Path.Path).dirname(path), { recursive: true });
      const secrets = secretsOf(env);
      return sayingTooShort(secrets, Logger.layer([Logger.toFile(redacting(secrets, Logger.formatLogFmt), path, { batchWindow: "100 millis" })]));
    }),
  ).pipe(Layer.orDie);
