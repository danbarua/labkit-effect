/**
 * Decisions: choices the harness makes, each computed from the facts and the configuration.
 */

import { Schema } from "effect";
import { CallId, FailureText, Seq, TurnId } from "./names.ts";

/** Who allowed or refused a tool call: the configuration, or the user when asked. */
export const Authority = Schema.Literals(["configuration", "user"]);
export type Authority = typeof Authority.Type;

export const Decision = Schema.Union([
  /** The harness began a turn in response to the user's message recorded at `input`. */
  Schema.TaggedStruct("TurnStarted", { turn: TurnId, input: Seq }),
  /** The harness allowed a tool call. */
  Schema.TaggedStruct("ToolCallAllowed", { call: CallId, by: Authority }),
  /** The harness refused a tool call. The model is told it was refused. */
  Schema.TaggedStruct("ToolCallRefused", { call: CallId, by: Authority }),
  /** The turn ended with the model's answer. */
  Schema.TaggedStruct("TurnAnswered", { turn: TurnId }),
  /** The turn ended in failure. */
  Schema.TaggedStruct("TurnFailed", { turn: TurnId, failure: FailureText }),
  /**
   * The observation recorded at `observation` arrived in a state that does not expect it. It stays
   * recorded; the machine does not act on it.
   */
  Schema.TaggedStruct("ObservationNotExpected", { observation: Seq }),
]);
export type Decision = typeof Decision.Type;
