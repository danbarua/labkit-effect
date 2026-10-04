/**
 * The MCP servers one session keeps: each started (`server.ts`: as a process, or at its URL), all at
 * once, in the scope given (the session's), and ended with it.
 *
 * Once every server has settled (ready, or failed: a server has `connectTimeout` to connect), the
 * tools of those that are ready are tool sources (`source.ts`), offered after the host's own: the
 * session's tools are fixed when it opens, so a server that becomes ready later, reconnected, offers
 * none it did not offer then. The notices (`notices`) tell the model when a server is not running,
 * and when it runs again, once each; a server that is ready when the session starts is not
 * mentioned. `changes` is each change of a server's state, as the session records it
 * (`McpServerChanged`).
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

/** A server a host was given, and how long it has to connect when not the host's default. */
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
  /** What tells the model when a server is not running, and when it runs again. */
  readonly notices: NoticeProvider;
  /** Each server's state as the session records it: the state now (a server still connecting is not), then each change. */
  readonly changes: Stream.Stream<Change>;
  /** Starts the server named again and connects to it anew; its state once settled, or `undefined` when no server has the name. */
  readonly reconnect: (name: string) => Effect.Effect<McpServerState | undefined>;
}

/** A state as the session records it; a server still connecting is not recorded. */
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

/** Whether a server in `state` is running, as the model is told; one still connecting is as it was told before (`before`). */
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

/** Starts the servers given, in the scope given; `roots` are what each is told when it asks. */
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
      const { source, left } = mcpToolSource(server, state.tools);
      return [{ source, left, server: server.name }];
    });
    yield* Effect.forEach(
      sources.flatMap(({ server, left }) => left.map(({ tool, reason }) => ({ server, tool, reason }))),
      (each) => Effect.logWarning(logKeys.server.toolLeftOut, each),
      { discard: true },
    );
    const offered = (server: McpServer) => (state: Extract<McpServerState, { _tag: "Ready" }>) =>
      mcpToolSource(server, state.tools).source.tools.map((tool) => `${namespaceOf(server.name)}__${tool.name}`);

    const states: McpServers["states"] = Effect.forEach(started, (server) => Effect.map(server.state, (state) => ({ name: server.name, state })));

    // What the model was last told of each server: a server ready when the session starts is taken as told so.
    const told = yield* Ref.make<ReadonlyMap<string, Running>>(
      new Map(settled.flatMap(({ server, state }) => (state._tag === "Ready" ? [[server.name, "running"] as const] : []))),
    );
    const notices: NoticeProvider = {
      notices: Effect.gen(function* () {
        const now = yield* states;
        const before = yield* Ref.get(told);
        const said = now.flatMap(({ name, state }): ReadonlyArray<readonly [string, Running, string]> => {
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
        yield* Ref.set(told, new Map([...before, ...said.map(([name, running]) => [name, running] as const)]));
        return said.map(([, , text]) => text);
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
