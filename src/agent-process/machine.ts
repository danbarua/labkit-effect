/**
 * A pure state machine for one process group. `stepProcess` returns the next state and the effects
 * to perform. Each start creates a run, numbered from 1. An event about a run other than the current
 * one changes nothing, because a stopped process can report its exit after its replacement has
 * started.
 */

export type ProcessState =
  /** Not started, or stopped. */
  | { readonly _tag: "Idle"; readonly run: number }
  | { readonly _tag: "Starting"; readonly run: number }
  | { readonly _tag: "Running"; readonly run: number; readonly pid: number }
  /**
   * The run's process ended without a stop request. `code` is the exit code, and `signal` is the name
   * of the signal that ended the process. Both are undefined when the spawner reported neither.
   */
  | { readonly _tag: "Exited"; readonly run: number; readonly code: number | undefined; readonly signal: string | undefined }
  /** The run could not be started. */
  | { readonly _tag: "Failed"; readonly run: number; readonly reason: string };

export type ProcessEvent =
  /** A request to start a run. Ignored while a run is starting or running. */
  | { readonly _tag: "Start" }
  /** A request to kill the live run, if there is one, and start a new run. */
  | { readonly _tag: "Restart" }
  /** A request to kill the live run, if there is one. */
  | { readonly _tag: "Stop" }
  | { readonly _tag: "Started"; readonly run: number; readonly pid: number }
  | { readonly _tag: "StartFailed"; readonly run: number; readonly reason: string }
  | { readonly _tag: "Ended"; readonly run: number; readonly code: number | undefined; readonly signal: string | undefined };

/** An effect to perform: spawn run `run`, or kill the whole process group of run `run`. */
export type ProcessEffect = { readonly _tag: "Spawn"; readonly run: number } | { readonly _tag: "Kill"; readonly run: number };

export interface ProcessStep {
  readonly state: ProcessState;
  readonly effects: ReadonlyArray<ProcessEffect>;
}

export const initialProcessState: ProcessState = { _tag: "Idle", run: 0 };

/** Whether a run is live: starting or running. */
const live = (state: ProcessState): boolean => {
  switch (state._tag) {
    case "Starting":
    case "Running":
      return true;
    case "Idle":
    case "Exited":
    case "Failed":
      return false;
    default:
      return state satisfies never;
  }
};

const stay = (state: ProcessState): ProcessStep => ({ state, effects: [] });

/** Returns the next state and the effects to perform after `event` in `state`. */
export const stepProcess = (state: ProcessState, event: ProcessEvent): ProcessStep => {
  switch (event._tag) {
    case "Start":
      return live(state) ? stay(state) : { state: { _tag: "Starting", run: state.run + 1 }, effects: [{ _tag: "Spawn", run: state.run + 1 }] };
    case "Restart":
      return {
        state: { _tag: "Starting", run: state.run + 1 },
        effects: [...(live(state) ? [{ _tag: "Kill" as const, run: state.run }] : []), { _tag: "Spawn", run: state.run + 1 }],
      };
    case "Stop":
      return live(state) ? { state: { _tag: "Idle", run: state.run }, effects: [{ _tag: "Kill", run: state.run }] } : stay(state);
    case "Started":
      return state._tag === "Starting" && state.run === event.run ? stay({ _tag: "Running", run: event.run, pid: event.pid }) : stay(state);
    case "StartFailed":
      return state._tag === "Starting" && state.run === event.run ? stay({ _tag: "Failed", run: event.run, reason: event.reason }) : stay(state);
    case "Ended":
      return live(state) && state.run === event.run ? stay({ _tag: "Exited", run: event.run, code: event.code, signal: event.signal }) : stay(state);
    default:
      return event satisfies never;
  }
};
