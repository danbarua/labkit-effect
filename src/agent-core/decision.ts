/**
 * Decisions: choices the harness makes, each computed from the facts and the configuration.
 */

import { Schema } from "effect";
import { CallId, FailureText, Inputs, Seq, TurnId } from "./names.ts";

/** Who allowed or refused a tool call: the configuration, or the user when asked. */
export const Authority = Schema.Literals(["configuration", "user"]);
export type Authority = typeof Authority.Type;

export const Decision = Schema.Union([
  /**
   * No turn is under way and input is queued, so a turn is to start with the inputs recorded at
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
  /** The harness allowed a tool call. */
  Schema.TaggedStruct("ToolCallAllowed", { call: CallId, by: Authority }),
  /** The harness refused a tool call. The model is told it was refused. */
  Schema.TaggedStruct("ToolCallRefused", { call: CallId, by: Authority }),
  /** The turn ended with the model's final answer and no input queued. */
  Schema.TaggedStruct("TurnAnswered", { turn: TurnId }),
  /**
   * Inputs queued during `turn` were discarded because the turn ended in failure. Recorded before
   * `TurnFailed`.
   */
  Schema.TaggedStruct("InputDropped", { turn: TurnId, inputs: Inputs }),
  /** The turn ended in failure. No turn is under way until the next input arrives. */
  Schema.TaggedStruct("TurnFailed", { turn: TurnId, failure: FailureText }),
  /**
   * The observation recorded at `observation` arrived in a state that does not expect it. It stays
   * recorded; the machine does not act on it.
   */
  Schema.TaggedStruct("ObservationNotExpected", { observation: Seq }),
]);
export type Decision = typeof Decision.Type;
