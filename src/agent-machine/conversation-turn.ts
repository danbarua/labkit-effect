/**
 * A conversation turn: from the input that started it to the model's final answer.
 *
 * - The turn runs steps one after another. After a tool batch settles, or after a response marked
 *   `Unfinished`, it starts the next step.
 * - Input for the turn waits in the turn's mailbox while a step runs, and is taken between steps.
 *   Between steps the turn sends itself `Proceed`, which arrives after the waiting input has been
 *   taken; on `Proceed` the turn starts the next step.
 * - A compaction window or a change of model waits in the mailbox the same way, and is taken
 *   between steps or when the turn ends.
 * - After a response with no tool calls that is not marked `Unfinished`, the turn requests
 *   `BeforeTurnEnded`, which the layers around the core answer with `TurnEndReviewed`. If no input
 *   was taken by then, the turn ends.
 * - A step that stops without a response (a failed or vetoed request) ends the turn. Input still
 *   waiting when the turn ends is dropped.
 * - The model's observations are addressed to the turn, which passes them to its current step.
 * - An interruption between steps ends the turn at once. An interruption during a step stops the
 *   step's requests, and the turn ends when the step has heard how far each got.
 */

import type { Ending } from "./decision.ts";
import {
  type ModelObservation,
  type Send,
  type ToConversationTurn,
  type TurnObservation,
  toAgent,
  toConversationTurn,
  toTurnStep,
} from "./messages.ts";
import { type Seq, StepIndex, type TurnId } from "./names.ts";
import { becomes, type Table, type TransitionResult } from "./table.ts";

export type ConversationTurnState =
  | { readonly _tag: "NotStarted"; readonly turn: TurnId }
  /** Opened: the turn takes its first input before the first step. */
  | { readonly _tag: "Opening"; readonly turn: TurnId }
  | { readonly _tag: "Stepping"; readonly turn: TurnId; readonly step: StepIndex }
  /** Between steps, after a tool batch settled or after a response marked `Unfinished`. */
  | { readonly _tag: "Continuing"; readonly turn: TurnId; readonly step: StepIndex }
  /**
   * Between steps, after a response with no tool calls (a final answer, or a response cut short),
   * with no input taken since. `ending` is how the turn ends if no input is taken.
   */
  | { readonly _tag: "AfterAnswer"; readonly turn: TurnId; readonly step: StepIndex; readonly ending: LastResponse }
  /** Between steps, after a response with no tool calls, with input taken since. */
  | { readonly _tag: "AfterAnswerSteered"; readonly turn: TurnId; readonly step: StepIndex }
  /**
   * Interrupted while a step was under way: the turn has requested `StopTurnWork`, and ends when the
   * step has heard how far each request got.
   */
  | { readonly _tag: "Interrupting"; readonly turn: TurnId; readonly step: StepIndex }
  | { readonly _tag: "Ended"; readonly turn: TurnId };

/** How a turn ends when its last response had no tool calls and no input follows it. */
type LastResponse = Extract<Ending, { _tag: "Completed" | "Incomplete" | "CutShort" }>;

export type ConversationTurnMessage = ToConversationTurn | ModelObservation | TurnObservation;

type TurnResult = TransitionResult<ConversationTurnState, Send>;

export const openingConversationTurn = (turn: TurnId): ConversationTurnState => ({ _tag: "NotStarted", turn });

const proceed = (turn: TurnId): Send => toConversationTurn(turn, { _tag: "Proceed" });

const nextStep = (turn: TurnId, previous: number): TurnResult => {
  const step = StepIndex.make(previous + 1);
  return {
    state: { _tag: "Stepping", turn, step },
    decisions: [],
    requests: [],
    sends: [toTurnStep({ turn, index: step }, { _tag: "StepStart" })],
  };
};

/** Gives the input to the turn (`InputDelivered`). */
const take = (state: ConversationTurnState, input: Seq, next: ConversationTurnState = state): TurnResult => ({
  state: next,
  decisions: [{ _tag: "InputDelivered", turn: state.turn, inputs: [input] }],
  requests: [],
  sends: [],
});

/** After a tool batch or an `Unfinished` response, the turn starts the next step once its waiting input is taken. */
const continuing = (state: Extract<ConversationTurnState, { _tag: "Stepping" }>): TurnResult => ({
  ...becomes({ _tag: "Continuing", turn: state.turn, step: state.step }),
  sends: [proceed(state.turn)],
});

/**
 * After a response with no tool calls that is not marked `Unfinished`, the turn requests
 * `BeforeTurnEnded`. On `TurnEndReviewed`:
 *
 * - if input was taken meanwhile, the turn starts the next step;
 * - otherwise the turn ends as `ending`.
 *
 * A response cut short is not followed by another request unless input gives the model something
 * new to answer.
 */
const afterAnswer =
  (ending: LastResponse) =>
  (state: Extract<ConversationTurnState, { _tag: "Stepping" }>): TurnResult => ({
    ...becomes({ _tag: "AfterAnswer", turn: state.turn, step: state.step, ending }),
    requests: [{ _tag: "BeforeTurnEnded", turn: state.turn }],
  });

/** Records `WindowOpened`: the compaction's window is in effect from here. */
const compact = (state: ConversationTurnState, compaction: Seq): TurnResult => ({
  ...becomes(state),
  decisions: [{ _tag: "WindowOpened", compaction }],
});

/** Records `ModelChangeTaken`: the change of model is in effect from here. */
const changeModel = (state: ConversationTurnState, change: Seq): TurnResult => ({
  ...becomes(state),
  decisions: [{ _tag: "ModelChangeTaken", change }],
});

/** No step is under way: the turn ends at once and requests `StopTurnWork` for anything still carried out for it. */
const interrupted = (state: ConversationTurnState): TurnResult => ({
  ...ended(state.turn, { _tag: "Interrupted" }),
  requests: [{ _tag: "StopTurnWork", turn: state.turn }],
});

/** A step is under way: the turn requests `StopTurnWork` and waits to hear how far each request got. */
const interrupting = (state: Extract<ConversationTurnState, { _tag: "Stepping" }>): TurnResult => ({
  ...becomes({ _tag: "Interrupting", turn: state.turn, step: state.step }),
  requests: [{ _tag: "StopTurnWork", turn: state.turn }],
});

const passOn = (
  state: Extract<ConversationTurnState, { _tag: "Stepping" | "Interrupting" }>,
  message: ModelObservation,
): TurnResult => ({ ...becomes(state), sends: [toTurnStep({ turn: state.turn, index: state.step }, message)] });

const endInterrupted = (state: ConversationTurnState): TurnResult => ended(state.turn, { _tag: "Interrupted" });

const ended = (turn: TurnId, ending: Ending): TurnResult => ({
  state: { _tag: "Ended", turn },
  decisions: [{ _tag: "TurnEnded", turn, ending }],
  requests: [],
  sends: [toAgent({ _tag: "TurnFinished" })],
});

export const conversationTurnTable: Table<ConversationTurnState, ConversationTurnMessage, Send> = {
  NotStarted: {
    TurnInterrupted: interrupted,
    TurnOpened: (state) => ({ ...becomes({ _tag: "Opening", turn: state.turn }), sends: [proceed(state.turn)] }),
    Steer: "deferred",
    Compact: "deferred",
    ChangeModel: "deferred",
    Proceed: "ignored",
    StepToolsSettled: "ignored",
    StepAnswered: "ignored",
    StepUnanswered: "ignored",
    StepCutShort: "ignored",
    StepUnfinished: "ignored",
    StepStopped: "ignored",
    ModelResponded: "ignored",
    ModelFailed: "ignored",
    ModelAttemptFailed: "ignored",
    NoticeInserted: "ignored",
    ModelRequestDispatched: "ignored",
    SettingAdjusted: "ignored",
    ToolCallArrived: "ignored",
    ModelVetoed: "ignored",
    TurnEndReviewed: "ignored",
    TurnHoldsExhausted: "ignored",
  },
  Opening: {
    TurnInterrupted: interrupted,
    TurnOpened: "ignored",
    Steer: (state, message) => take(state, message.input),
    Compact: (state, message) => compact(state, message.compaction),
    ChangeModel: (state, message) => changeModel(state, message.change),
    Proceed: (state) => nextStep(state.turn, 0),
    StepToolsSettled: "ignored",
    StepAnswered: "ignored",
    StepUnanswered: "ignored",
    StepCutShort: "ignored",
    StepUnfinished: "ignored",
    StepStopped: "ignored",
    ModelResponded: "ignored",
    ModelFailed: "ignored",
    ModelAttemptFailed: "ignored",
    NoticeInserted: "ignored",
    ModelRequestDispatched: "ignored",
    SettingAdjusted: "ignored",
    ToolCallArrived: "ignored",
    ModelVetoed: "ignored",
    TurnEndReviewed: "ignored",
    TurnHoldsExhausted: "ignored",
  },
  Stepping: {
    TurnInterrupted: interrupting,
    TurnOpened: "ignored",
    Steer: "deferred",
    Compact: "deferred",
    ChangeModel: "deferred",
    Proceed: "ignored",
    StepToolsSettled: continuing,
    StepCutShort: afterAnswer({ _tag: "CutShort" }),
    StepUnfinished: continuing,
    StepAnswered: (state) => {
      const next = afterAnswer({ _tag: "Completed" })(state);
      return { ...next, decisions: [{ _tag: "TurnCompleted", turn: state.turn }] };
    },
    StepUnanswered: (state) => {
      const next = afterAnswer({ _tag: "Incomplete" })(state);
      return { ...next, decisions: [{ _tag: "TurnIncomplete", turn: state.turn }] };
    },
    StepStopped: (state, message) => ended(state.turn, message.ending),
    ModelResponded: passOn,
    ModelFailed: passOn,
    ModelAttemptFailed: passOn,
    NoticeInserted: passOn,
    ModelRequestDispatched: passOn,
    SettingAdjusted: passOn,
    ToolCallArrived: passOn,
    ModelVetoed: passOn,
    TurnEndReviewed: "ignored",
    TurnHoldsExhausted: "ignored",
  },
  Continuing: {
    TurnInterrupted: interrupted,
    TurnOpened: "ignored",
    Steer: (state, message) => take(state, message.input),
    Compact: (state, message) => compact(state, message.compaction),
    ChangeModel: (state, message) => changeModel(state, message.change),
    Proceed: (state) => nextStep(state.turn, state.step),
    StepToolsSettled: "ignored",
    StepAnswered: "ignored",
    StepUnanswered: "ignored",
    StepCutShort: "ignored",
    StepUnfinished: "ignored",
    StepStopped: "ignored",
    ModelResponded: "ignored",
    ModelFailed: "ignored",
    ModelAttemptFailed: "ignored",
    NoticeInserted: "ignored",
    ModelRequestDispatched: "ignored",
    SettingAdjusted: "ignored",
    ToolCallArrived: "ignored",
    ModelVetoed: "ignored",
    TurnEndReviewed: "ignored",
    TurnHoldsExhausted: "ignored",
  },
  AfterAnswer: {
    TurnInterrupted: interrupted,
    TurnOpened: "ignored",
    Steer: (state, message) =>
      take(state, message.input, { _tag: "AfterAnswerSteered", turn: state.turn, step: state.step }),
    Compact: (state, message) => compact(state, message.compaction),
    ChangeModel: (state, message) => changeModel(state, message.change),
    Proceed: "ignored",
    TurnEndReviewed: (state) => ended(state.turn, state.ending),
    /** Changes nothing: the review continues without the hooks, and `TurnEndReviewed` follows. */
    TurnHoldsExhausted: (state) => becomes(state),
    StepToolsSettled: "ignored",
    StepAnswered: "ignored",
    StepUnanswered: "ignored",
    StepCutShort: "ignored",
    StepUnfinished: "ignored",
    StepStopped: "ignored",
    ModelResponded: "ignored",
    ModelFailed: "ignored",
    ModelAttemptFailed: "ignored",
    NoticeInserted: "ignored",
    ModelRequestDispatched: "ignored",
    SettingAdjusted: "ignored",
    ToolCallArrived: "ignored",
    ModelVetoed: "ignored",
  },
  AfterAnswerSteered: {
    TurnInterrupted: interrupted,
    TurnOpened: "ignored",
    Steer: (state, message) => take(state, message.input),
    Compact: (state, message) => compact(state, message.compaction),
    ChangeModel: (state, message) => changeModel(state, message.change),
    Proceed: "ignored",
    TurnEndReviewed: (state) => nextStep(state.turn, state.step),
    TurnHoldsExhausted: (state) => becomes(state),
    StepToolsSettled: "ignored",
    StepAnswered: "ignored",
    StepUnanswered: "ignored",
    StepCutShort: "ignored",
    StepUnfinished: "ignored",
    StepStopped: "ignored",
    ModelResponded: "ignored",
    ModelFailed: "ignored",
    ModelAttemptFailed: "ignored",
    NoticeInserted: "ignored",
    ModelRequestDispatched: "ignored",
    SettingAdjusted: "ignored",
    ToolCallArrived: "ignored",
    ModelVetoed: "ignored",
  },
  Interrupting: {
    TurnInterrupted: "ignored",
    TurnOpened: "ignored",
    /** A waiting message is handled when the turn has ended. */
    Steer: "deferred",
    Compact: "deferred",
    ChangeModel: "deferred",
    Proceed: "ignored",
    /** The step has heard from every request it made, so the turn ends. */
    StepToolsSettled: endInterrupted,
    StepAnswered: endInterrupted,
    StepUnanswered: endInterrupted,
    StepCutShort: endInterrupted,
    StepUnfinished: endInterrupted,
    StepStopped: endInterrupted,
    ModelResponded: passOn,
    ModelFailed: passOn,
    ModelAttemptFailed: passOn,
    NoticeInserted: passOn,
    ModelRequestDispatched: passOn,
    SettingAdjusted: passOn,
    ToolCallArrived: passOn,
    ModelVetoed: passOn,
    TurnEndReviewed: "ignored",
    TurnHoldsExhausted: "ignored",
  },
  Ended: {
    TurnInterrupted: "ignored",
    TurnOpened: "ignored",
    /** Input still waiting when the turn ends is dropped. */
    Steer: (state, message) => ({
      ...becomes(state),
      decisions: [{ _tag: "InputDropped", turn: state.turn, inputs: [message.input] }],
    }),
    /** A compaction still waiting when the turn ends is taken, because its window outlasts the turn. */
    Compact: (state, message) => compact(state, message.compaction),
    ChangeModel: (state, message) => changeModel(state, message.change),
    Proceed: "ignored",
    StepToolsSettled: "ignored",
    StepAnswered: "ignored",
    StepUnanswered: "ignored",
    StepCutShort: "ignored",
    StepUnfinished: "ignored",
    StepStopped: "ignored",
    ModelResponded: "ignored",
    ModelFailed: "ignored",
    ModelAttemptFailed: "ignored",
    NoticeInserted: "ignored",
    ModelRequestDispatched: "ignored",
    SettingAdjusted: "ignored",
    ToolCallArrived: "ignored",
    ModelVetoed: "ignored",
    TurnEndReviewed: "ignored",
    TurnHoldsExhausted: "ignored",
  },
};
