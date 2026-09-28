/**
 * Decisions: choices the harness makes, each computed from the facts.
 */

import { Schema } from "effect";
import { FailureText, Inputs, Seq, TurnId } from "./names.ts";

/** How a turn ended. */
export const Ending = Schema.Union([
  /** The model gave a final answer and no input was queued. */
  Schema.TaggedStruct("Answered", {}),
  /** A request for a model response failed. */
  Schema.TaggedStruct("Failed", { failure: FailureText }),
  /** A policy vetoed a request for a model response. */
  Schema.TaggedStruct("Vetoed", { reason: Schema.Json }),
]);
export type Ending = typeof Ending.Type;

export const Decision = Schema.Union([
  /**
   * The session is idle and input is queued, so a turn is to start with the inputs recorded at
   * `inputs`. An adapter starts it and reports `TurnStarted`.
   */
  Schema.TaggedStruct("TurnRequested", { inputs: Inputs }),
  /**
   * Inputs that arrived during `turn` were given to it, at a point between steps: after a tool
   * batch settled, or after a final answer.
   */
  Schema.TaggedStruct("InputDelivered", { turn: TurnId, inputs: Inputs }),
  /**
   * The harness asked the model for the next step of `turn`, sending the conversation through the
   * fact recorded at `through`. The model has seen those facts once it responds to this request.
   */
  Schema.TaggedStruct("ModelAsked", { turn: TurnId, through: Seq }),
  /**
   * Inputs queued during `turn` were discarded because the turn ended other than by an answer.
   * Recorded before `TurnEnded`.
   */
  Schema.TaggedStruct("InputDropped", { turn: TurnId, inputs: Inputs }),
  /** The turn ended. The session is idle until the next input arrives. */
  Schema.TaggedStruct("TurnEnded", { turn: TurnId, ending: Ending }),
  /**
   * The observation recorded at `observation` arrived in a state that does not expect it. It stays
   * recorded; the machine does not act on it.
   */
  Schema.TaggedStruct("ObservationNotExpected", { observation: Seq }),
]);
export type Decision = typeof Decision.Type;
