/**
 * Decisions: choices the harness makes, each computed from the facts and the configuration.
 */

import { Schema } from "effect";
import { CallId, FailureText, Seq, TurnId } from "./names.ts";

/** Who allowed or refused a tool call: the configuration, or the user when asked. */
export const Authority = Schema.Literals(["configuration", "user"]);
export type Authority = typeof Authority.Type;

/** The positions of queued inputs in the journal, oldest first. At least one. */
export const Inputs = Schema.NonEmptyArray(Seq);
export type Inputs = typeof Inputs.Type;

export const Decision = Schema.Union([
  /** A turn began, with the queued inputs recorded at `inputs`. */
  Schema.TaggedStruct("TurnStarted", { turn: TurnId, inputs: Inputs }),
  /**
   * Inputs that arrived during `turn` were given to it, at a point between steps: after a tool
   * batch settled, or after a final answer.
   */
  Schema.TaggedStruct("InputDelivered", { turn: TurnId, inputs: Inputs }),
  /** The harness asked the model for the next step of `turn`. */
  Schema.TaggedStruct("ModelAsked", { turn: TurnId }),
  /** The harness allowed a tool call. */
  Schema.TaggedStruct("ToolCallAllowed", { call: CallId, by: Authority }),
  /** The harness refused a tool call. The model is told it was refused. */
  Schema.TaggedStruct("ToolCallRefused", { call: CallId, by: Authority }),
  /** The turn ended with the model's final answer and no input queued. */
  Schema.TaggedStruct("TurnAnswered", { turn: TurnId }),
  /** The turn ended in failure. Queued inputs stay queued. */
  Schema.TaggedStruct("TurnFailed", { turn: TurnId, failure: FailureText }),
  /**
   * The observation recorded at `observation` arrived in a state that does not expect it. It stays
   * recorded; the machine does not act on it.
   */
  Schema.TaggedStruct("ObservationNotExpected", { observation: Seq }),
]);
export type Decision = typeof Decision.Type;
