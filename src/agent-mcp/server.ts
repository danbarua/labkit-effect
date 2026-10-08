/**
 * One MCP server that a session keeps, over its runs; the machine in `server-machine.ts` holds its
 * state. The server starts in the current scope (a session's) and ends with it. `reconnect` ends the
 * current run and starts another; `stop` ends it.
 *
 * - A stdio server's run is its process (`agent-process`), connected over the process's pipes
 *   (`client.ts` `connect`). The process receives the session's environment
 *   (`SessionContext.environment`) with the server's own `env` set over it. The run ends when the
 *   process does.
 * - A remote server's run is a connection to its URL (`http.ts`). When the server no longer has the
 *   session (a 404 to a request that carried it), a new session is made and the refused request is
 *   made again, once. A connection whose stream ends between requests (HTTP+SSE) is made anew. The
 *   run ends when a new connection cannot be made. A server that asks for credentials when its
 *   headers give none, or for OAuth, needs authorization (`NeedsAuth`); a server that refuses the
 *   credentials given has failed.
 *
 * A run that does not answer `initialize` and list its tools within `connectTimeout` has failed, and
 * is stopped, so nothing is left running. A call is made on the run that is ready; while no run is,
 * the call fails with the server's state. Every change of state is logged.
 */

import { Duration, Effect, Exit, HashMap, Option, Ref, Scope, Semaphore, Stream, SubscriptionRef } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import type { SessionContext } from "../agent-environment/session-context.ts";
import type { ProcessState } from "../agent-process/machine.ts";
import { isCredentialName } from "../agent-process/environment.ts";
import { makeProcessGroup } from "../agent-process/process-group.ts";
import { type ClientInfo, connect, McpFailed, type McpConnection, type McpServerStdio, type Root, type ToolResult } from "./client.ts";
import { connectRemote, type HttpRejection, type McpServerRemote, rejectionOf, type RemoteRefused, whereOf } from "./http.ts";
import { logKeys } from "./log-keys.ts";
import { describe, initialMcpServerState, type McpServerEvent, type McpServerState, stepMcpServer } from "./server-machine.ts";

/** How long a server has to answer `initialize` and list its tools once its run starts, unless the host sets another value. */
export const defaultConnectTimeout: Duration.Input = "30 seconds";

/** A server that a session keeps: run as a process, or reached at a URL. */
export type McpServerConfig = McpServerStdio | McpServerRemote;

export const isRemote = (server: McpServerConfig): server is McpServerRemote => "url" in server;

export interface McpServer {
  readonly name: string;
  readonly state: Effect.Effect<McpServerState>;
  /** Whether a run is live: a running process, or an open connection. */
  readonly running: Effect.Effect<boolean>;
  /** Emits the current state, then each new state. */
  readonly changes: Stream.Stream<McpServerState>;
  /** Waits until the server is no longer connecting, and returns its state: ready, failed, needing authorization, exited or stopped. */
  readonly settled: Effect.Effect<McpServerState>;
  /** Calls a tool on the run that is ready, and returns its result as the server sent it. */
  readonly call: (tool: string, args: Readonly<Record<string, unknown>>) => Effect.Effect<ToolResult, McpFailed>;
  /** Ends the server's current run, if there is one, and starts another. */
  readonly reconnect: Effect.Effect<void>;
  readonly stop: Effect.Effect<void>;
}

const endedOf = (process: Extract<ProcessState, { _tag: "Exited" }>): string => {
  if (process.code !== undefined) return `its process exited with code ${process.code}`;
  if (process.signal !== undefined) return `its process ended on ${process.signal}`;
  return "its process ended";
};

/** Returns the server machine's event for a process group's state, since a stdio server's run is a process. */
export const runEventOf = (process: ProcessState): McpServerEvent => {
  switch (process._tag) {
    case "Starting":
    case "Running":
      return { _tag: "RunStarted", run: process.run };
    case "Failed":
      return { _tag: "RunFailed", run: process.run, reason: `its process could not be started: ${process.reason}` };
    case "Exited":
      return { _tag: "RunEnded", run: process.run, reason: endedOf(process) };
    case "Idle":
      return { _tag: "RunStopped", run: process.run };
    default:
      return process satisfies never;
  }
};

/** Whether `server`'s headers give credentials: an `Authorization` header, or a header whose name is a credential name (`X-API-Key`). */
const givesCredentials = (server: McpServerRemote): boolean => Object.keys(server.headers).some((name) => /^(?:proxy-)?authorization$/i.test(name) || isCredentialName(name));

/**
 * Returns the event for a run of `server` that HTTP refused: `AuthNeeded` when the server asks for
 * credentials and none are given, or asks for OAuth; `ConnectFailed` when it refuses the credentials
 * given, or for any other refusal.
 */
type Verdict = Extract<McpServerEvent, { readonly _tag: "ConnectFailed" | "AuthNeeded" }>;

export const refusalOf = (server: McpServerRemote, run: number, rejection: HttpRejection): Verdict => {
  const status = rejection.status === 0 ? rejection.text : `HTTP ${rejection.status}${rejection.text === "" ? "" : `: ${rejection.text}`}`;
  if (rejection.status !== 401 && rejection.status !== 403) return { _tag: "ConnectFailed", run, reason: status };
  if (givesCredentials(server)) return { _tag: "ConnectFailed", run, reason: `the server refused the credentials given (${status})` };
  const oauth = /resource_metadata|oauth/i.test(rejection.authenticate ?? "");
  return {
    _tag: "AuthNeeded",
    run,
    reason: oauth
      ? `the server asks for OAuth (HTTP ${rejection.status}), which this client does not do yet; a token can be given in its headers`
      : `the server asks for credentials (HTTP ${rejection.status}) and its headers give none`,
  };
};

/** Returns the event for a run that did not connect: `AuthNeeded` or `ConnectFailed`. */
const verdictOf = (server: McpServerConfig, run: number, error: McpFailed | RemoteRefused): Verdict => {
  const rejection = error._tag === "RemoteRefused" ? error.rejection : rejectionOf(error);
  if (isRemote(server) && rejection !== undefined) return refusalOf(server, run, rejection);
  return { _tag: "ConnectFailed", run, reason: error._tag === "RemoteRefused" ? error.rejection.text : error.reason };
};

/** How a server's runs start and end: its process group, or its connections. */
interface Runs {
  readonly start: Effect.Effect<void>;
  readonly restart: Effect.Effect<void>;
  readonly stop: Effect.Effect<void>;
  /** Stops the run, for the machine (`StopRun`). */
  readonly stopRun: Effect.Effect<void>;
  readonly running: Effect.Effect<boolean>;
}

/** Starts `server` in the current scope and connects to it. `roots` are returned to the server when it asks. */
export const startMcpServer = (
  server: McpServerConfig,
  roots: ReadonlyArray<Root>,
  options: { readonly connectTimeout?: Duration.Input | undefined; readonly clientInfo?: ClientInfo | undefined } = {},
): Effect.Effect<McpServer, never, Scope.Scope | ChildProcessSpawner.ChildProcessSpawner | SessionContext> =>
  Effect.gen(function* () {
    const timeout = options.connectTimeout ?? defaultConnectTimeout;
    const state = yield* SubscriptionRef.make<McpServerState>(initialMcpServerState);
    const lock = yield* Semaphore.make(1);
    // The connection of each run that has connected, by run.
    const connections = yield* Ref.make(HashMap.empty<number, McpConnection>());
    // How the machine stops a run (`StopRun`): set once the runs are made, because making them needs `dispatch`.
    const stopRunRef = yield* Ref.make<Effect.Effect<void>>(Effect.void);
    const stopRun = Effect.flatten(Ref.get(stopRunRef));

    const dispatch = (event: McpServerEvent): Effect.Effect<void> =>
      lock
        .withPermit(
          Effect.gen(function* () {
            const before = yield* SubscriptionRef.get(state);
            const step = stepMcpServer(before, event);
            if (step.state !== before) {
              yield* SubscriptionRef.set(state, step.state);
              if (step.state.run !== before.run || (step.state._tag !== "Ready" && step.state._tag !== "Connecting")) yield* Ref.update(connections, HashMap.remove(before.run));
              const tools = step.state._tag === "Ready" ? step.state.tools.map((tool) => tool.name) : undefined;
              yield* Effect.logInfo(logKeys.server.changed, { server: server.name, event: event._tag, from: before._tag, to: step.state._tag, run: step.state.run, description: describe(step.state), ...(tools === undefined ? {} : { tools }) });
            }
            return step.effects;
          }),
        )
        .pipe(Effect.flatMap((effects) => Effect.forEach(effects, () => stopRun, { discard: true })));

    /** Connects `run` with `open`. The run is ready once the server has listed its tools within the timeout; otherwise it has failed or needs authorization. */
    const connectOn = <R>(run: number, open: Effect.Effect<McpConnection, McpFailed | RemoteRefused, R>): Effect.Effect<void, never, R> =>
      Effect.gen(function* () {
        const connection = yield* open;
        return { connection, tools: yield* connection.tools };
      }).pipe(
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () => Effect.fail(new McpFailed({ server: server.name, reason: `did not answer initialize and tools/list within ${Duration.format(Duration.fromInputUnsafe(timeout))}` })),
        }),
        Effect.flatMap(({ connection, tools }) =>
          Ref.update(connections, HashMap.set(run, connection)).pipe(Effect.andThen(dispatch({ _tag: "Connected", run, tools }))),
        ),
        Effect.catch((error) => dispatch(verdictOf(server, run, error))),
      );

    const runs: Runs = isRemote(server)
      ? yield* remoteRuns(dispatch, (run, scope) =>
          // A run that ended is stopped too, so nothing of it is left running.
          connectOn(run, remoteConnection(server, roots, options.clientInfo, timeout, (event) => dispatch(event({ run })).pipe(Effect.andThen(stopRun)), scope)),
        )
      : yield* stdioRuns(server, dispatch, (run, handle) => connectOn(run, connect(server.name, handle, roots, options.clientInfo)));
    yield* Ref.set(stopRunRef, runs.stopRun);
    yield* runs.start;

    return {
      name: server.name,
      state: SubscriptionRef.get(state),
      running: runs.running,
      changes: SubscriptionRef.changes(state),
      settled: SubscriptionRef.changes(state).pipe(
        Stream.filter((now) => now._tag !== "Connecting" && !(now._tag === "Stopped" && now.run === 0)),
        Stream.runHead,
        Effect.map((first) => (first._tag === "Some" ? first.value : initialMcpServerState)),
      ),
      call: (tool, args) =>
        Effect.gen(function* () {
          const now = yield* SubscriptionRef.get(state);
          const connection = now._tag === "Ready" ? HashMap.get(yield* Ref.get(connections), now.run) : Option.none();
          if (Option.isNone(connection)) return yield* new McpFailed({ server: server.name, reason: `${tool} was not called: the server is not running (${describe(now)})` });
          return yield* connection.value.call(tool, args);
        }),
      reconnect: runs.restart,
      stop: runs.stop,
    };
  });

/** A stdio server's runs: its process group's runs, each connected over the process's pipes. */
const stdioRuns = (
  server: McpServerStdio,
  dispatch: (event: McpServerEvent) => Effect.Effect<void>,
  onRun: (run: number, handle: Parameters<typeof connect>[1]) => Effect.Effect<void, never, Scope.Scope>,
): Effect.Effect<Runs, never, Scope.Scope | ChildProcessSpawner.ChildProcessSpawner | SessionContext> =>
  Effect.gen(function* () {
    const group = yield* makeProcessGroup({ name: `mcp ${server.name}`, command: server.command, args: server.args, env: server.env, cwd: server.cwd }, onRun);
    yield* group.changes.pipe(
      Stream.runForEach((process) => dispatch(runEventOf(process))),
      Effect.forkScoped,
    );
    return {
      start: group.start,
      restart: group.restart,
      stop: group.stop,
      stopRun: group.stop,
      running: Effect.map(group.state, (process) => process._tag === "Starting" || process._tag === "Running"),
    };
  });

/** A remote server's runs: each a connection made in a scope of its own, which ending the run closes. */
const remoteRuns = (
  dispatch: (event: McpServerEvent) => Effect.Effect<void>,
  onRun: (run: number, scope: Scope.Scope) => Effect.Effect<void>,
): Effect.Effect<Runs, never, Scope.Scope> =>
  Effect.gen(function* () {
    const parent = yield* Scope.Scope;
    const lock = yield* Semaphore.make(1);
    // The latest run number, and the scope of the live run, if there is one.
    const latest = yield* Ref.make<{ readonly run: number; readonly live: Scope.Closeable | undefined }>({ run: 0, live: undefined });
    const start = lock.withPermit(
      Effect.gen(function* () {
        const { run: last, live } = yield* Ref.get(latest);
        if (live !== undefined) return;
        const run = last + 1;
        const scope = yield* Scope.fork(parent);
        yield* Ref.set(latest, { run, live: scope });
        yield* dispatch({ _tag: "RunStarted", run });
        yield* Effect.forkIn(onRun(run, scope), scope);
      }),
    );
    const stop = lock.withPermit(
      Effect.gen(function* () {
        const { run, live } = yield* Ref.get(latest);
        if (live === undefined) return;
        yield* Ref.set(latest, { run, live: undefined });
        yield* Scope.close(live, Exit.void);
        yield* dispatch({ _tag: "RunStopped", run });
      }),
    );
    return {
      start,
      restart: Effect.andThen(stop, start),
      stop,
      // The machine asks for the stop from within the run, and stopping closes the run's scope, so the stop runs outside it.
      stopRun: Effect.asVoid(Effect.forkIn(stop, parent)),
      running: Effect.map(Ref.get(latest), ({ live }) => live !== undefined),
    };
  });

/**
 * The connection of one run of a remote server, in `runScope`. It is made anew when the server no
 * longer has the session (the refused request is then made again once), and when its stream ends
 * between requests. When a new connection cannot be made, `ended` receives the event for the run.
 */
const remoteConnection = (
  server: McpServerRemote,
  roots: ReadonlyArray<Root>,
  clientInfo: ClientInfo | undefined,
  timeout: Duration.Input,
  ended: (event: (at: { readonly run: number }) => McpServerEvent) => Effect.Effect<void>,
  runScope: Scope.Scope,
): Effect.Effect<McpConnection, McpFailed | RemoteRefused> =>
  Effect.gen(function* () {
    /** A connection in a scope of its own, within the run's. */
    const open = Effect.gen(function* () {
      const scope = yield* Scope.fork(runScope);
      return yield* connectRemote(server, roots, clientInfo).pipe(
        Effect.map((connection) => ({ connection, scope })),
        Scope.provide(scope),
        Effect.onError(() => Scope.close(scope, Exit.void)),
      );
    });
    const first = yield* open;
    const current = yield* Ref.make(first);
    const lock = yield* Semaphore.make(1);

    /** Makes a new connection in place of `lost`, unless one was made already. A run that cannot make one has ended. */
    const renew = (lost: typeof first) =>
      lock.withPermit(
        Effect.gen(function* () {
          const now = yield* Ref.get(current);
          if (now !== lost) return now;
          yield* Scope.close(lost.scope, Exit.void);
          return yield* open.pipe(
            Effect.timeoutOrElse({
              duration: timeout,
              orElse: () => Effect.fail(new McpFailed({ server: server.name, reason: `did not answer initialize within ${Duration.format(Duration.fromInputUnsafe(timeout))}` })),
            }),
            Effect.tap((made) => Ref.set(current, made)),
            // Credentials refused or asked for: the run needs authorization or has failed. Any other failure ends the run.
            Effect.tapError((error) =>
              ended(({ run }) => {
                const verdict = verdictOf(server, run, error);
                const status = (error._tag === "RemoteRefused" ? error.rejection : rejectionOf(error))?.status;
                return status === 401 || status === 403 ? verdict : { _tag: "RunEnded", run, reason: `its session ended, and a new one could not be made: ${verdict.reason}` };
              }),
            ),
          );
        }),
      );

    /**
     * Waits for the current connection to close. A connection whose stream ends between requests is
     * made anew; a connection replaced by a new one is not. Returns whether to wait again: false once
     * a new connection could not be made.
     */
    const watch = Effect.gen(function* () {
      const watched = yield* Ref.get(current);
      yield* watched.connection.closed;
      if ((yield* Ref.get(current)) !== watched) return true;
      yield* Effect.logWarning(logKeys.server.connectionLost, { server: server.name, url: whereOf(server.url) });
      return (yield* Effect.result(renew(watched)))._tag === "Success";
    });
    yield* watch.pipe(Effect.repeat({ while: (again) => again }), Effect.forkIn(runScope));

    /** Whether HTTP refused a request because of its credentials. */
    const credentialsRefused = (error: McpFailed) => {
      const status = rejectionOf(error)?.status;
      return status === 401 || status === 403;
    };

    const call: McpConnection["call"] = (tool, args) =>
      Effect.gen(function* () {
        // A connection that is being made anew is waited for.
        const used = yield* lock.withPermit(Ref.get(current));
        return yield* used.connection.call(tool, args).pipe(
          // Credentials refused mid-session (a revoked key): the run has failed or needs authorization, and the call fails.
          Effect.tapError((error) => (credentialsRefused(error) ? ended(({ run }) => refusalOf(server, run, rejectionOf(error)!)) : Effect.void)),
          Effect.catchIf(
            (error) => rejectionOf(error)?.sessionExpired === true,
            () =>
              Effect.logWarning(logKeys.server.sessionRenewed, { server: server.name, url: whereOf(server.url), tool }).pipe(
                Effect.andThen(renew(used)),
                Effect.mapError((failed) => (failed._tag === "McpFailed" ? failed : new McpFailed({ server: server.name, reason: failed.rejection.text, cause: failed }))),
                Effect.flatMap((made) => made.connection.call(tool, args)),
              ),
          ),
        );
      });

    return {
      initialized: first.connection.initialized,
      tools: Effect.flatMap(Ref.get(current), (made) => made.connection.tools),
      call,
      // The run ends through `ended`, not when one connection closes.
      closed: Effect.never,
    };
  });
