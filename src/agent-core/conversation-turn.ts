/**
 * A conversation turn: from the input that started it to the model's final answer. It runs steps
 * one after another; after a tool batch, or a response cut short, it goes on to the next. Input for the turn waits in its mailbox while a step runs, and is taken
 * between steps; between steps the turn posts `Proceed` to itself, which arrives after the waiting
 * input is taken, and then goes on. A compaction waits in the mailbox the same way, and is taken
 * between steps, or once the turn has ended. After a final answer it asks the layers around the core for
 * anything more first (`BeforeTurnEnded`, answered by `TurnEndReviewed`); it ends when no input was
 * taken by then, or when a step stops without an answer; input still waiting then is dropped. The
 * model's observations are addressed to the turn, which passes them to its current step. An
 * interruption ends the turn at once, from any state before it has ended.
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
import { becomes, type Step, type Table } from "./table.ts";

export type ConversationTurnState =
  | { readonly _tag: "NotStarted"; readonly turn: TurnId }
  /** Opened; taking its first input before the first step. */
  | { readonly _tag: "Opening"; readonly turn: TurnId }
  | { readonly _tag: "Stepping"; readonly turn: TurnId; readonly step: StepIndex }
  /** Between steps after a tool batch settled or a response was cut short. */
  | { readonly _tag: "Continuing"; readonly turn: TurnId; readonly step: StepIndex }
  /** Between steps after a final answer, with no input taken since. */
  | { readonly _tag: "AfterAnswer"; readonly turn: TurnId; readonly step: StepIndex }
  /** Between steps after a final answer, with input taken since. */
  | { readonly _tag: "AfterAnswerSteered"; readonly turn: TurnId; readonly step: StepIndex }
  | { readonly _tag: "Ended"; readonly turn: TurnId };

export type ConversationTurnMessage = ToConversationTurn | ModelObservation | TurnObservation;

type TurnStep = Step<ConversationTurnState, Send>;

export const openingConversationTurn = (turn: TurnId): ConversationTurnState => ({ _tag: "NotStarted", turn });

const proceed = (turn: TurnId): Send => toConversationTurn(turn, { _tag: "Proceed" });

const nextStep = (turn: TurnId, previous: number): TurnStep => {
  const step = StepIndex.make(previous + 1);
  return {
    state: { _tag: "Stepping", turn, step },
    decisions: [],
    requests: [],
    sends: [toTurnStep({ turn, index: step }, { _tag: "StepStart" })],
  };
};

/** The input is given to the turn. */
const take = (state: ConversationTurnState, input: Seq, next: ConversationTurnState = state): TurnStep => ({
  state: next,
  decisions: [{ _tag: "InputDelivered", turn: state.turn, inputs: [input] }],
  requests: [],
  sends: [],
});

/** After a tool batch, or a response cut short, the turn goes on once its waiting input is taken. */
const continuing = (state: Extract<ConversationTurnState, { _tag: "Stepping" }>): TurnStep => ({
  ...becomes({ _tag: "Continuing", turn: state.turn, step: state.step }),
  sends: [proceed(state.turn)],
});

/**
 * After an answer the layers around the core are asked for anything more before the turn ends
 * (`BeforeTurnEnded`); `TurnEndReviewed` then decides: input taken meanwhile means a next step,
 * none means the turn ends.
 */
const afterAnswer = (state: Extract<ConversationTurnState, { _tag: "Stepping" }>): TurnStep => ({
  ...becomes({ _tag: "AfterAnswer", turn: state.turn, step: state.step }),
  requests: [{ _tag: "BeforeTurnEnded", turn: state.turn }],
});

/** The compaction's window is in effect from here. */
const compact = (state: ConversationTurnState, compaction: Seq): TurnStep => ({
  ...becomes(state),
  decisions: [{ _tag: "WindowOpened", compaction }],
});

const interrupted = (state: ConversationTurnState): TurnStep => ended(state.turn, { _tag: "Interrupted" });

const passOn = (
  state: Extract<ConversationTurnState, { _tag: "Stepping" }>,
  message: ModelObservation,
): TurnStep => ({ ...becomes(state), sends: [toTurnStep({ turn: state.turn, index: state.step }, message)] });

const ended = (turn: TurnId, ending: Ending): TurnStep => ({
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
    Proceed: "ignored",
    StepToolsSettled: "ignored",
    StepAnswered: "ignored",
    StepCutShort: "ignored",
    StepStopped: "ignored",
    ModelResponded: "ignored",
    ModelFailed: "ignored",
    ModelAttemptFailed: "ignored",
    ModelVetoed: "ignored",
    TurnEndReviewed: "ignored",
    TurnHoldsExhausted: "ignored",
  },
  Opening: {
    TurnInterrupted: interrupted,
    TurnOpened: "ignored",
    Steer: (state, message) => take(state, message.input),
    Compact: (state, message) => compact(state, message.compaction),
    Proceed: (state) => nextStep(state.turn, 0),
    StepToolsSettled: "ignored",
    StepAnswered: "ignored",
    StepCutShort: "ignored",
    StepStopped: "ignored",
    ModelResponded: "ignored",
    ModelFailed: "ignored",
    ModelAttemptFailed: "ignored",
    ModelVetoed: "ignored",
    TurnEndReviewed: "ignored",
    TurnHoldsExhausted: "ignored",
  },
  Stepping: {
    TurnInterrupted: interrupted,
    TurnOpened: "ignored",
    Steer: "deferred",
    Compact: "deferred",
    Proceed: "ignored",
    StepToolsSettled: continuing,
    StepCutShort: continuing,
    StepAnswered: afterAnswer,
    StepStopped: (state, message) => ended(state.turn, message.ending),
    ModelResponded: passOn,
    ModelFailed: passOn,
    ModelAttemptFailed: passOn,
    ModelVetoed: passOn,
    TurnEndReviewed: "ignored",
    TurnHoldsExhausted: "ignored",
  },
  Continuing: {
    TurnInterrupted: interrupted,
    TurnOpened: "ignored",
    Steer: (state, message) => take(state, message.input),
    Compact: (state, message) => compact(state, message.compaction),
    Proceed: (state) => nextStep(state.turn, state.step),
    StepToolsSettled: "ignored",
    StepAnswered: "ignored",
    StepCutShort: "ignored",
    StepStopped: "ignored",
    ModelResponded: "ignored",
    ModelFailed: "ignored",
    ModelAttemptFailed: "ignored",
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
    Proceed: "ignored",
    TurnEndReviewed: (state) => ended(state.turn, { _tag: "Answered" }),
    /** Recorded; the review goes on, without the hooks. */
    TurnHoldsExhausted: (state) => becomes(state),
    StepToolsSettled: "ignored",
    StepAnswered: "ignored",
    StepCutShort: "ignored",
    StepStopped: "ignored",
    ModelResponded: "ignored",
    ModelFailed: "ignored",
    ModelAttemptFailed: "ignored",
    ModelVetoed: "ignored",
  },
  AfterAnswerSteered: {
    TurnInterrupted: interrupted,
    TurnOpened: "ignored",
    Steer: (state, message) => take(state, message.input),
    Compact: (state, message) => compact(state, message.compaction),
    Proceed: "ignored",
    TurnEndReviewed: (state) => nextStep(state.turn, state.step),
    TurnHoldsExhausted: (state) => becomes(state),
    StepToolsSettled: "ignored",
    StepAnswered: "ignored",
    StepCutShort: "ignored",
    StepStopped: "ignored",
    ModelResponded: "ignored",
    ModelFailed: "ignored",
    ModelAttemptFailed: "ignored",
    ModelVetoed: "ignored",
  },
  Ended: {
    TurnInterrupted: "ignored",
    TurnOpened: "ignored",
    /** Input still waiting when the turn ends is dropped. */
    Steer: (state, message) => ({
      ...becomes(state),
      decisions: [{ _tag: "InputDropped", turn: state.turn, inputs: [message.input] }],
    }),
    /** A compaction still waiting when the turn ends is taken: its window outlasts the turn. */
    Compact: (state, message) => compact(state, message.compaction),
    Proceed: "ignored",
    StepToolsSettled: "ignored",
    StepAnswered: "ignored",
    StepCutShort: "ignored",
    StepStopped: "ignored",
    ModelResponded: "ignored",
    ModelFailed: "ignored",
    ModelAttemptFailed: "ignored",
    ModelVetoed: "ignored",
    TurnEndReviewed: "ignored",
    TurnHoldsExhausted: "ignored",
  },
};
