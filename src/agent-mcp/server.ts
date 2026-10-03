/**
 * One MCP server a session keeps: its process group (`agent-process`), and on each run a connection
 * to it (`client.ts`), with the machine in `server-machine.ts` saying where it is. Started in the
 * scope it is given (a session's), it ends with it. `reconnect` starts the server's process again
 * and connects to it anew; `stop` ends it.
 *
 * A run that does not answer `initialize` within `connectTimeout` has failed, and its process is
 * stopped, so none is left behind. A call is made on the run that is ready; while none is, it fails
 * with what is known of the server. Every change of state is logged.
 */

import { Duration, Effect, Semaphore, Stream, SubscriptionRef } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import type { Scope } from "effect";
import type { ProcessState } from "../agent-process/machine.ts";
import { makeProcessGroup } from "../agent-process/process-group.ts";
import { connect, McpFailed, type McpConnection, type McpServerStdio, type Root, type ToolResult } from "./client.ts";
import { logKeys } from "./log-keys.ts";
import { describe, initialMcpServerState, type McpServerEvent, type McpServerState, stepMcpServer } from "./server-machine.ts";

/** How long a server has to answer `initialize` once its process runs, unless a host says otherwise. */
export const defaultConnectTimeout: Duration.Input = "30 seconds";

export interface McpServer {
  readonly name: string;
  readonly state: Effect.Effect<McpServerState>;
  /** Its process group's state (`agent-process`). */
  readonly process: Effect.Effect<ProcessState>;
  /** The state now, then each change of it. */
  readonly changes: Stream.Stream<McpServerState>;
  /** The state once the server is no longer connecting: ready, failed, exited or stopped. */
  readonly settled: Effect.Effect<McpServerState>;
  /** Calls a tool of the run that is ready, giving its result as the server sent it. */
  readonly call: (tool: string, args: Readonly<Record<string, unknown>>) => Effect.Effect<ToolResult, McpFailed>;
  /** Starts the server's process again and connects to it anew. */
  readonly reconnect: Effect.Effect<void>;
  readonly stop: Effect.Effect<void>;
}

/** Starts `server` in the scope given, and connects to it; `roots` are what it is told when it asks. */
export const startMcpServer = (
  server: McpServerStdio,
  roots: ReadonlyArray<Root>,
  options: { readonly connectTimeout?: Duration.Input | undefined } = {},
): Effect.Effect<McpServer, never, Scope.Scope | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const timeout = options.connectTimeout ?? defaultConnectTimeout;
    const state = yield* SubscriptionRef.make<McpServerState>(initialMcpServerState);
    const lock = yield* Semaphore.make(1);
    const connections = new Map<number, McpConnection>();
    let stopProcess: Effect.Effect<void> = Effect.void;

    const dispatch = (event: McpServerEvent): Effect.Effect<void> =>
      lock
        .withPermit(
          Effect.gen(function* () {
            const before = yield* SubscriptionRef.get(state);
            const step = stepMcpServer(before, event);
            if (step.state !== before) {
              yield* SubscriptionRef.set(state, step.state);
              if (step.state.run !== before.run || (step.state._tag !== "Ready" && step.state._tag !== "Connecting")) connections.delete(before.run);
              const tools = step.state._tag === "Ready" ? step.state.tools.map((tool) => tool.name) : undefined;
              yield* Effect.logInfo(logKeys.server.changed, { server: server.name, event: event._tag, from: before._tag, to: step.state._tag, run: step.state.run, said: describe(step.state), ...(tools === undefined ? {} : { tools }) });
            }
            return step.effects;
          }),
        )
        .pipe(Effect.flatMap((effects) => Effect.forEach(effects, () => stopProcess, { discard: true })));

    const group = yield* makeProcessGroup({ name: `mcp ${server.name}`, command: server.command, args: server.args, env: server.env, cwd: server.cwd }, (run, handle) =>
      connect(server.name, handle, roots).pipe(
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () => Effect.fail(new McpFailed({ server: server.name, reason: `did not answer initialize within ${Duration.format(Duration.fromInputUnsafe(timeout))}` })),
        }),
        Effect.flatMap((connection) =>
          Effect.gen(function* () {
            connections.set(run, connection);
            const tools = yield* connection.tools;
            yield* dispatch({ _tag: "Connected", run, tools });
          }),
        ),
        Effect.catch((error) => dispatch({ _tag: "ConnectFailed", run, reason: error.reason })),
      ),
    );
    stopProcess = group.stop;
    yield* group.changes.pipe(
      Stream.runForEach((process) => dispatch({ _tag: "Process", state: process })),
      Effect.forkScoped,
    );
    yield* group.start;

    return {
      name: server.name,
      state: SubscriptionRef.get(state),
      process: group.state,
      changes: SubscriptionRef.changes(state),
      settled: SubscriptionRef.changes(state).pipe(
        Stream.filter((now) => now._tag !== "Connecting" && !(now._tag === "Stopped" && now.run === 0)),
        Stream.runHead,
        Effect.map((first) => (first._tag === "Some" ? first.value : initialMcpServerState)),
      ),
      call: (tool, args) =>
        Effect.gen(function* () {
          const now = yield* SubscriptionRef.get(state);
          const connection = now._tag === "Ready" ? connections.get(now.run) : undefined;
          if (connection === undefined) return yield* new McpFailed({ server: server.name, reason: `${tool} was not called: the server is not running (${describe(now)})` });
          return yield* connection.call(tool, args);
        }),
      reconnect: group.restart,
      stop: group.stop,
    };
  });
