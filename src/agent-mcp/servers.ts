/**
 * The MCP servers that one session keeps. All start at once (`server.ts`: as processes, or at their
 * URLs), in the current scope (the session's), and end with it.
 * - Once every server has settled (ready, or failed: each has `connectTimeout` to connect), the ready
 *   servers' tools become tool sources (`source.ts`), offered after the host's own. The session's
 *   tools are fixed when it opens, so a server that becomes ready later offers no tools in it.
 * - `notices` tells the model once when a server is not running, and once when it runs again. A
 *   server that is ready when the session starts is not mentioned.
 * - `changes` is each change of a server's state, as the session records it (`McpServerChanged`).
 */

import { Effect, Ref, Stream } from "effect";
import type { Duration, Scope } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import type { NoticeProvider } from "../agent-context/assemble.ts";
import { FailureText, McpServerName, ToolName } from "../agent-machine/names.ts";
import type { Observation } from "../agent-machine/observation.ts";
import type { ToolSource } from "../agent-session/tool-sources.ts";
import type { ClientInfo, Root } from "./client.ts";
import { logKeys } from "./log-keys.ts";
import { describe, type McpServerState } from "./server-machine.ts";
import { type McpServer, type McpServerConfig, startMcpServer } from "./server.ts";
import { mcpToolSource, namespaceOf } from "./source.ts";

/** A server that a host was given, and its connect timeout when it differs from the host's default. */
export interface GivenServer {
  readonly server: McpServerConfig;
  readonly connectTimeout?: Duration.Input | undefined;
}

type Change = Extract<Observation, { _tag: "McpServerChanged" }>;

export interface McpServers {
  /** Each server's name, as given, in order. */
  readonly names: ReadonlyArray<string>;
  /** Each server's state now. */
  readonly states: Effect.Effect<ReadonlyArray<{ readonly name: string; readonly state: McpServerState }>>;
  /** The tool sources of the servers that were ready once all settled, in order. */
  readonly sources: ReadonlyArray<ToolSource>;
  /** The notice provider that tells the model when a server is not running, and when it runs again. */
  readonly notices: NoticeProvider;
  /** Each server's state as the session records it: the current state, then each change. A server that is connecting is not recorded. */
  readonly changes: Stream.Stream<Change>;
  /** Starts the named server again, connects to it, and returns its state once settled; `undefined` when no server has the name. */
  readonly reconnect: (name: string) => Effect.Effect<McpServerState | undefined>;
}

/** Returns `state` as the session records it, or undefined for a server that is connecting. */
const recorded = (name: string, state: McpServerState, offered: (state: Extract<McpServerState, { _tag: "Ready" }>) => ReadonlyArray<string>): Change | undefined => {
  const server = McpServerName.make(name);
  switch (state._tag) {
    case "Connecting":
      return undefined;
    case "Ready":
      return { _tag: "McpServerChanged", server, state: { _tag: "Ready", tools: offered(state).map((tool) => ToolName.make(tool)) } };
    case "Failed":
    case "NeedsAuth":
    case "Exited":
      return { _tag: "McpServerChanged", server, state: { _tag: state._tag, reason: FailureText.make(state.reason) } };
    case "Stopped":
      return { _tag: "McpServerChanged", server, state: { _tag: "Stopped" } };
    default:
      return state satisfies never;
  }
};

type Running = "running" | "not running";

/** Returns whether a server in `state` is running, as the model is told. A server that is connecting keeps the status the model was last told (`before`). */
const runningOf = (state: McpServerState, before: Running | undefined): Running | undefined => {
  switch (state._tag) {
    case "Ready":
      return "running";
    case "Connecting":
      return before;
    case "Stopped":
    case "Failed":
    case "NeedsAuth":
    case "Exited":
      return "not running";
    default:
      return state satisfies never;
  }
};

/** Starts the given servers in the current scope. `roots` are returned to each server when it asks. */
export const startMcpServers = (
  given: ReadonlyArray<GivenServer>,
  roots: ReadonlyArray<Root>,
  options: { readonly connectTimeout?: Duration.Input | undefined; readonly clientInfo?: ClientInfo | undefined } = {},
): Effect.Effect<McpServers, never, Scope.Scope | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const started = yield* Effect.forEach(
      given,
      (each) => startMcpServer(each.server, roots, { connectTimeout: each.connectTimeout ?? options.connectTimeout, clientInfo: options.clientInfo }),
      { concurrency: "unbounded" },
    );
    const settled = yield* Effect.forEach(started, (server) => Effect.map(server.settled, (state) => ({ server, state })), { concurrency: "unbounded" });

    const sources = settled.flatMap(({ server, state }) => {
      if (state._tag !== "Ready") return [];
      const { source, omitted } = mcpToolSource(server, state.tools);
      return [{ source, omitted, server: server.name }];
    });
    yield* Effect.forEach(
      sources.flatMap(({ server, omitted }) => omitted.map(({ tool, reason }) => ({ server, tool, reason }))),
      (each) => Effect.logWarning(logKeys.server.toolOmitted, each),
      { discard: true },
    );
    const offered = (server: McpServer) => (state: Extract<McpServerState, { _tag: "Ready" }>) =>
      mcpToolSource(server, state.tools).source.tools.map((tool) => `${namespaceOf(server.name)}__${tool.name}`);

    const states: McpServers["states"] = Effect.forEach(started, (server) => Effect.map(server.state, (state) => ({ name: server.name, state })));

    // The status that the model was last told for each server. A server that is ready when the session starts counts as already reported as running.
    const reported = yield* Ref.make<ReadonlyMap<string, Running>>(
      new Map(settled.flatMap(({ server, state }) => (state._tag === "Ready" ? [[server.name, "running"] as const] : []))),
    );
    const notices: NoticeProvider = {
      notices: Effect.gen(function* () {
        const now = yield* states;
        const before = yield* Ref.get(reported);
        const newReports = now.flatMap(({ name, state }): ReadonlyArray<readonly [string, Running, string]> => {
          const running = runningOf(state, before.get(name));
          if (running === undefined || running === before.get(name)) return [];
          return [
            [
              name,
              running,
              running === "running"
                ? `The MCP server ${name} is running again: its tools can be called.`
                : `The MCP server ${name} is not running, so its tools cannot be called: ${describe(state)}.`,
            ],
          ];
        });
        yield* Ref.set(reported, new Map([...before, ...newReports.map(([name, running]) => [name, running] as const)]));
        return newReports.map(([, , text]) => text);
      }),
    };

    const changes = Stream.mergeAll(
      started.map((server) =>
        server.changes.pipe(
          Stream.map((state) => recorded(server.name, state, offered(server))),
          Stream.filter((change): change is Change => change !== undefined),
        ),
      ),
      { concurrency: "unbounded" },
    );

    return {
      names: given.map((each) => each.server.name),
      states,
      sources: sources.map(({ source }) => source),
      notices,
      changes,
      reconnect: (name) =>
        Effect.gen(function* () {
          const server = started.find((each) => each.name === name);
          if (server === undefined) return undefined;
          const before = (yield* server.state).run;
          yield* server.reconnect;
          const after = yield* server.changes.pipe(
            Stream.filter((state) => state.run > before && state._tag !== "Connecting"),
            Stream.runHead,
          );
          return after._tag === "Some" ? after.value : yield* server.state;
        }),
    };
  });
