/** How the REPL reads the terminal's keys during a turn, using a fake terminal. */

import { EventEmitter } from "node:events";
import { expect } from "bun:test";
import { Effect } from "effect";
import { test } from "../../../tests/support/test.ts";
import { turnKeys } from "./turn-keys.ts";

/** A fake terminal input: whether it is in raw mode, and whether it is reading. */
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

test("during a turn the terminal is in raw mode: Ctrl+C interrupts, Ctrl+D and other keys are ignored, a permission prompt borrows the keys, and the turn's end restores line mode", async () => {
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
  // A question reads the terminal itself, so the turn's key reader is off while it is asked.
  const during = await Effect.runPromise(keys.lend(Effect.sync(() => [stdin.raw, stdin.listenerCount("data")])));
  expect(during).toEqual([false, 0]);
  expect([stdin.raw, stdin.listenerCount("data")]).toEqual([true, 1]);
  keys.release();
  expect([stdin.raw, stdin.flowing, stdin.listenerCount("data")]).toEqual([false, false, 0]);
  // With no turn in progress, a question leaves the terminal in line mode afterwards.
  await Effect.runPromise(keys.lend(Effect.void));
  expect([stdin.raw, stdin.listenerCount("data")]).toEqual([false, 0]);
});

test("during a turn, keys other than Ctrl+C go to the key handler as the text the terminal sent", () => {
  const stdin = terminal();
  const keys = turnKeys(stdin as unknown as NodeJS.ReadStream);
  const passed: Array<string> = [];
  let interrupts = 0;
  keys.hold(
    () => (interrupts += 1),
    (text) => passed.push(text),
  );
  stdin.emit("data", Buffer.from("\x1bt"));
  stdin.emit("data", Buffer.from("†"));
  stdin.emit("data", Buffer.from([0x03]));
  expect(passed).toEqual(["\x1bt", "†"]);
  expect(interrupts).toBe(1);
  keys.release();
  stdin.emit("data", Buffer.from("\x1bt"));
  expect(passed).toHaveLength(2);
});
