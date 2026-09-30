/**
 * `test`, as `bun:test` gives it, that also says which test is running: a test is the origin of the
 * observations it gives a session, and its name goes on the log lines it writes. Test files import
 * `test` from here. For `test.each`, the name is the title as written with the row's arguments.
 */

import { test as bunTest } from "bun:test";
import { TestName } from "../../src/agent-core/names.ts";
import type { Origin } from "../../src/agent-core/origin.ts";

let running: string | undefined;

/** The origin of what the running test reports. Outside a test from this module it is a defect. */
export function testOrigin(): Origin {
  if (running === undefined) throw new Error("no test is running: import `test` from tests/support/test.ts");
  return { _tag: "Test", name: TestName.make(running) };
}

const named =
  <Args extends ReadonlyArray<unknown>>(name: string, run: (...args: Args) => unknown) =>
  async (...args: Args): Promise<void> => {
    running = args.length === 0 ? name : `${name} ${JSON.stringify(args)}`;
    try {
      await run(...args);
    } finally {
      running = undefined;
    }
  };

export const test = Object.assign(
  (name: string, run: () => unknown): void => {
    bunTest(name, named(name, run));
  },
  {
    // Typed as `bun:test` types it, so a test's arguments are inferred from its rows as before.
    each: ((rows: ReadonlyArray<ReadonlyArray<unknown>>) =>
      (name: string, run: (...args: ReadonlyArray<unknown>) => unknown): void => {
        bunTest.each(rows.map((row) => [...row]))(name, named(name, run));
      }) as unknown as typeof bunTest.each,
  },
);
