/**
 * The call machine: one per tool call. The step that proposed the call opens it. When the call ends
 * (`ToolEnded`), the machine settles and tells that step (`CallSettled`). Between those two, the
 * call machine, not the step, tracks the call: a policy's question and its answer, and whether the
 * tool began to run (`began`).
 */

import { type CallObservation, type Send, type StepAddress, type ToCall, toTurnStep } from "./messages.ts";
import type { CallId } from "./names.ts";
import { becomes, type Table } from "./table.ts";

export type CallState =
  | { readonly _tag: "NotOpened"; readonly call: CallId }
  | { readonly _tag: "Running"; readonly call: CallId; readonly step: StepAddress; readonly began: boolean }
  | { readonly _tag: "Ended"; readonly call: CallId };

export type CallMessage = CallObservation | ToCall;

export const openingCall = (call: CallId): CallState => ({ _tag: "NotOpened", call });

export const callTable: Table<CallState, CallMessage, Send> = {
  NotOpened: {
    CallOpened: (state, message) => becomes({ _tag: "Running", call: state.call, step: message.step, began: false }),
    PermissionAsked: "ignored",
    PermissionAnswered: "ignored",
    ToolCallDispatched: "ignored",
    ToolEnded: "ignored",
  },
  Running: {
    /** The call waits for the answer. */
    PermissionAsked: (state) => becomes(state),
    /** The policy that asked decides whether the call runs. */
    PermissionAnswered: (state) => becomes(state),
    /** The tool began to run; the call waits for its end. */
    ToolCallDispatched: (state) => becomes({ ...state, began: true }),
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
    PermissionAsked: "ignored",
    PermissionAnswered: "ignored",
    ToolCallDispatched: "ignored",
    ToolEnded: "ignored",
  },
};
