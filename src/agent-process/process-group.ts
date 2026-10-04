/**
 * A child process group a session keeps, run by the machine in `machine.ts`. Each run is started in
 * a scope of its own, a child of the scope the group is made in (a session's): the process runs in a
 * group of its own (Effect's spawner starts it detached), and closing the run's scope ends the whole
 * group, what the process started included. Stopping a run, starting it again, and closing the
 * session's scope all end it that way. What a consumer does with a run's input and output (`onRun`)
 * runs in the run's scope, and ends with it.
 *
 * A run that ends by itself is `Exited` at once; what it wrote is read to its end (`onRun` finishes,
 * for `consumerGrace` at most) before its scope closes, which ends what it left running.
 *
 * A run is given this process's environment without the variables that hold credentials
 * (`environment.ts`), and the command's own `env` over it. Every change of state is logged, with the
 * group's name and everything the state says, and each run's environment by the names left out and
 * set, never their values.
 */

import { Effect, Exit, Fiber, HashMap, Option, Ref, Scope, Semaphore, Stream, SubscriptionRef } from "effect";
import { ChildProcess, type ChildProcessSpawner } from "effect/process";
import { redactedArgs, withoutCredentials } from "./environment.ts";
import { logKeys } from "./log-keys.ts";
import { initialProcessState, type ProcessEffect, type ProcessEvent, type ProcessState, stepProcess } from "./machine.ts";

/** How long, once a run has ended by itself, what it gave `onRun` may go on before its scope closes. */
export const consumerGrace = "2 seconds";

export interface ProcessCommand {
  /** What the group is called in the log. */
  readonly name: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** Set over this process's environment. */
  readonly env: Readonly<Record<string, string>>;
  /** The folder it runs in; this process's when left out. */
  readonly cwd?: string | undefined;
}

export interface ProcessGroup {
  readonly state: Effect.Effect<ProcessState>;
  /** The state now, then each change of it. */
  readonly changes: Stream.Stream<ProcessState>;
  /** Starts a run, unless one is starting or running. */
  readonly start: Effect.Effect<void>;
  /** Ends the run there is, if any, and starts another. */
  readonly restart: Effect.Effect<void>;
  /** Ends the run there is, if any. */
  readonly stop: Effect.Effect<void>;
}

/**
 * The group for `command`, in the scope given; nothing runs until it is started. `onRun` is given
 * each run's handle once it runs, and runs in the run's scope.
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
    // Each live run's scope, by run number.
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
        // This process's environment without its credentials, then the command's own, as said.
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
        yield* dispatch({ _tag: "Ended", run, code: exit._tag === "Success" ? exit.success : undefined, signal: undefined });
        // What the run wrote before it ended is read to its end before the run's scope closes, for a while at most.
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
