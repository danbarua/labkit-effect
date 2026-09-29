/**
 * Decisions: choices the harness makes, each computed from the facts.
 */

import { Schema } from "effect";
import { FailureText, Inputs, Seq, TurnId } from "./names.ts";
import { Received } from "./received.ts";

/** How a turn ended. */
export const Ending = Schema.Union([
  /** The model gave a final answer and no input was queued. */
  Schema.TaggedStruct("Answered", {}),
  /** A request for a model response failed. */
  Schema.TaggedStruct("Failed", { failure: FailureText }),
  /** A policy vetoed a request for a model response. */
  Schema.TaggedStruct("Vetoed", { reason: Received }),
  /** The turn was interrupted. */
  Schema.TaggedStruct("Interrupted", {}),
]);
export type Ending = typeof Ending.Type;

export const Decision = Schema.Union([
  /**
   * Inputs were given to `turn`: when it opened, or at a point between steps (after a tool batch
   * settled, or after a final answer).
   */
  Schema.TaggedStruct("InputDelivered", { turn: TurnId, inputs: Inputs }),
  /**
   * The harness asked the model for the next step of `turn`. The request is made from the facts
   * recorded before this one; which of them it sends is the conversation view's business.
   */
  Schema.TaggedStruct("ModelAsked", { turn: TurnId }),
  /**
   * Inputs queued during `turn` were discarded because the turn ended other than by an answer.
   */
  Schema.TaggedStruct("InputDropped", { turn: TurnId, inputs: Inputs }),
  /**
   * The window of the compaction recorded at `compaction` is in effect: requests to the model from
   * here on are made in it. Taken at once while no turn runs, and between the steps of a turn that
   * does.
   */
  Schema.TaggedStruct("WindowOpened", { compaction: Seq }),
  /**
   * The change of model recorded at `change` is in effect: requests to the model from here on go to
   * the model it names. Taken at once while no turn runs, and between the steps of a turn that does,
   * or once it has ended.
   */
  Schema.TaggedStruct("ModelChangeTaken", { change: Seq }),
  /** The turn ended. The session is idle until the next input arrives. */
  Schema.TaggedStruct("TurnEnded", { turn: TurnId, ending: Ending }),
  /**
   * The observation recorded at `observation` reached a machine whose state does not act on it. It
   * stays recorded; nothing changes.
   */
  Schema.TaggedStruct("ObservationNotExpected", { observation: Seq }),
  /**
   * The observation recorded at `observation` names a turn or a call no machine exists for. It stays
   * recorded; nothing changes.
   */
  Schema.TaggedStruct("ObservationUndelivered", { observation: Seq }),
]);
export type Decision = typeof Decision.Type;
