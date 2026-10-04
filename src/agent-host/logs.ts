/**
 * Where a host's log lines go: to stderr, or to a file. Either leaves out the environment's secrets
 * (`redaction.ts`), read when the layer is made, and says first those it does not look for.
 */

import { Effect, FileSystem, Layer, Logger, Path } from "effect";
import { redacting, sayingTooShort, secretsOf } from "./redaction.ts";

/** Log lines to stderr: for a host whose stdout is for something else (an answer printed alone, a protocol). */
export const LogsToStderr = Layer.unwrap(
  Effect.sync(() => {
    const secrets = secretsOf(process.env);
    return sayingTooShort(secrets, Logger.layer([Logger.withConsoleError(redacting(secrets, Logger.formatLogFmt))]));
  }),
);

/**
 * Log lines to the file at `path`, its folder made when missing: for a host whose terminal holds the
 * conversation alone. The secrets are `env`'s.
 */
export const LogsToFile = (path: string, env: Readonly<Record<string, string | undefined>> = process.env) =>
  Layer.unwrap(
    Effect.gen(function* () {
      yield* (yield* FileSystem.FileSystem).makeDirectory((yield* Path.Path).dirname(path), { recursive: true });
      const secrets = secretsOf(env);
      return sayingTooShort(secrets, Logger.layer([Logger.toFile(redacting(secrets, Logger.formatLogFmt), path, { batchWindow: "100 millis" })]));
    }),
  ).pipe(Layer.orDie);
