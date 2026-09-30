/**
 * The call machine: one per tool call. It is opened by the step that proposed it, and settles when
 * the call ends, telling that step. What happens to a call between being opened and settling is
 * this machine's business, not the step's.
 */

import { type CallObservation, type Send, type StepAddress, type ToCall, toTurnStep } from "./messages.ts";
import type { CallId } from "./names.ts";
import { becomes, type Table } from "./table.ts";

export type CallState =
  | { readonly _tag: "NotOpened"; readonly call: CallId }
  | { readonly _tag: "Running"; readonly call: CallId; readonly step: StepAddress }
  | { readonly _tag: "Ended"; readonly call: CallId };

export type CallMessage = CallObservation | ToCall;

export const openingCall = (call: CallId): CallState => ({ _tag: "NotOpened", call });

export const callTable: Table<CallState, CallMessage, Send> = {
  NotOpened: {
    CallOpened: (state, message) => becomes({ _tag: "Running", call: state.call, step: message.step }),
    ToolCallDispatched: "ignored",
    ToolEnded: "ignored",
  },
  Running: {
    /** Recorded; the call waits for how it ends. */
    ToolCallDispatched: (state) => becomes(state),
    ToolEnded: (state) => ({
      state: { _tag: "Ended", call: state.call },
      decisions: [],
      requests: [],
      sends: [toTurnStep(state.step, { _tag: "CallSettled", call: state.call })],
    }),
    CallOpened: "ignored",
  },
  Ended: {
    CallOpened: "ignored",
    ToolCallDispatched: "ignored",
    ToolEnded: "ignored",
  },
};
