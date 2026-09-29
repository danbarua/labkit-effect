/**
 * A turn step: one request to the model and what follows from its response. The step asks the
 * model; a response with tool calls opens a call for each and requests it be run, and the step
 * waits for each to settle; a response without tool calls is a final answer, unless it was cut
 * short, in which case the turn goes on to ask again. The step tells its turn how it finished.
 */

import {
  type ModelObservation,
  type Send,
  type StepAddress,
  type ToTurnStep,
  toCall,
  toConversationTurn,
} from "./messages.ts";
import type { CallId } from "./names.ts";
import { becomes, type Step, type Table } from "./table.ts";

export type TurnStepState =
  | { readonly _tag: "NotStarted"; readonly step: StepAddress }
  | { readonly _tag: "AwaitingModel"; readonly step: StepAddress }
  | { readonly _tag: "RunningTools"; readonly step: StepAddress; readonly unsettled: ReadonlyArray<CallId> }
  | { readonly _tag: "Done"; readonly step: StepAddress };

export type TurnStepMessage = ToTurnStep | ModelObservation;

type StepStep = Step<TurnStepState, Send>;

export const openingTurnStep = (step: StepAddress): TurnStepState => ({ _tag: "NotStarted", step });

const done = (step: StepAddress, told: Send): StepStep => ({
  state: { _tag: "Done", step },
  decisions: [],
  requests: [],
  sends: [told],
});

export const turnStepTable: Table<TurnStepState, TurnStepMessage, Send> = {
  NotStarted: {
    StepStart: (state, _message, { at }) => ({
      state: { _tag: "AwaitingModel", step: state.step },
      decisions: [{ _tag: "ModelAsked", turn: state.step.turn, through: at }],
      requests: [{ _tag: "RequestModelResponse", turn: state.step.turn }],
      sends: [],
    }),
    CallSettled: "ignored",
    ModelResponded: "ignored",
    ModelFailed: "ignored",
    ModelVetoed: "ignored",
  },
  AwaitingModel: {
    ModelResponded: (state, message) => {
      const calls = message.parts.flatMap((part) => (part._tag === "ToolCall" ? [part] : []));
      return calls.length === 0
        ? done(
            state.step,
            toConversationTurn(state.step.turn, {
              _tag: message.ending._tag === "CutShort" ? "StepCutShort" : "StepAnswered",
            }),
          )
        : {
            state: { _tag: "RunningTools", step: state.step, unsettled: calls.map((call) => call.call) },
            decisions: [],
            requests: calls.map((call) => ({
              _tag: "RunTool" as const,
              call: call.call,
              tool: call.tool,
              input: call.input,
            })),
            sends: calls.map((call) => toCall(call.call, { _tag: "CallOpened", step: state.step })),
          };
    },
    ModelFailed: (state, message) =>
      done(
        state.step,
        toConversationTurn(state.step.turn, {
          _tag: "StepStopped",
          ending: { _tag: "Failed", failure: message.failure },
        }),
      ),
    ModelVetoed: (state, message) =>
      done(
        state.step,
        toConversationTurn(state.step.turn, {
          _tag: "StepStopped",
          ending: { _tag: "Vetoed", reason: message.reason },
        }),
      ),
    StepStart: "ignored",
    CallSettled: "ignored",
  },
  RunningTools: {
    CallSettled: (state, message) => {
      const unsettled = state.unsettled.filter((call) => call !== message.call);
      return unsettled.length === 0
        ? done(state.step, toConversationTurn(state.step.turn, { _tag: "StepToolsSettled" }))
        : becomes({ ...state, unsettled });
    },
    StepStart: "ignored",
    ModelResponded: "ignored",
    ModelFailed: "ignored",
    ModelVetoed: "ignored",
  },
  Done: {
    StepStart: "ignored",
    CallSettled: "ignored",
    ModelResponded: "ignored",
    ModelFailed: "ignored",
    ModelVetoed: "ignored",
  },
};
