/**
 * A process group that a session keeps. `makeProcessGroup` performs the effects of the state
 * machine in `machine.ts` with Effect's `ChildProcessSpawner`.
 *
 * - Each run has its own scope, a child of the scope that the group is made in. The spawner starts
 *   the process detached, in a new process group, and closing the run's scope kills that process
 *   group. `stop`, `restart` and closing the group's scope all close the run's scope.
 * - `onRun` runs in the run's scope. After a run exits by itself, the run's scope stays open until
 *   `onRun` finishes, for `consumerGrace` at most.
 * - A run inherits this process's environment without its credential variables, with the command's
 *   own `env` applied over it.
 * - Every state change is logged with the group's name, the command line with credential values
 *   redacted, the event, and the states before and after. Each run's environment is logged by
 *   variable names only.
 */

import { Effect, Exit, Fiber, HashMap, Option, type PlatformError, Ref, Scope, Semaphore, Stream, SubscriptionRef } from "effect";
import { ChildProcess, type ChildProcessSpawner } from "effect/process";
import { redactedArgs, withoutCredentials } from "./environment.ts";
import { logKeys } from "./log-keys.ts";
import { initialProcessState, type ProcessEffect, type ProcessEvent, type ProcessState, stepProcess } from "./machine.ts";

/** How long a run's scope stays open for `onRun` after the run exits by itself. */
export const consumerGrace = "2 seconds";

export interface ProcessCommand {
  /** The group's name in log events. */
  readonly name: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** Variables set over the inherited environment, credentials included. */
  readonly env: Readonly<Record<string, string>>;
  /** The working directory. When undefined, the process uses this process's working directory. */
  readonly cwd?: string | undefined;
}

export interface ProcessGroup {
  readonly state: Effect.Effect<ProcessState>;
  /** Emits the current state, then each new state. */
  readonly changes: Stream.Stream<ProcessState>;
  /** Starts a new run, unless a run is starting or running. */
  readonly start: Effect.Effect<void>;
  /** Kills the live run, if there is one, and starts a new run. */
  readonly restart: Effect.Effect<void>;
  /** Kills the live run, if there is one. */
  readonly stop: Effect.Effect<void>;
}

/**
 * Returns the name of the signal that ended a run, parsed from the error that `exitCode` fails with.
 * When a signal ends a process, Effect's spawner fails `exitCode` with an error whose cause is an
 * `Error` with the message "Process interrupted due to receipt of signal: '<name>'". Returns
 * undefined for any other error.
 */
const signalOf = (error: PlatformError.PlatformError): string | undefined => {
  const cause = error.reason.cause;
  return cause instanceof Error ? /receipt of signal: '([A-Z0-9]+)'/.exec(cause.message)?.[1] : undefined;
};

/**
 * Returns the process group for `command`, in the current scope. No process starts until `start` or
 * `restart` is called. `onRun` receives each run's process handle once the process has started.
 */
export const makeProcessGroup = (
  command: ProcessCommand,
  onRun: (run: number, handle: ChildProcessSpawner.ChildProcessHandle) => Effect.Effect<void, never, Scope.Scope> = () => Effect.void,
): Effect.Effect<ProcessGroup, never, Scope.Scope | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const scope = yield* Scope.Scope;
    const context = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>();
    const state = yield* SubscriptionRef.make<ProcessState>(initialProcessState);
    const lock = yield* Semaphore.make(1);
    // The scope of each live run, by run number.
    const runs = yield* Ref.make(HashMap.empty<number, Scope.Closeable>());

    /** Removes `run` from the live runs and closes its scope, if it is live. */
    const ended = (run: number) =>
      Ref.modify(runs, (live) => [HashMap.get(live, run), HashMap.remove(live, run)] as const).pipe(
        Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: (runScope) => Scope.close(runScope, Exit.void) })),
      );

    const spawn = (run: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        const runScope = yield* Scope.fork(scope);
        yield* Ref.update(runs, HashMap.set(run, runScope));
        // The command's own `env` is applied after the credentials are removed, so a server receives the credential that its configuration names.
        const inherited = withoutCredentials(process.env);
        yield* Effect.logInfo(logKeys.process.environment, { name: command.name, run, leftOut: inherited.left, set: Object.keys(command.env) });
        const started = yield* ChildProcess.make(command.command, [...command.args], {
          env: { ...inherited.env, ...command.env },
          extendEnv: false,
          ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
        }).pipe(Scope.provide(runScope), Effect.provideContext(context), Effect.result);
        if (started._tag === "Failure") {
          yield* dispatch({ _tag: "StartFailed", run, reason: String(started.failure) });
          return yield* ended(run);
        }
        const handle = started.success;
        yield* dispatch({ _tag: "Started", run, pid: handle.pid });
        const consumer = yield* Effect.forkIn(onRun(run, handle).pipe(Scope.provide(runScope)), runScope);
        const exit = yield* Effect.result(handle.exitCode);
        const signal = exit._tag === "Failure" ? signalOf(exit.failure) : undefined;
        if (exit._tag === "Failure" && signal === undefined)
          yield* Effect.logWarning(logKeys.process.exitUnread, { name: command.name, run, error: exit.failure.message, cause: String(exit.failure.reason.cause) });
        yield* dispatch({ _tag: "Ended", run, code: exit._tag === "Success" ? exit.success : undefined, signal });
        // Closing the run's scope interrupts onRun, so onRun gets up to consumerGrace to read the run's last output.
        yield* Fiber.await(consumer).pipe(Effect.timeoutOption(consumerGrace));
        yield* ended(run);
      }).pipe(Effect.forkIn(scope), Effect.asVoid);

    const perform = (effect: ProcessEffect): Effect.Effect<void> => {
      switch (effect._tag) {
        case "Spawn":
          return spawn(effect.run);
        case "Kill":
          return ended(effect.run);
        default:
          return effect satisfies never;
      }
    };

    const dispatch = (event: ProcessEvent): Effect.Effect<void> =>
      lock
        .withPermit(
          Effect.gen(function* () {
            const before = yield* SubscriptionRef.get(state);
            const step = stepProcess(before, event);
            if (step.state !== before) {
              yield* SubscriptionRef.set(state, step.state);
              yield* Effect.logInfo(logKeys.process.changed, { name: command.name, command: command.command, args: redactedArgs(command.args), event: event._tag, from: before, to: step.state });
            }
            return step.effects;
          }),
        )
        .pipe(Effect.flatMap((effects) => Effect.forEach(effects, perform, { discard: true })));

    return {
      state: SubscriptionRef.get(state),
      changes: SubscriptionRef.changes(state),
      start: dispatch({ _tag: "Start" }),
      restart: dispatch({ _tag: "Restart" }),
      stop: dispatch({ _tag: "Stop" }),
    };
  });
