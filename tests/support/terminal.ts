/** A terminal for tests of what is typed at a prompt. */

import { type Cause, Effect, Option, Queue, Terminal } from "effect";

/** A key pressed, as the terminal reads it: `name`, and the text it types, if any. */
export const key = (name: string, input?: string): Terminal.UserInput => ({
  input: input === undefined ? Option.none() : Option.some(input),
  key: { name, ctrl: false, meta: false, shift: false },
});

/** A terminal that is typed `lines`, each ended with Enter, and shows nothing. */
export const typing = (lines: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const keys = yield* Queue.unbounded<Terminal.UserInput, Cause.Done>();
    yield* Queue.offerAll(
      keys,
      lines.flatMap((line) => [...line.split("").map((each) => key(each, each)), key("return", "\r")]),
    );
    return Terminal.make({
      columns: Effect.succeed(80),
      rows: Effect.succeed(24),
      // Every prompt reads from the one queue: what one prompt leaves is the next one's.
      readInput: Effect.succeed(keys),
      readLine: Effect.fail(new Terminal.QuitError()),
      display: () => Effect.void,
    });
  });

/** A terminal whose input has ended, and shows nothing: every prompt fails with `QuitError`, as one does when Ctrl+C quits it. */
export const quitting = Effect.gen(function* () {
  const keys = yield* Queue.unbounded<Terminal.UserInput, Cause.Done>();
  yield* Queue.end(keys);
  return Terminal.make({
    columns: Effect.succeed(80),
    rows: Effect.succeed(24),
    readInput: Effect.succeed(keys),
    readLine: Effect.fail(new Terminal.QuitError()),
    display: () => Effect.void,
  });
});
