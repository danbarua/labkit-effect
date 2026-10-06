/**
 * The terminal while a turn runs. Effect's terminal holds raw mode only while a prompt reads; the
 * rest of the time the terminal is in line mode, where Ctrl+D at the start of a line ends the
 * process's input, and every prompt after it ends at once (the question before a tool call is then
 * taken as refused, and the REPL exits). So while a turn runs, and no question is being asked, the
 * REPL holds raw mode and reads the keys itself: Ctrl+C interrupts the turn, any other key is passed
 * to the turn's `key` (which acts on Option+T), and a key it does not act on is dropped. A question
 * is lent the terminal for as long as it is asked.
 */

import { Effect } from "effect";

export interface TurnKeys {
  /** Holds the terminal for a turn: Ctrl+C calls `interrupt`; any other key is passed to `key`, as the text the terminal sent. */
  readonly hold: (interrupt: () => void, key?: (text: string) => void) => void;
  /** Gives the terminal back at the turn's end, in line mode. */
  readonly release: () => void;
  /** Lends the terminal to `asking` (a question at the terminal) while it runs, and holds it again after. */
  readonly lend: <A, E, R>(asking: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

/** Ctrl+C, as raw mode passes it on. */
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
