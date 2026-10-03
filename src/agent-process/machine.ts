/**
 * The life of a child process group that a session keeps: started, running, ended by itself, failed
 * to start, stopped, started again. Each start is a run, numbered from 1; what arrives about a run
 * that is not the current one (an end reported after a restart) changes nothing. The machine is
 * pure: given its state and what happened, it gives the next state and what is to be done (start a
 * run, stop one).
 */

export type ProcessState =
  /** Not started, or stopped. */
  | { readonly _tag: "Idle"; readonly run: number }
  | { readonly _tag: "Starting"; readonly run: number }
  | { readonly _tag: "Running"; readonly run: number; readonly pid: number }
  /** The run ended by itself: its exit code, or the signal that ended it. */
  | { readonly _tag: "Exited"; readonly run: number; readonly code: number | undefined; readonly signal: string | undefined }
  /** The run could not be started. */
  | { readonly _tag: "Failed"; readonly run: number; readonly reason: string };

export type ProcessEvent =
  /** Asked to start: does nothing while a run is starting or running. */
  | { readonly _tag: "Start" }
  /** Asked to start again: stops the run there is, if any, and starts another. */
  | { readonly _tag: "Restart" }
  /** Asked to stop: stops the run there is, if any. */
  | { readonly _tag: "Stop" }
  | { readonly _tag: "Started"; readonly run: number; readonly pid: number }
  | { readonly _tag: "StartFailed"; readonly run: number; readonly reason: string }
  | { readonly _tag: "Ended"; readonly run: number; readonly code: number | undefined; readonly signal: string | undefined };

/** What is to be done: start run `run`, or stop it (its whole group). */
export type ProcessEffect = { readonly _tag: "Spawn"; readonly run: number } | { readonly _tag: "Kill"; readonly run: number };

export interface ProcessStep {
  readonly state: ProcessState;
  readonly effects: ReadonlyArray<ProcessEffect>;
}

export const initialProcessState: ProcessState = { _tag: "Idle", run: 0 };

const live = (state: ProcessState): boolean => state._tag === "Starting" || state._tag === "Running";

const stay = (state: ProcessState): ProcessStep => ({ state, effects: [] });

/** The next state, and what is to be done, once `event` happened in `state`. */
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
