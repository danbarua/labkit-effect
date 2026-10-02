/**
 * `test`, as `bun:test` gives it, that also says which test is running: a test is the origin of the
 * observations it gives a session, and what it writes goes in a folder of its own. Test files
 * import `test` from here. For `test.each`, the name is the title as written with the row's
 * arguments.
 *
 * Each test's folder is `logs/tests/<test file>/<test name>/`: its log lines (`log.jsonl`, written by
 * `runTest`) and any file it makes (`testFolder()`). The folder is emptied when the test starts, so
 * it holds the test's last run.
 */

import { test as bunTest } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { TestName } from "../../src/agent-machine/names.ts";
import type { Origin } from "../../src/agent-machine/origin.ts";

const root = new URL("../../", import.meta.url).pathname;

let running: { readonly name: string; readonly folder: string } | undefined;

/** The origin of what the running test reports. Outside a test from this module it is a defect. */
export function testOrigin(): Origin {
  if (running === undefined) throw new Error("no test is running: import `test` from tests/support/test.ts");
  return { _tag: "Test", name: TestName.make(running.name) };
}

/** The running test's folder, for the files it makes. Outside a test from this module it is a defect. */
export function testFolder(): string {
  if (running === undefined) throw new Error("no test is running: import `test` from tests/support/test.ts");
  return running.folder;
}

/** The test file that called `test`: the first file on the stack that is not this one. A frame may give a line and no column. */
function callerFile(): string {
  const files = (new Error().stack ?? "").split("\n").flatMap((frame) => {
    const found = /(\/[^():\s]+\.ts)(?::\d+){1,2}/.exec(frame)?.[1];
    return found === undefined ? [] : [found];
  });
  return files.find((file) => !file.endsWith("tests/support/test.ts")) ?? join(root, "unknown.test.ts");
}

/** A test's name as a folder's name: letters and digits, each run of anything else a hyphen. */
const slug = (name: string): string => name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 100);

const named =
  <Args extends ReadonlyArray<unknown>>(file: string, name: string, run: (...args: Args) => unknown) =>
  async (...args: Args): Promise<void> => {
    const full = args.length === 0 ? name : `${name} ${JSON.stringify(args)}`;
    const folder = join(root, "logs/tests", relative(root, file).replace(/\.test\.ts$/, ""), slug(full));
    rmSync(folder, { recursive: true, force: true });
    mkdirSync(folder, { recursive: true });
    running = { name: full, folder };
    try {
      await run(...args);
    } finally {
      running = undefined;
    }
  };

export const test = Object.assign(
  (name: string, run: () => unknown): void => {
    bunTest(name, named(callerFile(), name, run));
  },
  {
    // Typed as `bun:test` types it, so a test's arguments are inferred from its rows as before.
    each: ((rows: ReadonlyArray<ReadonlyArray<unknown>>) =>
      (name: string, run: (...args: ReadonlyArray<unknown>) => unknown): void => {
        const file = callerFile();
        bunTest.each(rows.map((row) => [...row]))(name, named(file, name, run));
      }) as unknown as typeof bunTest.each,
  },
);
