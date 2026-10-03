/**
 * An MCP client: one connection to one MCP server, over the server's stdio (a child process),
 * newline-delimited JSON-RPC, as MCP's stdio transport says. Built on `peer.ts` and MCP's messages
 * as Effect declares them (`effect/ai` `McpSchema`).
 *
 * `connectStdio` starts the server, and in the scope it is given: it offers `initialize` (this
 * client's latest version, its roots), sends `notifications/initialized`, and gives the connection.
 * The server's process ends with the scope. The client serves the server's `ping` and `roots/list`
 * (the roots it was given); it does not offer sampling or elicitation. What the server logs
 * (`notifications/message`), the progress it reports, a change of its tool list and every line it
 * writes to stderr are logged.
 *
 * Results are decoded with `McpSchema`'s schemas: a field they do not have is left out, and a tool's
 * annotations not given take the defaults MCP states (`destructiveHint: true`, and so on).
 */

import { Data, Effect, Queue, Schema, type Scope, Stream } from "effect";
import { McpSchema } from "effect/ai";
import { type Wire, WireError, WireInput } from "effective-acp/json-rpc";
import * as Methods from "effective-acp/methods";
import { ChildProcess, type ChildProcessSpawner } from "effect/process";
import { logKeys } from "./log-keys.ts";
import * as Peer from "./peer.ts";

/** The protocol version this client offers. */
export const protocolVersion = "2025-11-25";

/** A server started as a process: its name (what its tools are offered under), the command, its arguments and environment. */
export interface McpServerStdio {
  readonly name: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  /** The folder it runs in; this process's when left out. */
  readonly cwd?: string | undefined;
}

/** A root the server is told of (`roots/list`): a `file://` URI, and a name. */
export interface Root {
  readonly uri: string;
  readonly name?: string | undefined;
}

/** The connection could not be made, or a request to the server failed: why, and what the server or the transport said. */
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
  /** Calls a tool. A tool's own failure is a result with `isError`; `McpFailed` is the request's. */
  readonly call: (name: string, args: Readonly<Record<string, unknown>>) => Effect.Effect<McpSchema.CallToolResult, McpFailed>;
  /** Completes when the connection ends: the server's output closed, or the scope closed. */
  readonly closed: Effect.Effect<void>;
}

const request = <Name extends string, P extends Schema.Top, R extends Schema.Top>(rpc: { readonly _tag: Name; readonly payloadSchema: P; readonly successSchema: R }) =>
  Methods.request(rpc._tag, rpc.payloadSchema, rpc.successSchema);
const notification = <Name extends string, P extends Schema.Top>(rpc: { readonly _tag: Name; readonly payloadSchema: P }) =>
  Methods.notification(rpc._tag, rpc.payloadSchema);

/** What this client asks of a server. */
const calls = Methods.make(request(McpSchema.Initialize), request(McpSchema.Ping), request(McpSchema.ListTools), request(McpSchema.CallTool));
/** What this client tells a server. */
const tells = Methods.make(notification(McpSchema.InitializedNotification));
/** What this client serves. */
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

/**
 * Starts `server` and connects to it, in the scope given; its process ends with the scope. `roots`
 * are what it is told when it asks (`roots/list`).
 */
export const connectStdio = (
  server: McpServerStdio,
  roots: ReadonlyArray<Root>,
): Effect.Effect<McpConnection, McpFailed, Scope.Scope | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const failed = (reason: string) => (cause: unknown) => new McpFailed({ server: server.name, reason, cause });
    const handle = yield* ChildProcess.make(server.command, [...server.args], {
      env: { ...process.env, ...server.env },
      ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
    }).pipe(Effect.mapError(failed(`${server.command} could not be started`)));
    const stdin = yield* Queue.unbounded<Uint8Array>();
    yield* Stream.fromQueue(stdin).pipe(
      Stream.run(handle.stdin),
      Effect.catch((cause) => Effect.logWarning(logKeys.server.stdinClosed, { server: server.name, cause: String(cause) })),
      Effect.forkScoped,
    );
    yield* handle.stderr.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.runForEach((line) => Effect.logInfo(logKeys.server.stderr, { server: server.name, line })),
      Effect.ignore,
      Effect.forkScoped,
    );
    const peer = yield* Peer.make({
      wire: wireOf(handle.stdout, stdin),
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
    const initialized = yield* peer.client
      .initialize({ protocolVersion, capabilities: { roots: { listChanged: false } }, clientInfo: { name: "labkit-effect", version: "0.0.0" } })
      .pipe(Effect.mapError(failed("initialize failed")));
    yield* Effect.logInfo(logKeys.server.initialized, {
      server: server.name,
      offered: protocolVersion,
      answered: initialized.protocolVersion,
      serverInfo: initialized.serverInfo,
    });
    yield* peer.notify("notifications/initialized", undefined);

    const tools: McpConnection["tools"] = Effect.gen(function* () {
      const listed: Array<McpSchema.Tool> = [];
      let cursor: string | undefined;
      do {
        const page = yield* peer.client["tools/list"](cursor === undefined ? undefined : { cursor }).pipe(Effect.mapError(failed("tools/list failed")));
        listed.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return listed;
    });
    const call: McpConnection["call"] = (name, args) =>
      peer.client["tools/call"]({ name, arguments: args }).pipe(Effect.mapError(failed(`tools/call ${name} failed`)));
    return { initialized, tools, call, closed: peer.closed };
  });
