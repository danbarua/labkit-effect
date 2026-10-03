/** The REPL's hold on the terminal's keys while a turn runs, over a terminal made for the test. */

import { EventEmitter } from "node:events";
import { expect } from "bun:test";
import { Effect } from "effect";
import { test } from "../../../tests/support/test.ts";
import { turnKeys } from "./turn-keys.ts";

/** A terminal's input: raw mode as last set, and whether it flows. */
const terminal = () => {
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    raw: false,
    flowing: false,
    setRawMode(on: boolean) {
      stdin.raw = on;
      return stdin;
    },
    resume() {
      stdin.flowing = true;
      return stdin;
    },
    pause() {
      stdin.flowing = false;
      return stdin;
    },
  });
  return stdin;
};

test("while a turn runs the keys are held in raw mode: Ctrl+C interrupts it, Ctrl+D and other keys are dropped; a question is lent them; the turn's end gives them back", async () => {
  const stdin = terminal();
  const keys = turnKeys(stdin as unknown as NodeJS.ReadStream);
  let interrupts = 0;
  keys.hold(() => (interrupts += 1));
  expect([stdin.raw, stdin.flowing, stdin.listenerCount("data")]).toEqual([true, true, 1]);
  stdin.emit("data", Buffer.from([0x04]));
  stdin.emit("data", Buffer.from("abc"));
  expect(interrupts).toBe(0);
  stdin.emit("data", Buffer.from([0x03]));
  expect(interrupts).toBe(1);
  // A question reads the terminal itself: while it is asked the turn's reader is off.
  const during = await Effect.runPromise(keys.lend(Effect.sync(() => [stdin.raw, stdin.listenerCount("data")])));
  expect(during).toEqual([false, 0]);
  expect([stdin.raw, stdin.listenerCount("data")]).toEqual([true, 1]);
  keys.release();
  expect([stdin.raw, stdin.flowing, stdin.listenerCount("data")]).toEqual([false, false, 0]);
  // With no turn held, a question lent the keys leaves them in line mode after.
  await Effect.runPromise(keys.lend(Effect.void));
  expect([stdin.raw, stdin.listenerCount("data")]).toEqual([false, 0]);
});
