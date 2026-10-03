/** A session's child process groups: the machine, and real processes run by it. */

import { expect } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Deferred, Effect, Exit, Scope, Stream } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { runTest } from "../../tests/support/run.ts";
import { test } from "../../tests/support/test.ts";
import { initialProcessState, type ProcessState, stepProcess } from "./machine.ts";
import { makeProcessGroup, type ProcessGroup } from "./process-group.ts";

test("PG1: an end reported for an earlier run changes nothing once the group was started again; start does nothing while a run is starting or running; stop ends the run", () => {
  const started = stepProcess(initialProcessState, { _tag: "Start" });
  expect(started).toEqual({ state: { _tag: "Starting", run: 1 }, effects: [{ _tag: "Spawn", run: 1 }] });
  const running = stepProcess(started.state, { _tag: "Started", run: 1, pid: 100 }).state;
  expect(stepProcess(running, { _tag: "Start" })).toEqual({ state: running, effects: [] });
  const restarted = stepProcess(running, { _tag: "Restart" });
  expect(restarted).toEqual({ state: { _tag: "Starting", run: 2 }, effects: [{ _tag: "Kill", run: 1 }, { _tag: "Spawn", run: 2 }] });
  // Run 1 reports its end after run 2 was asked for: nothing changes.
  expect(stepProcess(restarted.state, { _tag: "Ended", run: 1, code: 143, signal: undefined })).toEqual({ state: restarted.state, effects: [] });
  const second = stepProcess(restarted.state, { _tag: "Started", run: 2, pid: 200 }).state;
  expect(stepProcess(second, { _tag: "Stop" })).toEqual({ state: { _tag: "Idle", run: 2 }, effects: [{ _tag: "Kill", run: 2 }] });
});

/** The first state of `group` that `is` accepts, within five seconds. */
const until = (group: ProcessGroup, is: (state: ProcessState) => boolean) =>
  group.changes.pipe(Stream.filter(is), Stream.runHead, Effect.timeout("5 seconds"), Effect.map((state) => (state._tag === "Some" ? state.value : undefined)));

/** Whether a process (a positive id) or a process group (a negative one) is still there. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Waits, a second at most, until `pid` is gone; whether it is. */
const gone = (pid: number) =>
  Effect.gen(function* () {
    for (let tries = 0; tries < 50 && alive(pid); tries++) yield* Effect.sleep("20 millis");
    return !alive(pid);
  });

const sh = (script: string) => ({ name: "test", command: "/bin/sh", args: ["-c", script], env: {} });

test("PG2: a run that ends by itself is Exited, with its exit code", async () => {
  const exited = await runTest(
    Effect.gen(function* () {
      const group = yield* makeProcessGroup(sh("exit 3"));
      yield* group.start;
      return yield* until(group, (state) => state._tag === "Exited");
    }).pipe(Effect.provide(BunServices.layer)),
  );
  expect(exited).toEqual({ _tag: "Exited", run: 1, code: 3, signal: undefined });
});

test("PG3: a command that cannot be started is Failed, with the reason", async () => {
  const failed = await runTest(
    Effect.gen(function* () {
      const group = yield* makeProcessGroup({ name: "test", command: "/no/such/command", args: [], env: {} });
      yield* group.start;
      return yield* until(group, (state) => state._tag === "Failed");
    }).pipe(Effect.provide(BunServices.layer)),
  );
  expect(failed?._tag).toBe("Failed");
  expect(failed?._tag === "Failed" ? failed.reason : "").toContain("/no/such/command");
});

/** A group whose run starts a child in the background and says its pid: the group's pid and the child's. */
const withChild = (group: (onRun: Parameters<typeof makeProcessGroup>[1]) => Effect.Effect<ProcessGroup, never, Scope.Scope | ChildProcessSpawner.ChildProcessSpawner>) =>
  Effect.gen(function* () {
    const said = yield* Deferred.make<number>();
    const made = yield* group((_run, handle) =>
      handle.stdout.pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.runHead,
        Effect.flatMap((line) => Deferred.succeed(said, Number(line._tag === "Some" ? line.value : NaN))),
        Effect.ignore,
      ),
    );
    yield* made.start;
    const running = yield* until(made, (state) => state._tag === "Running");
    const child = yield* Deferred.await(said).pipe(Effect.timeout("5 seconds"));
    return { group: made, pid: running?._tag === "Running" ? running.pid : NaN, child };
  });

test("PG4: stopping a run ends its whole group, what it started in the background included; starting again is a new run", async () => {
  const seen = await runTest(
    Effect.gen(function* () {
      const { group, pid, child } = yield* withChild((onRun) => makeProcessGroup(sh("sleep 30 & echo $!; sleep 30"), onRun));
      const before = { process: alive(pid), child: alive(child) };
      yield* group.stop;
      const after = { process: yield* gone(pid), child: yield* gone(child), state: (yield* group.state)._tag };
      yield* group.start;
      const again = yield* until(group, (state) => state._tag === "Running");
      return { before, after, again: again?.run };
    }).pipe(Effect.provide(BunServices.layer)),
  );
  expect(seen).toEqual({ before: { process: true, child: true }, after: { process: true, child: true, state: "Idle" }, again: 2 });
});

test("PG5: closing the scope the group was made in (the session's) ends its group", async () => {
  const seen = await runTest(
    Effect.gen(function* () {
      const session = yield* Scope.make();
      const { pid, child } = yield* withChild((onRun) => makeProcessGroup(sh("sleep 30 & echo $!; sleep 30"), onRun).pipe(Scope.provide(session)));
      yield* Scope.close(session, Exit.void);
      return { process: yield* gone(pid), child: yield* gone(child) };
    }).pipe(Effect.provide(BunServices.layer)),
  );
  expect(seen).toEqual({ process: true, child: true });
});
