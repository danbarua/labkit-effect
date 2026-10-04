/**
 * One MCP server a session keeps, over its runs, with the machine in `server-machine.ts` saying where
 * it is. Started in the scope it is given (a session's), it ends with it. `reconnect` ends the run
 * there is and starts another; `stop` ends it.
 *
 * - A stdio server's run is its process (`agent-process`): connected over the process's pipes
 *   (`client.ts` `connect`); it ends when the process does.
 * - A remote server's run is a connection to its URL (`http.ts`). When the server no longer has the
 *   session (a 404 to a request that carried it), a new session is made, and the request it refused
 *   is made again, once; a connection whose stream ends between requests (HTTP+SSE) is made anew.
 *   The run ends when a new one cannot be made. A server that asks for credentials when none are
 *   given in its headers, or for OAuth, needs authorization (`NeedsAuth`); one that refuses the
 *   credentials given has failed.
 *
 * A run that does not answer `initialize` and list its tools within `connectTimeout` has failed, and
 * is stopped, so nothing is left behind. A call is made on the run that is ready; while none is, it
 * fails with what is known of the server. Every change of state is logged.
 */

import { Duration, Effect, Exit, Scope, Semaphore, Stream, SubscriptionRef } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import type { ProcessState } from "../agent-process/machine.ts";
import { isCredential } from "../agent-process/environment.ts";
import { makeProcessGroup } from "../agent-process/process-group.ts";
import { type ClientInfo, connect, McpFailed, type McpConnection, type McpServerStdio, type Root, type ToolResult } from "./client.ts";
import { connectRemote, type HttpRejection, type McpServerRemote, rejectionOf, type RemoteRefused, whereOf } from "./http.ts";
import { logKeys } from "./log-keys.ts";
import { describe, initialMcpServerState, type McpServerEvent, type McpServerState, stepMcpServer } from "./server-machine.ts";

/** How long a server has to answer `initialize` and list its tools once its run starts, unless a host says otherwise. */
export const defaultConnectTimeout: Duration.Input = "30 seconds";

/** A server a session keeps: one run as a process, or one reached at a URL. */
export type McpServerConfig = McpServerStdio | McpServerRemote;

export const isRemote = (server: McpServerConfig): server is McpServerRemote => "url" in server;

export interface McpServer {
  readonly name: string;
  readonly state: Effect.Effect<McpServerState>;
  /** Whether a run is live: a process, or a connection. */
  readonly running: Effect.Effect<boolean>;
  /** The state now, then each change of it. */
  readonly changes: Stream.Stream<McpServerState>;
  /** The state once the server is no longer connecting: ready, failed, needing authorization, exited or stopped. */
  readonly settled: Effect.Effect<McpServerState>;
  /** Calls a tool of the run that is ready, giving its result as the server sent it. */
  readonly call: (tool: string, args: Readonly<Record<string, unknown>>) => Effect.Effect<ToolResult, McpFailed>;
  /** Ends the server's run, if there is one, and starts another. */
  readonly reconnect: Effect.Effect<void>;
  readonly stop: Effect.Effect<void>;
}

const endedOf = (process: Extract<ProcessState, { _tag: "Exited" }>): string =>
  process.code !== undefined ? `its process exited with code ${process.code}` : process.signal !== undefined ? `its process ended on ${process.signal}` : "its process ended";

/** A process group's state as the event it is to its server's machine: a run is a process. */
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

/** Whether `server` is given credentials: an `Authorization` header, or one named for a credential (`X-API-Key`). */
const givesCredentials = (server: McpServerRemote): boolean => Object.keys(server.headers).some((name) => /^(?:proxy-)?authorization$/i.test(name) || isCredential(name));

/**
 * What a run of `server` that HTTP refused comes to: needing authorization when the server asks for
 * credentials and none are given, or for OAuth; failed when it refuses the credentials given, or
 * anything else.
 */
type Verdict = Extract<McpServerEvent, { readonly _tag: "ConnectFailed" | "AuthNeeded" }>;

export const refusalOf = (server: McpServerRemote, run: number, rejection: HttpRejection): Verdict => {
  const status = rejection.status === 0 ? rejection.said : `HTTP ${rejection.status}${rejection.said === "" ? "" : `: ${rejection.said}`}`;
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

/** What a run that did not connect comes to: needing authorization, or failed. */
const verdictOf = (server: McpServerConfig, run: number, error: McpFailed | RemoteRefused): Verdict => {
  const rejection = error._tag === "RemoteRefused" ? error.rejection : rejectionOf(error);
  if (isRemote(server) && rejection !== undefined) return refusalOf(server, run, rejection);
  return { _tag: "ConnectFailed", run, reason: error._tag === "RemoteRefused" ? error.rejection.said : error.reason };
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

/** Starts `server` in the scope given, and connects to it; `roots` are what it is told when it asks. */
export const startMcpServer = (
  server: McpServerConfig,
  roots: ReadonlyArray<Root>,
  options: { readonly connectTimeout?: Duration.Input | undefined; readonly clientInfo?: ClientInfo | undefined } = {},
): Effect.Effect<McpServer, never, Scope.Scope | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const timeout = options.connectTimeout ?? defaultConnectTimeout;
    const state = yield* SubscriptionRef.make<McpServerState>(initialMcpServerState);
    const lock = yield* Semaphore.make(1);
    const connections = new Map<number, McpConnection>();
    let stopRun: Effect.Effect<void> = Effect.void;

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
        .pipe(Effect.flatMap((effects) => Effect.forEach(effects, () => stopRun, { discard: true })));

    /** The connection `open` makes on `run`, ready once it has listed its tools within the time given; else failed, or needing authorization. */
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
          Effect.gen(function* () {
            connections.set(run, connection);
            yield* dispatch({ _tag: "Connected", run, tools });
          }),
        ),
        Effect.catch((error) => dispatch(verdictOf(server, run, error))),
      );

    const runs: Runs = isRemote(server)
      ? yield* remoteRuns(dispatch, (run, scope) =>
          // A run that ended is stopped too: nothing is left of it.
          connectOn(run, remoteConnection(server, roots, options.clientInfo, timeout, (event) => dispatch(event({ run })).pipe(Effect.andThen(Effect.suspend(() => stopRun))), scope)),
        )
      : yield* stdioRuns(server, dispatch, (run, handle) => connectOn(run, connect(server.name, handle, roots, options.clientInfo)));
    stopRun = runs.stopRun;
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
          const connection = now._tag === "Ready" ? connections.get(now.run) : undefined;
          if (connection === undefined) return yield* new McpFailed({ server: server.name, reason: `${tool} was not called: the server is not running (${describe(now)})` });
          return yield* connection.call(tool, args);
        }),
      reconnect: runs.restart,
      stop: runs.stop,
    };
  });

/** A stdio server's runs: its process group's, each connected over the process's pipes. */
const stdioRuns = (
  server: McpServerStdio,
  dispatch: (event: McpServerEvent) => Effect.Effect<void>,
  onRun: (run: number, handle: Parameters<typeof connect>[1]) => Effect.Effect<void, never, Scope.Scope>,
): Effect.Effect<Runs, never, Scope.Scope | ChildProcessSpawner.ChildProcessSpawner> =>
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
    let run = 0;
    let current: Scope.Closeable | undefined;
    const start = lock.withPermit(
      Effect.gen(function* () {
        if (current !== undefined) return;
        run += 1;
        const scope = yield* Scope.fork(parent);
        current = scope;
        yield* dispatch({ _tag: "RunStarted", run });
        yield* Effect.forkIn(onRun(run, scope), scope);
      }),
    );
    const stop = lock.withPermit(
      Effect.gen(function* () {
        if (current === undefined) return;
        const scope = current;
        current = undefined;
        yield* Scope.close(scope, Exit.void);
        yield* dispatch({ _tag: "RunStopped", run });
      }),
    );
    return {
      start,
      restart: Effect.andThen(stop, start),
      stop,
      // The machine asks from within the run, whose scope stopping it closes: it is stopped from outside it.
      stopRun: Effect.asVoid(Effect.forkIn(stop, parent)),
      running: Effect.sync(() => current !== undefined),
    };
  });

/**
 * The connection of one run of a remote server, in `runScope`: made anew when the server no longer
 * has the session (the request it refused made again once) and when its stream ends between
 * requests. When a new one cannot be made, `ended` says what the run comes to.
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
    let current = yield* open;
    const lock = yield* Semaphore.make(1);

    /** A new connection in place of `lost`, unless one was made already; a run that cannot make one has ended. */
    const renew = (lost: typeof current) =>
      lock.withPermit(
        Effect.gen(function* () {
          if (current !== lost) return current;
          yield* Scope.close(lost.scope, Exit.void);
          return yield* open.pipe(
            Effect.timeoutOrElse({
              duration: timeout,
              orElse: () => Effect.fail(new McpFailed({ server: server.name, reason: `did not answer initialize within ${Duration.format(Duration.fromInputUnsafe(timeout))}` })),
            }),
            Effect.tap((made) =>
              Effect.sync(() => {
                current = made;
              }),
            ),
            // Credentials refused, or asked for: the run needs authorization or has failed. Anything else ends it.
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

    // A connection whose stream ends between requests is made anew; one closed in its place is not.
    yield* Effect.gen(function* () {
      while (true) {
        const watched = current;
        yield* watched.connection.closed;
        if (current !== watched) continue;
        yield* Effect.logWarning(logKeys.server.connectionLost, { server: server.name, url: whereOf(server.url) });
        if ((yield* Effect.result(renew(watched)))._tag === "Failure") return;
      }
    }).pipe(Effect.forkIn(runScope));

    /** Whether HTTP refused a request for its credentials. */
    const credentialsRefused = (error: McpFailed) => {
      const status = rejectionOf(error)?.status;
      return status === 401 || status === 403;
    };

    const call: McpConnection["call"] = (tool, args) =>
      Effect.gen(function* () {
        // A connection being made anew is waited for.
        const used = yield* lock.withPermit(Effect.sync(() => current));
        return yield* used.connection.call(tool, args).pipe(
          // Credentials refused mid-session (a key revoked): the run has failed or needs authorization, and the call fails.
          Effect.tapError((error) => (credentialsRefused(error) ? ended(({ run }) => refusalOf(server, run, rejectionOf(error)!)) : Effect.void)),
          Effect.catchIf(
            (error) => rejectionOf(error)?.sessionExpired === true,
            () =>
              Effect.logWarning(logKeys.server.sessionRenewed, { server: server.name, url: whereOf(server.url), tool }).pipe(
                Effect.andThen(renew(used)),
                Effect.mapError((failed) => (failed._tag === "McpFailed" ? failed : new McpFailed({ server: server.name, reason: failed.rejection.said, cause: failed }))),
                Effect.flatMap((made) => made.connection.call(tool, args)),
              ),
          ),
        );
      });

    return {
      initialized: current.connection.initialized,
      tools: Effect.suspend(() => current.connection.tools),
      call,
      // The run ends by `ended`, not by one connection closing.
      closed: Effect.never,
    };
  });
