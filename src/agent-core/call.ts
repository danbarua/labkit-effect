/**
 * The call machine: one per tool call. It is opened by the turn that proposed it, and settles when
 * the call ends, telling that turn.
 */

import { type CallObservation, type Send, type ToCall, toTurn } from "./messages.ts";
import type { CallId, TurnId } from "./names.ts";
import { becomes, type Table } from "./table.ts";

export type CallState =
  | { readonly _tag: "NotOpened"; readonly call: CallId }
  | { readonly _tag: "Running"; readonly call: CallId; readonly turn: TurnId }
  | { readonly _tag: "Ended"; readonly call: CallId };

export type CallMessage = CallObservation | ToCall;

export const openingCall = (call: CallId): CallState => ({ _tag: "NotOpened", call });

export const callTable: Table<CallState, CallMessage, Send> = {
  NotOpened: {
    CallOpened: (state, message) => becomes({ _tag: "Running", call: state.call, turn: message.turn }),
    ToolEnded: "ignored",
  },
  Running: {
    ToolEnded: (state) => ({
      state: { _tag: "Ended", call: state.call },
      decisions: [],
      requests: [],
      sends: [toTurn(state.turn, { _tag: "CallSettled", call: state.call })],
    }),
    CallOpened: "ignored",
  },
  Ended: {
    CallOpened: "ignored",
    ToolEnded: "ignored",
  },
};
