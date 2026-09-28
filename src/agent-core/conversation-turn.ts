/**
 * A conversation turn: from the input that started it to the model's final answer. It runs steps
 * one after another. Between steps it collects any queued input from the inbox and gives it to the
 * next step. It ends when a step gives a final answer and nothing is queued, or when a step stops
 * without an answer. The model's observations are addressed to the turn, which passes them to its
 * current step.
 */

import type { Ending } from "./decision.ts";
import {
  type ModelObservation,
  type Send,
  type ToConversationTurn,
  toInbox,
  toTurnStep,
} from "./messages.ts";
import { StepIndex, type TurnId } from "./names.ts";
import { becomes, type Step, type Table } from "./table.ts";

export type ConversationTurnState =
  | { readonly _tag: "NotStarted"; readonly turn: TurnId }
  | { readonly _tag: "Stepping"; readonly turn: TurnId; readonly step: StepIndex }
  /** The step's tool calls settled; waiting for the inbox's mail before the next step. */
  | { readonly _tag: "CollectingAfterTools"; readonly turn: TurnId; readonly step: StepIndex }
  /** The step gave a final answer; waiting for the inbox's mail to know whether the turn goes on. */
  | { readonly _tag: "CollectingAfterAnswer"; readonly turn: TurnId; readonly step: StepIndex }
  | { readonly _tag: "Ended"; readonly turn: TurnId };

export type ConversationTurnMessage = ToConversationTurn | ModelObservation;

type TurnStep = Step<ConversationTurnState, Send>;

export const openingConversationTurn = (turn: TurnId): ConversationTurnState => ({ _tag: "NotStarted", turn });

const nextStep = (turn: TurnId, previous: number): TurnStep => {
  const step = StepIndex.make(previous + 1);
  return {
    state: { _tag: "Stepping", turn, step },
    decisions: [],
    requests: [],
    sends: [toTurnStep({ turn, index: step }, { _tag: "StepStart" })],
  };
};

const withMail = (
  state: { readonly turn: TurnId; readonly step: StepIndex },
  inputs: Extract<ToConversationTurn, { _tag: "Mail" }>["inputs"],
): TurnStep => {
  const next = nextStep(state.turn, state.step);
  return { ...next, decisions: [{ _tag: "InputDelivered", turn: state.turn, inputs }, ...next.decisions] };
};

const passOn = (
  state: Extract<ConversationTurnState, { _tag: "Stepping" }>,
  message: ModelObservation,
): TurnStep => ({ ...becomes(state), sends: [toTurnStep({ turn: state.turn, index: state.step }, message)] });

const collect = (
  state: Extract<ConversationTurnState, { _tag: "Stepping" }>,
  next: "CollectingAfterTools" | "CollectingAfterAnswer",
): TurnStep => ({ ...becomes({ _tag: next, turn: state.turn, step: state.step }), sends: [toInbox({ _tag: "CollectMail" })] });

const ended = (turn: TurnId, ending: Ending, told: Send): TurnStep => ({
  state: { _tag: "Ended", turn },
  decisions: [{ _tag: "TurnEnded", turn, ending }],
  requests: [],
  sends: [told],
});

export const conversationTurnTable: Table<ConversationTurnState, ConversationTurnMessage, Send> = {
  NotStarted: {
    TurnOpened: (state) => nextStep(state.turn, 0),
    Mail: "ignored",
    NoMail: "ignored",
    StepToolsSettled: "ignored",
    StepAnswered: "ignored",
    StepStopped: "ignored",
    ModelResponded: "ignored",
    ModelFailed: "ignored",
    ModelVetoed: "ignored",
  },
  Stepping: {
    TurnOpened: "ignored",
    Mail: "ignored",
    NoMail: "ignored",
    StepToolsSettled: (state) => collect(state, "CollectingAfterTools"),
    StepAnswered: (state) => collect(state, "CollectingAfterAnswer"),
    StepStopped: (state, message) => ended(state.turn, message.ending, toInbox({ _tag: "TurnStopped" })),
    ModelResponded: passOn,
    ModelFailed: passOn,
    ModelVetoed: passOn,
  },
  CollectingAfterTools: {
    TurnOpened: "ignored",
    Mail: (state, message) => withMail(state, message.inputs),
    NoMail: (state) => nextStep(state.turn, state.step),
    StepToolsSettled: "ignored",
    StepAnswered: "ignored",
    StepStopped: "ignored",
    ModelResponded: "ignored",
    ModelFailed: "ignored",
    ModelVetoed: "ignored",
  },
  CollectingAfterAnswer: {
    TurnOpened: "ignored",
    Mail: (state, message) => withMail(state, message.inputs),
    NoMail: (state) => ended(state.turn, { _tag: "Answered" }, toInbox({ _tag: "TurnAnswered" })),
    StepToolsSettled: "ignored",
    StepAnswered: "ignored",
    StepStopped: "ignored",
    ModelResponded: "ignored",
    ModelFailed: "ignored",
    ModelVetoed: "ignored",
  },
  Ended: {
    TurnOpened: "ignored",
    Mail: "ignored",
    NoMail: "ignored",
    StepToolsSettled: "ignored",
    StepAnswered: "ignored",
    StepStopped: "ignored",
    ModelResponded: "ignored",
    ModelFailed: "ignored",
    ModelVetoed: "ignored",
  },
};
