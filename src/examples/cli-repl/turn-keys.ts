/**
 * The terminal during a turn. Effect's terminal is in raw mode only while a prompt is reading; the rest
 * of the time it is in line mode, where Ctrl+D at the start of a line closes the process's input, and
 * every later prompt ends at once (so a permission question is answered as refused, and the REPL
 * exits). So during a turn, while no question is asked, the REPL puts the terminal in raw mode and
 * reads the keys itself: Ctrl+C interrupts the turn, other keys go to the turn's `key` handler (which
 * acts on Option+T), and keys it ignores are dropped. A permission question borrows the terminal while
 * it is asked.
 */

import { Effect } from "effect";

export interface TurnKeys {
  /** Takes the terminal for a turn: Ctrl+C calls `interrupt`, and any other key goes to `key` as the text the terminal sent. */
  readonly hold: (interrupt: () => void, key?: (text: string) => void) => void;
  /** Returns the terminal to line mode at the turn's end. */
  readonly release: () => void;
  /** Lets `asking` (a question at the terminal) use the terminal while it runs, then takes it back. */
  readonly lend: <A, E, R>(asking: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

/** The byte Ctrl+C sends in raw mode. */
const ctrlC = 0x03;

export const turnKeys = (stdin: NodeJS.ReadStream = process.stdin): TurnKeys => {
  let interrupt: (() => void) | undefined;
  let onKey: ((text: string) => void) | undefined;
  let reading = false;
  const onData = (data: Buffer) => {
    if (data.includes(ctrlC)) interrupt?.();
    else onKey?.(data.toString("utf8"));
  };
  const start = () => {
    if (!stdin.isTTY || reading || interrupt === undefined) return;
    reading = true;
    stdin.setRawMode(true);
    stdin.on("data", onData);
    stdin.resume();
  };
  const stop = () => {
    if (!reading) return;
    reading = false;
    stdin.off("data", onData);
    stdin.setRawMode(false);
    stdin.pause();
  };
  return {
    hold: (onInterrupt, key) => {
      interrupt = onInterrupt;
      onKey = key;
      start();
    },
    release: () => {
      interrupt = undefined;
      onKey = undefined;
      stop();
    },
    lend: (asking) =>
      Effect.acquireUseRelease(
        Effect.sync(stop),
        () => asking,
        () => Effect.sync(start),
      ),
  };
};
