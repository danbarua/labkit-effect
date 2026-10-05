/**
 * A turn step: one request to the model and what follows from its response.
 *
 * - The step requests a model response.
 * - Each tool call opens a call machine and requests the tool's run: when the call arrives while
 *   the response streams, or, for a call that did not arrive earlier, when the response is
 *   recorded. The step waits until every call has settled.
 * - A response without tool calls tells the turn how it ended: answered, unanswered (whole with no
 *   answer text), unfinished (the turn asks again), or cut short.
 * - A failed attempt at the request, after which the request continues, changes nothing; the step
 *   waits for the request's outcome.
 * - When the step finishes, it tells its turn how.
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
import { becomes, type Table, type TransitionResult } from "./table.ts";

export type TurnStepState =
  | { readonly _tag: "NotStarted"; readonly step: StepAddress }
  /**
   * The model was asked. `opened` are the calls that arrived while the response streams, each run
   * at once; `unsettled` are the calls among them that have not ended.
   */
  | {
      readonly _tag: "AwaitingModel";
      readonly step: StepAddress;
      readonly opened: ReadonlyArray<CallId>;
      readonly unsettled: ReadonlyArray<CallId>;
    }
  | { readonly _tag: "RunningTools"; readonly step: StepAddress; readonly unsettled: ReadonlyArray<CallId> }
  | { readonly _tag: "Done"; readonly step: StepAddress };

export type TurnStepMessage = ToTurnStep | ModelObservation;

type StepResult = TransitionResult<TurnStepState, Send>;

export const openingTurnStep = (step: StepAddress): TurnStepState => ({ _tag: "NotStarted", step });

const done = (step: StepAddress, report: Send): StepResult => ({
  state: { _tag: "Done", step },
  decisions: [],
  requests: [],
  sends: [report],
});

export const turnStepTable: Table<TurnStepState, TurnStepMessage, Send> = {
  NotStarted: {
    StepStart: (state) => ({
      state: { _tag: "AwaitingModel", step: state.step, opened: [], unsettled: [] },
      decisions: [
        state.step.index === 1
          ? { _tag: "AskModel", turn: state.step.turn }
          : { _tag: "TellModel", turn: state.step.turn, step: state.step.index },
      ],
      requests: [{ _tag: "RequestModelResponse", turn: state.step.turn }],
      sends: [],
    }),
    CallSettled: "ignored",
    ModelResponded: "ignored",
    ModelFailed: "ignored",
    ModelAttemptFailed: "ignored",
    NoticeInserted: "ignored",
    ModelRequestDispatched: "ignored",
    SettingAdjusted: "ignored",
    ToolCallArrived: "ignored",
    ModelVetoed: "ignored",
  },
  AwaitingModel: {
    /** A call that arrives while the response streams is opened and run at once. */
    ToolCallArrived: (state, message) =>
      state.opened.includes(message.call)
        ? becomes(state)
        : {
            state: { ...state, opened: [...state.opened, message.call], unsettled: [...state.unsettled, message.call] },
            decisions: [],
            requests: [{ _tag: "RunTool", call: message.call, tool: message.tool, input: message.input }],
            sends: [toCall(message.call, { _tag: "CallOpened", step: state.step })],
          },
    CallSettled: (state, message) => becomes({ ...state, unsettled: state.unsettled.filter((call) => call !== message.call) }),
    /**
     * The response's calls that did not arrive earlier are opened and run.
     *
     * - With no call at all, the step tells the turn how the response ended.
     * - With every call settled, the step tells the turn that the tool batch has settled.
     * - Otherwise the step waits for the calls still running.
     */
    ModelResponded: (state, message) => {
      const calls = message.parts.flatMap((part) => (part._tag === "ToolCall" ? [part] : []));
      const fresh = calls.filter((call) => !state.opened.includes(call.call));
      const unsettled = [...state.unsettled, ...fresh.map((call) => call.call)];
      if (state.opened.length === 0 && calls.length === 0)
        return done(
          state.step,
          toConversationTurn(state.step.turn, {
            _tag:
              message.ending._tag === "Complete"
                ? message.parts.some((part) => part._tag === "Text")
                  ? "StepAnswered"
                  : "StepUnanswered"
                : message.ending._tag === "Unfinished"
                  ? "StepUnfinished"
                  : "StepCutShort",
          }),
        );
      if (unsettled.length === 0) return done(state.step, toConversationTurn(state.step.turn, { _tag: "StepToolsSettled" }));
      return {
        state: { _tag: "RunningTools", step: state.step, unsettled },
        decisions: [],
        requests: fresh.map((call) => ({ _tag: "RunTool" as const, call: call.call, tool: call.tool, input: call.input })),
        sends: fresh.map((call) => toCall(call.call, { _tag: "CallOpened", step: state.step })),
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
    /** The request goes on; the step waits for its outcome. */
    ModelAttemptFailed: (state) => becomes(state),
    /** A notice went into the request; the step waits for its outcome. */
    NoticeInserted: (state) => becomes(state),
    /** The request was made; the step waits for its outcome. */
    ModelRequestDispatched: (state) => becomes(state),
    /** A setting was adjusted on the request; the step waits for its outcome. */
    SettingAdjusted: (state) => becomes(state),
    ModelVetoed: (state, message) =>
      done(
        state.step,
        toConversationTurn(state.step.turn, {
          _tag: "StepStopped",
          ending: { _tag: "Vetoed", reason: message.reason },
        }),
      ),
    StepStart: "ignored",
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
    ModelAttemptFailed: "ignored",
    NoticeInserted: "ignored",
    ModelRequestDispatched: "ignored",
    SettingAdjusted: "ignored",
    ToolCallArrived: "ignored",
    ModelVetoed: "ignored",
  },
  Done: {
    StepStart: "ignored",
    CallSettled: "ignored",
    ModelResponded: "ignored",
    ModelFailed: "ignored",
    ModelAttemptFailed: "ignored",
    NoticeInserted: "ignored",
    ModelRequestDispatched: "ignored",
    SettingAdjusted: "ignored",
    ToolCallArrived: "ignored",
    ModelVetoed: "ignored",
  },
};
