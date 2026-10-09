/**
 * The process groups that a session's commands start (`run_command`), and how the session stops them
 * when it closes.
 *
 * - A command runs as a process group of its own. A command that ends by itself leaves what it
 *   started in the background to run on (`nohup server &`). The command registers its group when it
 *   starts (`started`), and the group stays registered after the command ends.
 * - Each registration first removes the groups that no longer exist.
 * - When the session closes, it stops every group still registered (`stopAll`):
 *   1. a group that no longer exists is skipped;
 *   2. every other group is sent SIGTERM;
 *   3. a group that still exists `stopGrace` after SIGTERM is sent SIGKILL.
 *
 *   Each step is logged with the session, the group and the call that started the group. `stopAll`
 *   empties the registry, so a session opened again with the same context starts with no groups.
 *
 * Limits:
 * - A process group id is not reused while the group exists, but it can be reused after the group
 *   ends. If a registered group ends and another process group takes its id before the session
 *   closes, the session stops that other group. Removing ended groups at each registration makes that
 *   window shorter; it does not remove it.
 * - Nothing is stopped when the harness exits without closing the session's scope: when it is killed
 *   (SIGKILL), or when the CLI exits at a second Ctrl+C. The groups run on.
 */

import { Clock, Duration, Effect, HashMap, Ref } from "effect";
import type { CallId, SessionId } from "../agent-machine/names.ts";
import { logKeys } from "./log-keys.ts";

/** How long a closing session waits for its groups to end after SIGTERM before it sends SIGKILL. */
export const stopGrace = Duration.seconds(2);

/** How often a closing session checks whether its groups have ended, while it waits after SIGTERM. */
const checkEvery = Duration.millis(50);

/** A process group that a command started. */
export interface StartedGroup {
  /** The process group's id: the pid of the command's shell, which leads the group. */
  readonly group: number;
  /** The call that ran the command. */
  readonly call: CallId;
}

/** The process groups that a session's commands started. */
export interface SessionProcesses {
  /** Registers `started`, after removing the registered groups that no longer exist. */
  readonly started: (started: StartedGroup) => Effect.Effect<void>;
  /** Stops every registered group (the module's steps) and empties the registry. */
  readonly stopAll: Effect.Effect<void>;
}

/** What sending a signal to a process group did. */
type Signalled = { readonly _tag: "Sent" } | { readonly _tag: "Gone" } | { readonly _tag: "Failed"; readonly error: string };

/** Sends `signal` to the process group `group`. Signal 0 sends nothing: it tells whether the group exists. */
const signalGroup = (group: number, signal: NodeJS.Signals | 0): Signalled => {
  try {
    process.kill(-group, signal);
    return { _tag: "Sent" };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return { _tag: "Gone" };
    return { _tag: "Failed", error: String(error) };
  }
};

/** Whether the process group `group` exists. A group that cannot be signalled for another reason counts as existing. */
const exists = (group: number): boolean => signalGroup(group, 0)._tag !== "Gone";

/** Makes the registry of the session `session`, with no groups. */
export const makeSessionProcesses = (session: SessionId): Effect.Effect<SessionProcesses> =>
  Effect.gen(function* () {
    const registry = yield* Ref.make(HashMap.empty<number, StartedGroup>());

    /** Logs that `started` ended before the session stopped it. */
    const ended = (started: StartedGroup) => Effect.logDebug(logKeys.session.groupEnded, { session, group: started.group, call: started.call });

    /** Sends `signal` to `started`'s group and logs what happened; returns whether the signal was sent. */
    const send = (started: StartedGroup, signal: NodeJS.Signals) =>
      Effect.gen(function* () {
        const signalled = signalGroup(started.group, signal);
        const details = { session, group: started.group, call: started.call };
        if (signalled._tag === "Gone") yield* ended(started);
        if (signalled._tag === "Failed") yield* Effect.logWarning(logKeys.session.signalFailed, { ...details, signal, error: signalled.error });
        if (signalled._tag === "Sent" && signal === "SIGTERM") yield* Effect.logInfo(logKeys.session.groupTerminated, details);
        if (signalled._tag === "Sent" && signal === "SIGKILL") yield* Effect.logWarning(logKeys.session.groupKilled, { ...details, grace: Duration.format(stopGrace) });
        return signalled._tag === "Sent";
      });

    /** Waits until each of `groups` has ended, or until `deadline` (in milliseconds); returns those that have not ended. */
    const awaitEnd = (groups: ReadonlyArray<StartedGroup>, deadline: number): Effect.Effect<ReadonlyArray<StartedGroup>> =>
      Effect.gen(function* () {
        const left = groups.filter((each) => exists(each.group));
        if (left.length === 0 || (yield* Clock.currentTimeMillis) >= deadline) return left;
        yield* Effect.sleep(checkEvery);
        return yield* awaitEnd(left, deadline);
      });

    const started = (group: StartedGroup): Effect.Effect<void> =>
      Effect.gen(function* () {
        const gone = [...HashMap.values(yield* Ref.get(registry))].filter((each) => !exists(each.group));
        yield* Effect.forEach(gone, ended, { discard: true });
        yield* Ref.update(registry, (now) => HashMap.set(HashMap.removeMany(now, gone.map((each) => each.group)), group.group, group));
      });

    const stopAll: Effect.Effect<void> = Effect.gen(function* () {
      const groups = [...HashMap.values(yield* Ref.getAndSet(registry, HashMap.empty()))];
      const terminated = yield* Effect.filter(groups, (each) => send(each, "SIGTERM"));
      if (terminated.length === 0) return;
      const left = yield* awaitEnd(terminated, (yield* Clock.currentTimeMillis) + Duration.toMillis(stopGrace));
      yield* Effect.forEach(left, (each) => send(each, "SIGKILL"), { discard: true });
    });

    return { started, stopAll };
  });
