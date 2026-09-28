/**
 * The session machine: input queueing, and when a turn starts and ends.
 *
 * Input can arrive at any time. While no turn is under way, input leads to a turn: the session
 * records `TurnRequested` with every queued input and requests `StartTurn`; an adapter starts the
 * turn and reports `TurnStarted`. Input that arrives while a turn is starting or under way is
 * queued, and given to the turn when it reaches a point between steps. A turn ends on a final
 * answer with no input queued. A turn that stops without an answer drops its queued input.
 */

import type { Ending } from "./decision.ts";
import { type SessionObservation, type Send, type ToSession, toTurn } from "./messages.ts";
import type { Inputs, Seq, TurnId } from "./names.ts";
import { becomes, type Step, type Table } from "./table.ts";

export type SessionState =
  | { readonly _tag: "NotOpened" }
  | { readonly _tag: "Idle"; readonly queued: ReadonlyArray<Seq> }
  | { readonly _tag: "Starting"; readonly queued: ReadonlyArray<Seq> }
  | { readonly _tag: "InTurn"; readonly turn: TurnId; readonly queued: ReadonlyArray<Seq> };

export type SessionMessage = SessionObservation | ToSession;

type Open = Exclude<SessionState, { _tag: "NotOpened" }>;
type SessionStep = Step<SessionState, Send>;

export const openingSession: SessionState = { _tag: "NotOpened" };

function isInputs(queued: ReadonlyArray<Seq>): queued is Inputs {
  return queued.length > 0;
}

const queue = <S extends Open>(state: S, seq: Seq): SessionStep =>
  becomes({ ...state, queued: [...state.queued, seq] });

const cancel = <S extends Open>(state: S, input: Seq): SessionStep =>
  becomes({ ...state, queued: state.queued.filter((queued) => queued !== input) });

/** At a point between steps: the turn is given the queued input, then goes on. */
const nextStep = (state: Extract<SessionState, { _tag: "InTurn" }>): SessionStep => ({
  state: { ...state, queued: [] },
  decisions: isInputs(state.queued) ? [{ _tag: "InputDelivered", turn: state.turn, inputs: state.queued }] : [],
  requests: [],
  sends: [toTurn(state.turn, { _tag: "NextStep" })],
});

/** The model answered and nothing is queued: the turn ends. */
const answered = (state: Extract<SessionState, { _tag: "InTurn" }>): SessionStep => ({
  state: { _tag: "Idle", queued: [] },
  decisions: [{ _tag: "TurnEnded", turn: state.turn, ending: { _tag: "Answered" } }],
  requests: [],
  sends: [],
});

/** The turn stopped without an answer: its queued input is dropped, and it ends. */
const stopped = (state: Extract<SessionState, { _tag: "InTurn" }>, ending: Exclude<Ending, { _tag: "Answered" }>): SessionStep => ({
  state: { _tag: "Idle", queued: [] },
  decisions: [
    ...(isInputs(state.queued) ? [{ _tag: "InputDropped" as const, turn: state.turn, inputs: state.queued }] : []),
    { _tag: "TurnEnded", turn: state.turn, ending },
  ],
  requests: [],
  sends: [],
});

export const sessionTable: Table<SessionState, SessionMessage, Send> = {
  NotOpened: {
    SessionOpened: () => becomes({ _tag: "Idle", queued: [] }),
    InputArrived: "ignored",
    InputCancelled: "ignored",
    TurnStarted: "ignored",
    ToolsSettled: "ignored",
    Answered: "ignored",
    TurnStopped: "ignored",
  },
  Idle: {
    SessionOpened: "ignored",
    InputArrived: (state, _message, { seq }) => {
      const inputs: Inputs = [...state.queued, seq] as unknown as Inputs;
      return {
        state: { _tag: "Starting", queued: [] },
        decisions: [{ _tag: "TurnRequested", inputs }],
        requests: [{ _tag: "StartTurn", inputs }],
        sends: [],
      };
    },
    InputCancelled: (state, message) => cancel(state, message.input),
    TurnStarted: "ignored",
    ToolsSettled: "ignored",
    Answered: "ignored",
    TurnStopped: "ignored",
  },
  Starting: {
    SessionOpened: "ignored",
    InputArrived: (state, _message, { seq }) => queue(state, seq),
    InputCancelled: (state, message) => cancel(state, message.input),
    TurnStarted: (state, message) => ({
      state: { _tag: "InTurn", turn: message.turn, queued: state.queued },
      decisions: [],
      requests: [],
      sends: [toTurn(message.turn, { _tag: "NextStep" })],
    }),
    ToolsSettled: "ignored",
    Answered: "ignored",
    TurnStopped: "ignored",
  },
  InTurn: {
    SessionOpened: "ignored",
    InputArrived: (state, _message, { seq }) => queue(state, seq),
    InputCancelled: (state, message) => cancel(state, message.input),
    TurnStarted: "ignored",
    ToolsSettled: (state) => nextStep(state),
    Answered: (state) => (isInputs(state.queued) ? nextStep(state) : answered(state)),
    TurnStopped: (state, message) => stopped(state, message.ending),
  },
};
