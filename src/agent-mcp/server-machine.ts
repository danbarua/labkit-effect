/**
 * The life of one MCP server a session keeps, over the life of its process group
 * (`agent-process`): connecting while its process starts and answers `initialize`, ready with the
 * tools it listed, failed (its process could not start, or did not connect), exited (its process
 * ended), stopped. Each state names the process's run it is about; what arrives about an earlier
 * run changes nothing. Pure: given its state and what happened, it gives the next state and what is
 * to be done.
 */

import type { McpSchema } from "effect/ai";
import type { ProcessState } from "../agent-process/machine.ts";

export type McpServerState =
  | { readonly _tag: "Stopped"; readonly run: number }
  | { readonly _tag: "Connecting"; readonly run: number }
  | { readonly _tag: "Ready"; readonly run: number; readonly tools: ReadonlyArray<McpSchema.Tool> }
  | { readonly _tag: "Failed"; readonly run: number; readonly reason: string }
  | { readonly _tag: "Exited"; readonly run: number; readonly reason: string };

export type McpServerEvent =
  /** The process group's state changed. */
  | { readonly _tag: "Process"; readonly state: ProcessState }
  /** The run's server answered `initialize` and listed its tools. */
  | { readonly _tag: "Connected"; readonly run: number; readonly tools: ReadonlyArray<McpSchema.Tool> }
  /** The run's server did not connect: why. */
  | { readonly _tag: "ConnectFailed"; readonly run: number; readonly reason: string };

/** What is to be done: stop the process, so that a server that did not connect leaves none behind. */
export type McpServerEffect = { readonly _tag: "StopProcess" };

export interface McpServerStep {
  readonly state: McpServerState;
  readonly effects: ReadonlyArray<McpServerEffect>;
}

export const initialMcpServerState: McpServerState = { _tag: "Stopped", run: 0 };

const stay = (state: McpServerState): McpServerStep => ({ state, effects: [] });

const live = (state: McpServerState): boolean => state._tag === "Connecting" || state._tag === "Ready";

const endedOf = (process: Extract<ProcessState, { _tag: "Exited" }>): string =>
  process.code !== undefined ? `its process exited with code ${process.code}` : process.signal !== undefined ? `its process ended on ${process.signal}` : "its process ended";

/** The next state, and what is to be done, once `event` happened in `state`. */
export const stepMcpServer = (state: McpServerState, event: McpServerEvent): McpServerStep => {
  switch (event._tag) {
    case "Process": {
      const process = event.state;
      if (process.run < state.run) return stay(state);
      switch (process._tag) {
        case "Starting":
          return process.run > state.run ? stay({ _tag: "Connecting", run: process.run }) : stay(state);
        case "Running":
          return process.run > state.run ? stay({ _tag: "Connecting", run: process.run }) : stay(state);
        case "Failed":
          return stay({ _tag: "Failed", run: process.run, reason: `its process could not be started: ${process.reason}` });
        case "Exited":
          return live(state) || process.run > state.run ? stay({ _tag: "Exited", run: process.run, reason: endedOf(process) }) : stay(state);
        case "Idle":
          return live(state) ? stay({ _tag: "Stopped", run: state.run }) : stay(state);
        default:
          return process satisfies never;
      }
    }
    case "Connected":
      return event.run >= state.run && (state._tag === "Connecting" || state._tag === "Stopped" || event.run > state.run)
        ? stay({ _tag: "Ready", run: event.run, tools: event.tools })
        : stay(state);
    case "ConnectFailed":
      return event.run >= state.run && (state._tag === "Connecting" || event.run > state.run)
        ? { state: { _tag: "Failed", run: event.run, reason: event.reason }, effects: [{ _tag: "StopProcess" }] }
        : stay(state);
    default:
      return event satisfies never;
  }
};

/** What a state says of the server, in a sentence. */
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
    case "Exited":
      return `it stopped: ${state.reason}`;
    default:
      return state satisfies never;
  }
};
