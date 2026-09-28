/**
 * Addresses, and the messages machines send each other. Messages between machines are not facts:
 * they are not recorded, and the facts they lead to are recorded by the machine that makes them.
 */

import type { Ending } from "./decision.ts";
import type { CallId, TurnId } from "./names.ts";
import type { Observation } from "./observation.ts";

export type Address =
  | { readonly _tag: "Session" }
  | { readonly _tag: "Turn"; readonly turn: TurnId }
  | { readonly _tag: "Call"; readonly call: CallId };

/** Observations delivered to the session. */
export type SessionObservation = Extract<
  Observation,
  { _tag: "SessionOpened" | "InputArrived" | "InputCancelled" | "TurnStarted" }
>;

/** Observations delivered to the turn they name. */
export type TurnObservation = Extract<Observation, { _tag: "ModelResponded" | "ModelFailed" | "ModelVetoed" }>;

/** Observations delivered to the call they name. */
export type CallObservation = Extract<Observation, { _tag: "ToolEnded" }>;

/** What a turn tells the session. */
export type ToSession =
  /** Every call of the turn's tool batch has settled. */
  | { readonly _tag: "ToolsSettled"; readonly turn: TurnId }
  /** The model gave a final answer. */
  | { readonly _tag: "Answered"; readonly turn: TurnId }
  /** The turn stopped without an answer. */
  | { readonly _tag: "TurnStopped"; readonly turn: TurnId; readonly ending: Exclude<Ending, { _tag: "Answered" }> };

/** What the session, or a call, tells a turn. */
export type ToTurn =
  /** The turn goes on to its next step. */
  | { readonly _tag: "NextStep" }
  /** One of the turn's calls settled. */
  | { readonly _tag: "CallSettled"; readonly call: CallId };

/** What a turn tells a call. */
export type ToCall =
  /** The call was proposed by `turn` and requested. */
  { readonly _tag: "CallOpened"; readonly turn: TurnId };

export type Send =
  | { readonly to: Extract<Address, { _tag: "Session" }>; readonly message: ToSession }
  | { readonly to: Extract<Address, { _tag: "Turn" }>; readonly message: ToTurn }
  | { readonly to: Extract<Address, { _tag: "Call" }>; readonly message: ToCall };

export const session: Extract<Address, { _tag: "Session" }> = { _tag: "Session" };

export function toSession(message: ToSession): Send {
  return { to: session, message };
}

export function toTurn(turn: TurnId, message: ToTurn): Send {
  return { to: { _tag: "Turn", turn }, message };
}

export function toCall(call: CallId, message: ToCall): Send {
  return { to: { _tag: "Call", call }, message };
}
