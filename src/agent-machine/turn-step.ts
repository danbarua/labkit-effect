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
 * - A step finishes only when every call it opened has settled, whatever the request's outcome
 *   (`finish`): a request that fails or is vetoed while calls it started are running leaves the step
 *   running them, and the step tells its turn that it stopped once they have settled. The calls
 *   belong to the turn that started them, so their ends are recorded before the turn ends.
 * - When the step finishes, it tells its turn how.
 */

import {
  type ModelObservation,
  type Send,
  type StepAddress,
  type ToConversationTurn,
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
  /**
   * The request has its outcome, and calls the step opened are still running. `report` is what the
   * step tells its turn once they have settled: that the tool batch settled, or that the request
   * failed or was vetoed.
   */
  | { readonly _tag: "RunningTools"; readonly step: StepAddress; readonly unsettled: ReadonlyArray<CallId>; readonly report: StepReport }
  /** Every call the step opened has settled, and the step has told its turn how it finished. Only `finish` makes this state. */
  | { readonly _tag: "Done"; readonly step: StepAddress };

/** What a step tells its turn when it finishes. */
type StepReport = Extract<
  ToConversationTurn,
  { _tag: "StepToolsSettled" | "StepAnswered" | "StepUnanswered" | "StepCutShort" | "StepUnfinished" | "StepStopped" }
>;

export type TurnStepMessage = ToTurnStep | ModelObservation;

type StepResult = TransitionResult<TurnStepState, Send>;

export const openingTurnStep = (step: StepAddress): TurnStepState => ({ _tag: "NotStarted", step });

/**
 * Finishes the step when none of its calls is unsettled: the step is done, and tells its turn
 * `report`. Otherwise the step runs its calls, and tells its turn `report` once they have settled.
 */
const finish = (step: StepAddress, unsettled: ReadonlyArray<CallId>, report: StepReport): StepResult =>
  unsettled.length === 0
    ? { state: { _tag: "Done", step }, decisions: [], requests: [], sends: [toConversationTurn(step.turn, report)] }
    : becomes({ _tag: "RunningTools", step, unsettled, report });

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
     * - Otherwise the step tells the turn that the tool batch has settled, once every call has.
     */
    ModelResponded: (state, message) => {
      const calls = message.parts.flatMap((part) => (part._tag === "ToolCall" ? [part] : []));
      const fresh = calls.filter((call) => !state.opened.includes(call.call));
      const unsettled = [...state.unsettled, ...fresh.map((call) => call.call)];
      if (state.opened.length === 0 && calls.length === 0)
        return finish(state.step, unsettled, {
          _tag:
            message.ending._tag === "Complete"
              ? message.parts.some((part) => part._tag === "Text")
                ? "StepAnswered"
                : "StepUnanswered"
              : message.ending._tag === "Unfinished"
                ? "StepUnfinished"
                : "StepCutShort",
        });
      const finished = finish(state.step, unsettled, { _tag: "StepToolsSettled" });
      return {
        ...finished,
        requests: fresh.map((call) => ({ _tag: "RunTool" as const, call: call.call, tool: call.tool, input: call.input })),
        sends: [...fresh.map((call) => toCall(call.call, { _tag: "CallOpened", step: state.step })), ...finished.sends],
      };
    },
    /** The request failed: the step stops once the calls it started have settled. */
    ModelFailed: (state, message) => finish(state.step, state.unsettled, { _tag: "StepStopped", ending: { _tag: "Failed", failure: message.failure } }),
    /** The request goes on; the step waits for its outcome. */
    ModelAttemptFailed: (state) => becomes(state),
    /** A notice went into the request; the step waits for its outcome. */
    NoticeInserted: (state) => becomes(state),
    /** The request was made; the step waits for its outcome. */
    ModelRequestDispatched: (state) => becomes(state),
    /** A setting was adjusted on the request; the step waits for its outcome. */
    SettingAdjusted: (state) => becomes(state),
    /** The request was vetoed: the step stops once any calls it opened have settled (a veto comes before the request, so it has none). */
    ModelVetoed: (state, message) => finish(state.step, state.unsettled, { _tag: "StepStopped", ending: { _tag: "Vetoed", reason: message.reason } }),
    StepStart: "ignored",
  },
  RunningTools: {
    CallSettled: (state, message) =>
      finish(
        state.step,
        state.unsettled.filter((call) => call !== message.call),
        state.report,
      ),
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
