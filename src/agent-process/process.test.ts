/** The process group state machine, and process groups that run real processes. */

import { expect } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Deferred, Duration, Effect, Exit, Layer, Logger, PlatformError, Scope, Sink, Stream } from "effect";
import fc from "fast-check";
import { ChildProcessSpawner } from "effect/process";
import { runTest } from "../../tests/support/run.ts";
import { test } from "../../tests/support/test.ts";
import { logKeys } from "./log-keys.ts";
import { initialProcessState, type ProcessState, stepProcess } from "./machine.ts";
import { makeProcessGroup, type ProcessGroup } from "./process-group.ts";

test("Start while a run is live changes nothing; Restart kills the live run and spawns the next; an end reported for the earlier run changes nothing; Stop kills the live run and returns to Idle", () => {
  const started = stepProcess(initialProcessState, { _tag: "Start" });
  expect(started).toEqual({ state: { _tag: "Starting", run: 1 }, effects: [{ _tag: "Spawn", run: 1 }] });
  const running = stepProcess(started.state, { _tag: "Started", run: 1, pid: 100 }).state;
  expect(stepProcess(running, { _tag: "Start" })).toEqual({ state: running, effects: [] });
  const restarted = stepProcess(running, { _tag: "Restart" });
  expect(restarted).toEqual({ state: { _tag: "Starting", run: 2 }, effects: [{ _tag: "Kill", run: 1 }, { _tag: "Spawn", run: 2 }] });
  // Run 1 reports its end after run 2 was requested; the state does not change.
  expect(stepProcess(restarted.state, { _tag: "Ended", run: 1, code: 143, signal: undefined })).toEqual({ state: restarted.state, effects: [] });
  const second = stepProcess(restarted.state, { _tag: "Started", run: 2, pid: 200 }).state;
  expect(stepProcess(second, { _tag: "Stop" })).toEqual({ state: { _tag: "Idle", run: 2 }, effects: [{ _tag: "Kill", run: 2 }] });
});

/** Returns the first state of `group` that `is` accepts; fails after five seconds. */
const until = (group: ProcessGroup, is: (state: ProcessState) => boolean) =>
  group.changes.pipe(Stream.filter(is), Stream.runHead, Effect.timeout("5 seconds"), Effect.map((state) => (state._tag === "Some" ? state.value : undefined)));

/** Whether the process with id `pid` exists. A negative `pid` names a process group. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Waits up to one second for process `pid` to exit, and returns whether it has exited. */
const gone = (pid: number) =>
  Effect.gen(function* () {
    for (let tries = 0; tries < 50 && alive(pid); tries++) yield* Effect.sleep("20 millis");
    return !alive(pid);
  });

const sh = (script: string) => ({ name: "test", command: "/bin/sh", args: ["-c", script], env: {} });

test("a run that exits by itself is Exited with its exit code", async () => {
  const exited = await runTest(
    Effect.gen(function* () {
      const group = yield* makeProcessGroup(sh("exit 3"));
      yield* group.start;
      return yield* until(group, (state) => state._tag === "Exited");
    }).pipe(Effect.provide(BunServices.layer)),
  );
  expect(exited).toEqual({ _tag: "Exited", run: 1, code: 3, signal: undefined });
});

test("a run that a signal ends is Exited with the signal's name and no exit code", async () => {
  const exited = await runTest(
    Effect.gen(function* () {
      const group = yield* makeProcessGroup(sh("kill -TERM $$"));
      yield* group.start;
      return yield* until(group, (state) => state._tag === "Exited");
    }).pipe(Effect.provide(BunServices.layer)),
  );
  expect(exited).toEqual({ _tag: "Exited", run: 1, code: undefined, signal: "SIGTERM" });
});

test("a command that cannot be started is Failed, with a reason that names the command", async () => {
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

test("after a run exits by itself, onRun reads the run's output to its end before the run's scope closes", async () => {
  const read = await runTest(
    Effect.gen(function* () {
      const output = yield* Deferred.make<string>();
      const group = yield* makeProcessGroup(sh("echo last words"), (_run, handle) =>
        Effect.sleep("200 millis").pipe(
          Effect.andThen(handle.stdout.pipe(Stream.decodeText, Stream.mkString)),
          Effect.flatMap((text) => Deferred.succeed(output, text)),
          Effect.ignore,
        ),
      );
      yield* group.start;
      return yield* Deferred.await(output).pipe(Effect.timeout("5 seconds"));
    }).pipe(Effect.provide(BunServices.layer)),
  );
  expect(read).toBe("last words\n");
});

test("when onRun is still running 2 seconds after its run exits by itself, the run's scope closes and interrupts onRun", async () => {
  const waited = await runTest(
    Effect.gen(function* () {
      const closed = yield* Deferred.make<void>();
      const group = yield* makeProcessGroup(sh("exit 0"), () => Effect.addFinalizer(() => Deferred.succeed(closed, undefined)).pipe(Effect.andThen(Effect.never)));
      yield* group.start;
      yield* until(group, (state) => state._tag === "Exited");
      const [elapsed] = yield* Deferred.await(closed).pipe(Effect.timeout("5 seconds"), Effect.timed);
      return Duration.toMillis(elapsed);
    }).pipe(Effect.provide(BunServices.layer)),
  );
  expect(waited).toBeGreaterThan(1500);
  expect(waited).toBeLessThan(3000);
});

/** A spawner whose one process has pid 42, writes nothing, and whose exit code fails to read with an error that names no signal. */
const exitUnreadable = Layer.succeed(
  ChildProcessSpawner.ChildProcessSpawner,
  ChildProcessSpawner.make(() =>
    Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(42),
        exitCode: Effect.fail(PlatformError.systemError({ _tag: "Unknown", module: "ChildProcess", method: "exitCode", description: "the exit was lost" })),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    ),
  ),
);

test("when the spawner reports neither an exit code nor a signal, the run is Exited with neither, and process.run.exit_unread is logged as a warning with the error", async () => {
  const logged: Array<{ readonly level: string; readonly message: unknown }> = [];
  const logging = Logger.layer([Logger.make((options) => logged.push({ level: options.logLevel, message: options.message }))], { mergeWithExisting: true });
  const exited = await runTest(
    Effect.gen(function* () {
      const group = yield* makeProcessGroup(sh("exit 0"));
      yield* group.start;
      return yield* until(group, (state) => state._tag === "Exited");
    }).pipe(Effect.provide(Layer.mergeAll(exitUnreadable, logging))),
  );
  expect(exited).toEqual({ _tag: "Exited", run: 1, code: undefined, signal: undefined });
  const warned = logged.filter((each) => each.level === "Warn" && Array.isArray(each.message) && each.message[0] === logKeys.process.exitUnread);
  expect(warned.map((each) => (each.message as [string, unknown])[1])).toMatchObject([{ name: "test", run: 1, error: expect.stringContaining("the exit was lost") }]);
});

/** Starts a group whose run starts a child process in the background and prints the child's pid. Returns the group, the run's pid and the child's pid. */
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

test("Stop kills the run's whole process group, including a process started in the background, and the next Start begins run 2", async () => {
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

test("closing the scope that the group was made in kills the run's whole process group, including a process started in the background", async () => {
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

const processEvent = fc.oneof(
  fc.constant({ _tag: "Start" } as const),
  fc.constant({ _tag: "Restart" } as const),
  fc.constant({ _tag: "Stop" } as const),
  fc.record({ _tag: fc.constant("Started" as const), run: fc.integer({ min: 0, max: 6 }), pid: fc.integer({ min: 1, max: 99 }) }),
  fc.record({ _tag: fc.constant("StartFailed" as const), run: fc.integer({ min: 0, max: 6 }), reason: fc.constant("no") }),
  fc.record({ _tag: fc.constant("Ended" as const), run: fc.integer({ min: 0, max: 6 }), code: fc.option(fc.integer({ min: 0, max: 3 }), { nil: undefined }), signal: fc.constant(undefined) }),
);

test("for any sequence of events, the run number never decreases, a run is spawned only by Restart or by Start without a live run, the spawned run is the current one, and an event for another run changes nothing", () => {
  fc.assert(
    fc.property(fc.array(processEvent, { maxLength: 30 }), (events) => {
      events.reduce<ProcessState>((state, event) => {
        const step = stepProcess(state, event);
        expect(step.state.run).toBeGreaterThanOrEqual(state.run);
        const live = state._tag === "Starting" || state._tag === "Running";
        const spawned = step.effects.filter((effect) => effect._tag === "Spawn");
        expect(spawned.length).toBe(event._tag === "Restart" || (event._tag === "Start" && !live) ? 1 : 0);
        for (const effect of spawned) expect(effect.run).toBe(step.state.run);
        if ((event._tag === "Started" || event._tag === "StartFailed" || event._tag === "Ended") && event.run !== state.run) expect(step).toEqual({ state, effects: [] });
        return step.state;
      }, initialProcessState);
    }),
    { numRuns: 1000 },
  );
});
