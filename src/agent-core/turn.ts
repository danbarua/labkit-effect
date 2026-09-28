/**
 * The turn machine: one per turn. A turn alternates between asking the model and running the tool
 * calls the model proposed. Between steps it waits for the session, which gives it any queued input
 * and lets it go on.
 */

import { type Send, type ToTurn, type TurnObservation, toCall, toSession } from "./messages.ts";
import type { CallId, TurnId } from "./names.ts";
import { becomes, type Table } from "./table.ts";

export type TurnState =
  /** Between steps, waiting for the session to let the turn go on. */
  | { readonly _tag: "Waiting"; readonly turn: TurnId }
  | { readonly _tag: "AwaitingModel"; readonly turn: TurnId }
  | { readonly _tag: "RunningTools"; readonly turn: TurnId; readonly unsettled: ReadonlyArray<CallId> }
  | { readonly _tag: "Ended"; readonly turn: TurnId };

export type TurnMessage = TurnObservation | ToTurn;

export const openingTurn = (turn: TurnId): TurnState => ({ _tag: "Waiting", turn });

export const turnTable: Table<TurnState, TurnMessage, Send> = {
  Waiting: {
    NextStep: (state, _message, { at }) => ({
      state: { _tag: "AwaitingModel", turn: state.turn },
      decisions: [{ _tag: "ModelAsked", turn: state.turn, through: at }],
      requests: [{ _tag: "RequestModelResponse", turn: state.turn }],
      sends: [],
    }),
    ModelResponded: "ignored",
    ModelFailed: "ignored",
    ModelVetoed: "ignored",
    CallSettled: "ignored",
  },
  AwaitingModel: {
    ModelResponded: (state, message) => {
      const calls = message.parts.flatMap((part) => (part._tag === "ToolCall" ? [part] : []));
      return calls.length === 0
        ? {
            state: { _tag: "Waiting", turn: state.turn },
            decisions: [],
            requests: [],
            sends: [toSession({ _tag: "Answered", turn: state.turn })],
          }
        : {
            state: { _tag: "RunningTools", turn: state.turn, unsettled: calls.map((call) => call.call) },
            decisions: [],
            requests: calls.map((call) => ({ _tag: "RunTool" as const, call: call.call, tool: call.tool, input: call.input })),
            sends: calls.map((call) => toCall(call.call, { _tag: "CallOpened", turn: state.turn })),
          };
    },
    ModelFailed: (state, message) => ({
      state: { _tag: "Ended", turn: state.turn },
      decisions: [],
      requests: [],
      sends: [toSession({ _tag: "TurnStopped", turn: state.turn, ending: { _tag: "Failed", failure: message.failure } })],
    }),
    ModelVetoed: (state, message) => ({
      state: { _tag: "Ended", turn: state.turn },
      decisions: [],
      requests: [],
      sends: [toSession({ _tag: "TurnStopped", turn: state.turn, ending: { _tag: "Vetoed", reason: message.reason } })],
    }),
    NextStep: "ignored",
    CallSettled: "ignored",
  },
  RunningTools: {
    CallSettled: (state, message) => {
      const unsettled = state.unsettled.filter((call) => call !== message.call);
      return unsettled.length === 0
        ? {
            state: { _tag: "Waiting", turn: state.turn },
            decisions: [],
            requests: [],
            sends: [toSession({ _tag: "ToolsSettled", turn: state.turn })],
          }
        : becomes({ ...state, unsettled });
    },
    ModelResponded: "ignored",
    ModelFailed: "ignored",
    ModelVetoed: "ignored",
    NextStep: "ignored",
  },
  Ended: {
    NextStep: "ignored",
    ModelResponded: "ignored",
    ModelFailed: "ignored",
    ModelVetoed: "ignored",
    CallSettled: "ignored",
  },
};
