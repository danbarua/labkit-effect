/**
 * A pure state machine for one MCP server that a session keeps, over its runs. A run is a process
 * (stdio) or a session with a server at a URL (HTTP, SSE). `stepMcpServer` returns the next state and
 * the effects to perform. Each state names the run it is about, and an event about an earlier run
 * changes nothing. `docs/agent-mcp.md` lists the states.
 */

import type { McpSchema } from "effect/ai";

export type McpServerState =
  | { readonly _tag: "Stopped"; readonly run: number }
  | { readonly _tag: "Connecting"; readonly run: number }
  | { readonly _tag: "Ready"; readonly run: number; readonly tools: ReadonlyArray<McpSchema.Tool> }
  | { readonly _tag: "Failed"; readonly run: number; readonly reason: string }
  /** The server asks for authorization and none is configured, or it asks for OAuth, which this client does not support. */
  | { readonly _tag: "NeedsAuth"; readonly run: number; readonly reason: string }
  | { readonly _tag: "Exited"; readonly run: number; readonly reason: string };

export type McpServerEvent =
  /** A run started: its process is starting, or its connection is being made. */
  | { readonly _tag: "RunStarted"; readonly run: number }
  /** A run could not be started, for `reason`. */
  | { readonly _tag: "RunFailed"; readonly run: number; readonly reason: string }
  /** A run ended, for `reason` (its process ended; or its session ended and a new one could not be made). */
  | { readonly _tag: "RunEnded"; readonly run: number; readonly reason: string }
  /** The run was stopped, and no run is left. */
  | { readonly _tag: "RunStopped"; readonly run: number }
  /** The run's server answered `initialize` and listed its tools. */
  | { readonly _tag: "Connected"; readonly run: number; readonly tools: ReadonlyArray<McpSchema.Tool> }
  /** The run's server did not connect, or refused the credentials given, for `reason`. */
  | { readonly _tag: "ConnectFailed"; readonly run: number; readonly reason: string }
  /** The run's server asks for authorization that this client cannot give, for `reason`. */
  | { readonly _tag: "AuthNeeded"; readonly run: number; readonly reason: string };

/** An effect to perform: stop the run, so that a server that did not connect leaves nothing running. */
export type McpServerEffect = { readonly _tag: "StopRun" };

export interface McpServerStep {
  readonly state: McpServerState;
  readonly effects: ReadonlyArray<McpServerEffect>;
}

export const initialMcpServerState: McpServerState = { _tag: "Stopped", run: 0 };

const stay = (state: McpServerState): McpServerStep => ({ state, effects: [] });

const live = (state: McpServerState): boolean => state._tag === "Connecting" || state._tag === "Ready";

/** Returns the next state and the effects to perform after `event` in `state`. */
export const stepMcpServer = (state: McpServerState, event: McpServerEvent): McpServerStep => {
  if (event.run < state.run) return stay(state);
  switch (event._tag) {
    case "RunStarted":
      return event.run > state.run ? stay({ _tag: "Connecting", run: event.run }) : stay(state);
    case "RunFailed":
      return stay({ _tag: "Failed", run: event.run, reason: event.reason });
    case "RunEnded":
      return live(state) || event.run > state.run ? stay({ _tag: "Exited", run: event.run, reason: event.reason }) : stay(state);
    case "RunStopped":
      return live(state) ? stay({ _tag: "Stopped", run: state.run }) : stay(state);
    case "Connected":
      return state._tag === "Connecting" || state._tag === "Stopped" || event.run > state.run ? stay({ _tag: "Ready", run: event.run, tools: event.tools }) : stay(state);
    // A run that is connecting, or ready and making a new session, can fail or need authorization.
    case "ConnectFailed":
      return live(state) || event.run > state.run ? { state: { _tag: "Failed", run: event.run, reason: event.reason }, effects: [{ _tag: "StopRun" }] } : stay(state);
    case "AuthNeeded":
      return live(state) || event.run > state.run ? { state: { _tag: "NeedsAuth", run: event.run, reason: event.reason }, effects: [{ _tag: "StopRun" }] } : stay(state);
    default:
      return event satisfies never;
  }
};

/** Returns a sentence describing the server in `state`, for notices and the `/mcp` command. */
export const describe = (state: McpServerState): string => {
  switch (state._tag) {
    case "Stopped":
      return "it is stopped";
    case "Connecting":
      return "it is starting";
    case "Ready":
      return `it is running, with ${state.tools.length} tools`;
    case "Failed":
      return `it failed: ${state.reason}`;
    case "NeedsAuth":
      return `it needs authorization: ${state.reason}`;
    case "Exited":
      return `it stopped: ${state.reason}`;
    default:
      return state satisfies never;
  }
};
