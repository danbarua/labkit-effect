/** The registry of the process groups that a session's commands start, with real processes. */

import { expect } from "bun:test";
import { Effect, Logger, References } from "effect";
import { runTest } from "../../tests/support/run.ts";
import { test } from "../../tests/support/test.ts";
import { CallId, SessionId } from "../agent-machine/names.ts";
import { logKeys } from "./log-keys.ts";
import { makeSessionProcesses } from "./session-processes.ts";

/** Whether the process with id `pid` exists. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Waits until the process `pid` no longer exists, for 5 seconds at most; returns whether it ended. */
const ends = async (pid: number): Promise<boolean> => {
  const deadline = Date.now() + 5000;
  const check = async (): Promise<boolean> => (!alive(pid) ? true : Date.now() > deadline ? false : Bun.sleep(25).then(check));
  return check();
};

/**
 * Runs `script` as `sh -c` in a process group of its own, as `run_command` does, and waits for the
 * shell to end. The script prints the pid of what it starts in the background. Returns the group's id
 * (the shell's pid) and the printed pid.
 */
const leftRunning = async (script: string): Promise<{ readonly group: number; readonly background: number }> => {
  const child = Bun.spawn(["/bin/sh", "-c", script], { stdin: "ignore", stdout: "pipe", stderr: "ignore", detached: true });
  const printed = await new Response(child.stdout).text();
  await child.exited;
  return { group: child.pid, background: Number(printed.trim()) };
};

/** Runs `program` with Debug lines logged; returns its value and the lines logged under `logKeys.session`. */
const logging = async <A>(program: Effect.Effect<A>) => {
  const lines: Array<{ readonly level: string; readonly key: unknown; readonly details: unknown }> = [];
  const keys: ReadonlyArray<string> = Object.values(logKeys.session);
  const capture = Logger.make((options) => {
    const [key, details] = Array.isArray(options.message) ? options.message : [options.message];
    if (keys.includes(String(key))) lines.push({ level: options.logLevel, key, details });
  });
  const value = await runTest(program.pipe(Effect.provide(Logger.layer([capture], { mergeWithExisting: true })), Effect.provideService(References.MinimumLogLevel, "Debug")));
  return { value, lines };
};

const session = SessionId.make("s1");

test("stopAll sends SIGTERM to each registered group still running, which ends it, logs it at Info, and empties the registry", async () => {
  const started = await leftRunning("sleep 30 >/dev/null 2>&1 & echo $!");
  expect(alive(started.background)).toBe(true);
  const { lines } = await logging(
    Effect.gen(function* () {
      const processes = yield* makeSessionProcesses(session);
      yield* processes.started({ group: started.group, call: CallId.make("c1") });
      yield* processes.stopAll;
      // The registry is empty: a second stop sends nothing and logs nothing.
      yield* processes.stopAll;
    }),
  );
  expect(await ends(started.background)).toBe(true);
  expect(lines).toEqual([{ level: "Info", key: logKeys.session.groupTerminated, details: { session, group: started.group, call: "c1" } }]);
});

test("stopAll sends SIGKILL, logged as a warning, to a group that still runs stopGrace after SIGTERM", async () => {
  // The shell ignores SIGTERM, and what it starts inherits that.
  const started = await leftRunning("trap '' TERM; sleep 30 >/dev/null 2>&1 & echo $!");
  const { lines } = await logging(
    Effect.gen(function* () {
      const processes = yield* makeSessionProcesses(session);
      yield* processes.started({ group: started.group, call: CallId.make("c1") });
      yield* processes.stopAll;
    }),
  );
  expect(await ends(started.background)).toBe(true);
  const details = { session, group: started.group, call: "c1" };
  expect(lines).toEqual([
    { level: "Info", key: logKeys.session.groupTerminated, details },
    { level: "Warn", key: logKeys.session.groupKilled, details: { ...details, grace: "2s" } },
  ]);
});

test("a registration first removes the groups that have ended, logged at Debug; stopAll then signals only the groups still registered", async () => {
  const ended = await leftRunning("echo 0");
  const running = await leftRunning("sleep 30 >/dev/null 2>&1 & echo $!");
  const { lines } = await logging(
    Effect.gen(function* () {
      const processes = yield* makeSessionProcesses(session);
      yield* processes.started({ group: ended.group, call: CallId.make("c1") });
      yield* processes.started({ group: running.group, call: CallId.make("c2") });
      yield* processes.stopAll;
    }),
  );
  expect(await ends(running.background)).toBe(true);
  expect(lines).toEqual([
    { level: "Debug", key: logKeys.session.groupEnded, details: { session, group: ended.group, call: "c1" } },
    { level: "Info", key: logKeys.session.groupTerminated, details: { session, group: running.group, call: "c2" } },
  ]);
});
