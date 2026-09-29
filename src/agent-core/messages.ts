/**
 * The messages machines send each other, and the observations each kind of machine receives.
 * Messages between machines are not facts: they are not recorded, and the facts they lead to are
 * recorded by the machine that makes them.
 */

import type { Ending } from "./decision.ts";
import type { CallId, Seq, StepIndex, TurnId } from "./names.ts";
import type { Observation } from "./observation.ts";

/** A step, by its turn and its place in that turn. */
export interface StepAddress {
  readonly turn: TurnId;
  readonly index: StepIndex;
}

/** Observations delivered to the agent. */
export type AgentObservation = Extract<
  Observation,
  { _tag: "SessionOpened" | "InputArrived" | "Compacted" | "TurnStarted" }
>;

/** Observations delivered to the turn they name, which passes them to its current step. */
export type ModelObservation = Extract<Observation, { _tag: "ModelResponded" | "ModelFailed" | "ModelVetoed" }>;

/** Observations delivered to the turn they name, for the turn itself. */
export type TurnObservation = Extract<Observation, { _tag: "TurnEndReviewed" | "TurnInterrupted" }>;

/** Observations delivered to the call they name. */
export type CallObservation = Extract<Observation, { _tag: "ToolEnded" }>;

/** What a conversation turn tells the agent. */
export type ToAgent =
  /** The turn ended. */
  { readonly _tag: "TurnFinished" };

/** What the agent, a step, or the turn itself tells a conversation turn. */
export type ToConversationTurn =
  /** The turn started. */
  | { readonly _tag: "TurnOpened" }
  /** Input for the turn: the input recorded at `input`. */
  | { readonly _tag: "Steer"; readonly input: Seq }
  /** The compaction recorded at `compaction`, for the turn to take between steps. */
  | { readonly _tag: "Compact"; readonly compaction: Seq }
  /** Posted by the turn to itself: its mail is taken, so it goes on. */
  | { readonly _tag: "Proceed" }
  /** Every call of the step's tool batch settled. */
  | { readonly _tag: "StepToolsSettled" }
  /** The model gave a final answer in the step. */
  | { readonly _tag: "StepAnswered" }
  /** The model's response was cut short with no tool calls; the turn goes on to ask again. */
  | { readonly _tag: "StepCutShort" }
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
  | { readonly _tag: "ToAgent"; readonly message: ToAgent }
  | { readonly _tag: "ToConversationTurn"; readonly turn: TurnId; readonly message: ToConversationTurn }
  | { readonly _tag: "ToTurnStep"; readonly step: StepAddress; readonly message: ToTurnStep | ModelObservation }
  | { readonly _tag: "ToCall"; readonly call: CallId; readonly message: ToCall };

export function toAgent(message: ToAgent): Send {
  return { _tag: "ToAgent", message };
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
