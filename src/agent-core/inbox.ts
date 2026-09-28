/**
 * The inbox: where input waits. While no turn is under way, input leads to a turn: the inbox
 * records `TurnRequested` with everything queued and requests `StartTurn`; an adapter starts the
 * turn and reports `TurnStarted`. While a turn is starting or under way, input is queued, and the
 * turn collects it between steps. When a turn stops without an answer, what is queued is dropped.
 */

import {
  type InboxObservation,
  type Send,
  type ToInbox,
  toConversationTurn,
} from "./messages.ts";
import type { Inputs, Seq, TurnId } from "./names.ts";
import { becomes, type Step, type Table } from "./table.ts";

export type InboxState =
  /** No turn is under way. */
  | { readonly _tag: "Idle"; readonly queued: ReadonlyArray<Seq> }
  /** A turn was requested; the adapter has not reported it started. */
  | { readonly _tag: "Starting"; readonly queued: ReadonlyArray<Seq> }
  /** A turn is under way. */
  | { readonly _tag: "Serving"; readonly turn: TurnId; readonly queued: ReadonlyArray<Seq> };

export type InboxMessage = InboxObservation | ToInbox;

type InboxStep = Step<InboxState, Send>;

export const openingInbox: InboxState = { _tag: "Idle", queued: [] };

function isInputs(queued: ReadonlyArray<Seq>): queued is Inputs {
  return queued.length > 0;
}

/** `queued`, with `seq` after it: at least one input. */
function withLast(queued: ReadonlyArray<Seq>, seq: Seq): Inputs {
  return [...queued, seq] as ReadonlyArray<Seq> as Inputs;
}

const queue = <S extends InboxState>(state: S, seq: Seq): InboxStep =>
  becomes({ ...state, queued: [...state.queued, seq] });

const cancel = <S extends InboxState>(state: S, input: Seq): InboxStep =>
  becomes({ ...state, queued: state.queued.filter((queued) => queued !== input) });

export const inboxTable: Table<InboxState, InboxMessage, Send> = {
  Idle: {
    SessionOpened: (state) => becomes(state),
    InputArrived: (state, _message, { seq }) => {
      const inputs = withLast(state.queued, seq);
      return {
        state: { _tag: "Starting", queued: [] },
        decisions: [{ _tag: "TurnRequested", inputs }],
        requests: [{ _tag: "StartTurn", inputs }],
        sends: [],
      };
    },
    InputCancelled: (state, message) => cancel(state, message.input),
    TurnStarted: "ignored",
    CollectMail: "ignored",
    TurnAnswered: "ignored",
    TurnStopped: "ignored",
  },
  Starting: {
    SessionOpened: "ignored",
    InputArrived: (state, _message, { seq }) => queue(state, seq),
    InputCancelled: (state, message) => cancel(state, message.input),
    TurnStarted: (state, message) => ({
      state: { _tag: "Serving", turn: message.turn, queued: state.queued },
      decisions: [],
      requests: [],
      sends: [toConversationTurn(message.turn, { _tag: "TurnOpened" })],
    }),
    CollectMail: "ignored",
    TurnAnswered: "ignored",
    TurnStopped: "ignored",
  },
  Serving: {
    SessionOpened: "ignored",
    InputArrived: (state, _message, { seq }) => queue(state, seq),
    InputCancelled: (state, message) => cancel(state, message.input),
    TurnStarted: "ignored",
    CollectMail: (state) => ({
      state: { ...state, queued: [] },
      decisions: [],
      requests: [],
      sends: [
        toConversationTurn(
          state.turn,
          isInputs(state.queued) ? { _tag: "Mail", inputs: state.queued } : { _tag: "NoMail" },
        ),
      ],
    }),
    TurnAnswered: (state) => becomes({ _tag: "Idle", queued: state.queued }),
    TurnStopped: (state) => ({
      state: { _tag: "Idle", queued: [] },
      decisions: isInputs(state.queued) ? [{ _tag: "InputDropped", turn: state.turn, inputs: state.queued }] : [],
      requests: [],
      sends: [],
    }),
  },
};
