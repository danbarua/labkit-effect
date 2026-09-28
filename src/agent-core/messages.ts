/**
 * The messages machines send each other, and the observations each kind of machine receives.
 * Messages between machines are not facts: they are not recorded, and the facts they lead to are
 * recorded by the machine that makes them.
 */

import type { Ending } from "./decision.ts";
import type { CallId, Inputs, StepIndex, TurnId } from "./names.ts";
import type { Observation } from "./observation.ts";

/** A step, by its turn and its place in that turn. */
export interface StepAddress {
  readonly turn: TurnId;
  readonly index: StepIndex;
}

/** Observations delivered to the inbox. */
export type InboxObservation = Extract<
  Observation,
  { _tag: "SessionOpened" | "InputArrived" | "InputCancelled" | "TurnStarted" }
>;

/** Observations delivered to the turn they name, which passes them to its current step. */
export type ModelObservation = Extract<Observation, { _tag: "ModelResponded" | "ModelFailed" | "ModelVetoed" }>;

/** Observations delivered to the call they name. */
export type CallObservation = Extract<Observation, { _tag: "ToolEnded" }>;

/** What a conversation turn tells the inbox. */
export type ToInbox =
  /** The turn is between steps: give it the queued input, if any. */
  | { readonly _tag: "CollectMail" }
  /** The turn ended with an answer. */
  | { readonly _tag: "TurnAnswered" }
  /** The turn ended without an answer. */
  | { readonly _tag: "TurnStopped" };

/** What the inbox, or a step, tells a conversation turn. */
export type ToConversationTurn =
  /** The adapter started the turn. */
  | { readonly _tag: "TurnOpened" }
  /** The queued input, given to the turn. */
  | { readonly _tag: "Mail"; readonly inputs: Inputs }
  /** Nothing is queued. */
  | { readonly _tag: "NoMail" }
  /** Every call of the step's tool batch settled. */
  | { readonly _tag: "StepToolsSettled" }
  /** The model gave a final answer in the step. */
  | { readonly _tag: "StepAnswered" }
  /** The step stopped without an answer. */
  | { readonly _tag: "StepStopped"; readonly ending: Exclude<Ending, { _tag: "Answered" }> };

/** What a conversation turn, or a call, tells a step. */
export type ToTurnStep =
  /** The step begins. */
  | { readonly _tag: "StepStart" }
  /** One of the step's calls settled. */
  | { readonly _tag: "CallSettled"; readonly call: CallId };

/** What a step tells a call. */
export type ToCall =
  /** The call was proposed in `step` and requested. */
  { readonly _tag: "CallOpened"; readonly step: StepAddress };

/** A message from one machine to another, tagged with the kind of machine it goes to. */
export type Send =
  | { readonly _tag: "ToInbox"; readonly message: ToInbox }
  | { readonly _tag: "ToConversationTurn"; readonly turn: TurnId; readonly message: ToConversationTurn }
  | { readonly _tag: "ToTurnStep"; readonly step: StepAddress; readonly message: ToTurnStep | ModelObservation }
  | { readonly _tag: "ToCall"; readonly call: CallId; readonly message: ToCall };

export function toInbox(message: ToInbox): Send {
  return { _tag: "ToInbox", message };
}

export function toConversationTurn(turn: TurnId, message: ToConversationTurn): Send {
  return { _tag: "ToConversationTurn", turn, message };
}

export function toTurnStep(step: StepAddress, message: ToTurnStep | ModelObservation): Send {
  return { _tag: "ToTurnStep", step, message };
}

export function toCall(call: CallId, message: ToCall): Send {
  return { _tag: "ToCall", call, message };
}
