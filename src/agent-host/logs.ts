/** Where a host's log lines go: to stderr, or to a file. */

import { Effect, FileSystem, Layer, Logger, Path } from "effect";

/** Log lines to stderr: for a host whose stdout is for something else (an answer printed alone, a protocol). */
export const LogsToStderr = Logger.layer([Logger.withConsoleError(Logger.formatLogFmt)]);

/** Log lines to the file at `path`, its folder made when missing: for a host whose terminal holds the conversation alone. */
export const LogsToFile = (path: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      yield* (yield* FileSystem.FileSystem).makeDirectory((yield* Path.Path).dirname(path), { recursive: true });
      return Logger.layer([Logger.toFile(Logger.formatLogFmt, path, { batchWindow: "100 millis" })]);
    }),
  ).pipe(Layer.orDie);
