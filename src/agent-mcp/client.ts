/**
 * An MCP client: one connection to one MCP server, built on `peer.ts` and on MCP's messages as
 * Effect declares them (`effect/ai` `McpSchema`).
 *
 * - `connectOver` connects over any wire; `connect` over a running process's pipes (newline-delimited
 *   JSON-RPC, MCP's stdio transport); `connectStdio` starts a process and connects to it, and only
 *   tests and probes use it. Each sends `initialize` (this client's latest version, its roots capability), then
 *   `notifications/initialized`, and returns the connection.
 * - The client answers the server's `ping` and `roots/list` (with the roots it was given). It does
 *   not offer sampling or elicitation.
 * - It logs what the server logs (`notifications/message`), the progress it reports, a change of its
 *   tool list, and every line it writes to stderr.
 * - A tool's result is kept as the server sent it (`ToolResult`). Everything else is decoded with
 *   `McpSchema`'s schemas: a field they do not have is dropped, and a tool's missing annotations take
 *   the defaults that MCP states (`destructiveHint: true`, and so on).
 */

import { defaultBrand } from "../agent-host/brand.ts";
import { Data, Effect, Queue, Schema, type Scope, type Sink, Stream } from "effect";
import { McpSchema } from "effect/ai";
import { type Wire, WireError, WireInput } from "effective-acp/json-rpc";
import * as Methods from "effective-acp/methods";
import { ChildProcess, type ChildProcessSpawner } from "effect/process";
import { SessionContext } from "../agent-environment/session-context.ts";
import { logKeys } from "./log-keys.ts";
import * as Peer from "./peer.ts";

/** The protocol version this client offers. */
export const protocolVersion = "2025-11-25";

/** A server started as a process: its name (which its tools are offered under), the command, its arguments and its environment. */
export interface McpServerStdio {
  readonly name: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  /** The working directory. When undefined, the server uses this process's working directory. */
  readonly cwd?: string | undefined;
}

/** A root that the client reports to the server (`roots/list`): a `file://` URI, and a name. */
export interface Root {
  readonly uri: string;
  readonly name?: string | undefined;
}

/** The connection could not be made, or a request to the server failed: the reason, and the server's or the transport's error as the cause. */
export class McpFailed extends Data.TaggedError("McpFailed")<{
  readonly server: string;
  readonly reason: string;
  readonly cause?: unknown;
}> {
  override get message(): string {
    return `${this.server}: ${this.reason}`;
  }
}

export interface McpConnection {
  /** What the server answered to `initialize`: its version, capabilities, information and instructions. */
  readonly initialized: McpSchema.InitializeResult;
  /** The server's tools, every page of them. */
  readonly tools: Effect.Effect<ReadonlyArray<McpSchema.Tool>, McpFailed>;
  /** Calls a tool and returns its result as the server sent it. A tool's own failure is a result with `isError: true`; `McpFailed` is a failure of the request. */
  readonly call: (name: string, args: Readonly<Record<string, unknown>>) => Effect.Effect<ToolResult, McpFailed>;
  /** Completes when the connection ends: the server's output closed, or the scope closed. */
  readonly closed: Effect.Effect<void>;
}

const request = <Name extends string, P extends Schema.Top, R extends Schema.Top>(rpc: { readonly _tag: Name; readonly payloadSchema: P; readonly successSchema: R }) =>
  Methods.request(rpc._tag, rpc.payloadSchema, rpc.successSchema);
const notification = <Name extends string, P extends Schema.Top>(rpc: { readonly _tag: Name; readonly payloadSchema: P }) =>
  Methods.notification(rpc._tag, rpc.payloadSchema);

/**
 * A tool's result as the server sent it: a JSON object (`content`, and `structuredContent`,
 * `isError` and whatever else it has), kept whole, so that it can be recorded as received.
 */
export const ToolResult = Schema.Record(Schema.String, Schema.Json);
export type ToolResult = typeof ToolResult.Type;

/** The requests that this client makes of a server. */
const calls = Methods.make(
  request(McpSchema.Initialize),
  request(McpSchema.Ping),
  request(McpSchema.ListTools),
  Methods.request(McpSchema.CallTool._tag, McpSchema.CallTool.payloadSchema, ToolResult),
);
/** The notifications that this client sends a server. */
const tells = Methods.make(notification(McpSchema.InitializedNotification));
/** The requests and notifications that this client handles. */
const serves = Methods.make(
  request(McpSchema.Ping),
  request(McpSchema.ListRoots),
  notification(McpSchema.ToolListChangedNotification),
  notification(McpSchema.LoggingMessageNotification),
  notification(McpSchema.ProgressNotification),
);

/** The wire over a child's stdout and stdin: one JSON-RPC message per line. A line that is not JSON arrives as `Unparsable`. */
const wireOf = (stdout: Stream.Stream<Uint8Array, unknown>, stdin: Queue.Queue<Uint8Array>): Wire => {
  const encoder = new TextEncoder();
  return {
    read: stdout.pipe(
      Stream.mapError((cause) => new WireError({ reason: "the server's output could not be read", cause })),
      Stream.decodeText,
      Stream.splitLines,
      Stream.filter((line) => line.trim() !== ""),
      Stream.map((line) => {
        try {
          return WireInput.Json({ value: JSON.parse(line) });
        } catch {
          return WireInput.Unparsable({ text: line });
        }
      }),
    ),
    write: (message) => Queue.offer(stdin, encoder.encode(`${JSON.stringify(message)}\n`)).pipe(Effect.asVoid),
  };
};

/** A running server's stdin, stdout and stderr: a run's handle (`agent-process`), or a child process's. */
export interface ServerPipes {
  readonly stdin: Sink.Sink<void, Uint8Array, never, unknown>;
  readonly stdout: Stream.Stream<Uint8Array, unknown>;
  readonly stderr: Stream.Stream<Uint8Array, unknown>;
}

/**
 * Starts `server` as a process and connects to it, in the current scope; the process ends with the
 * scope. The process receives the session's environment (`SessionContext.environment`) with the
 * server's own `env` set over it. `roots` are returned to the server when it asks (`roots/list`).
 * Only tests and probes use it: a session starts its servers through `server.ts`.
 */
export const connectStdio = (
  server: McpServerStdio,
  roots: ReadonlyArray<Root>,
  clientInfo: ClientInfo = defaultClientInfo,
): Effect.Effect<McpConnection, McpFailed, Scope.Scope | ChildProcessSpawner.ChildProcessSpawner | SessionContext> =>
  Effect.gen(function* () {
    const { environment } = yield* SessionContext;
    const handle = yield* ChildProcess.make(server.command, [...server.args], {
      env: { ...environment.variables, ...server.env },
      extendEnv: false,
      ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
    }).pipe(Effect.mapError((cause) => new McpFailed({ server: server.name, reason: `${server.command} could not be started`, cause })));
    return yield* connect(server.name, handle, roots, clientInfo);
  });

/** The name and version that a client gives a server (`clientInfo`): its host's brand. */
export interface ClientInfo {
  readonly name: string;
  readonly version: string;
}

/** The `clientInfo` used when the host gives none: the default brand. */
export const defaultClientInfo: ClientInfo = { name: defaultBrand.name, version: defaultBrand.version };

/**
 * Connects to the server named `name` over `pipes`, in the current scope: `initialize`, with
 * `clientInfo`, then `notifications/initialized`. `roots` are returned to the server when it asks
 * (`roots/list`).
 */
export const connect = (name: string, pipes: ServerPipes, roots: ReadonlyArray<Root>, clientInfo: ClientInfo = defaultClientInfo): Effect.Effect<McpConnection, McpFailed, Scope.Scope> =>
  Effect.gen(function* () {
    const stdin = yield* Queue.unbounded<Uint8Array>();
    yield* Stream.fromQueue(stdin).pipe(
      Stream.run(pipes.stdin),
      Effect.catch((cause) => Effect.logWarning(logKeys.server.stdinClosed, { server: name, cause: String(cause) })),
      Effect.forkScoped,
    );
    yield* pipes.stderr.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.runForEach((line) => Effect.logInfo(logKeys.server.stderr, { server: name, line })),
      Effect.ignore,
      Effect.forkScoped,
    );
    return yield* connectOver(name, wireOf(pipes.stdout, stdin), roots, clientInfo);
  });

/**
 * Connects to the server named `name` over `wire`, whatever transport carries it, in the current
 * scope: `initialize`, with `clientInfo`, then `notifications/initialized`. `initialized` receives
 * the server's answer to `initialize` before anything more is sent, so a transport that sends the
 * agreed version with every request learns it there.
 */
export const connectOver = (
  name: string,
  wire: Wire,
  roots: ReadonlyArray<Root>,
  clientInfo: ClientInfo = defaultClientInfo,
  initialized: (result: McpSchema.InitializeResult) => Effect.Effect<void> = () => Effect.void,
): Effect.Effect<McpConnection, McpFailed, Scope.Scope> =>
  Effect.gen(function* () {
    const server = { name };
    const failed = (reason: string) => (cause: unknown) => new McpFailed({ server: name, reason, cause });
    const peer = yield* Peer.make({
      wire,
      serve: serves,
      call: calls,
      notify: tells,
      handlers: () =>
        Effect.succeed<Methods.Handlers<Methods.Of<typeof serves>, never>>({
          ping: () => Effect.succeed({}),
          "roots/list": () =>
            Effect.succeed(
              new McpSchema.ListRootsResult({
                roots: roots.map((root) => new McpSchema.Root({ uri: root.uri, ...(root.name === undefined ? {} : { name: root.name }) })),
              }),
            ),
          "notifications/tools/list_changed": () => Effect.logInfo(logKeys.server.toolsChanged, { server: server.name }),
          "notifications/message": (params) => Effect.logInfo(logKeys.server.logged, { server: server.name, level: params.level, logger: params.logger, data: params.data }),
          "notifications/progress": (params) => Effect.logInfo(logKeys.server.progress, { server: server.name, ...params }),
        }),
    });
    const answered = yield* peer.client
      .initialize({ protocolVersion, capabilities: { roots: { listChanged: false } }, clientInfo: { name: clientInfo.name, version: clientInfo.version } })
      .pipe(Effect.mapError(failed("initialize failed")));
    yield* Effect.logInfo(logKeys.server.initialized, {
      server: server.name,
      offered: protocolVersion,
      answered: answered.protocolVersion,
      serverInfo: answered.serverInfo,
    });
    yield* initialized(answered);
    yield* peer.notify("notifications/initialized", undefined);

    /** Returns the tools of the page at `cursor` and of every page after it, following `nextCursor`. */
    const toolsFrom = (cursor: string | undefined): McpConnection["tools"] =>
      peer.client["tools/list"](cursor === undefined ? undefined : { cursor }).pipe(
        Effect.mapError(failed("tools/list failed")),
        Effect.flatMap((page) =>
          page.nextCursor === undefined ? Effect.succeed(page.tools) : Effect.map(toolsFrom(page.nextCursor), (rest) => [...page.tools, ...rest]),
        ),
      );
    const tools = toolsFrom(undefined);
    const call: McpConnection["call"] = (name, args) =>
      peer.client["tools/call"]({ name, arguments: args }).pipe(Effect.mapError(failed(`tools/call ${name} failed`)));
    return { initialized: answered, tools, call, closed: peer.closed };
  });
