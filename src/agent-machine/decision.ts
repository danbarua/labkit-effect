/**
 * Decisions: choices that the core makes. The core's machines compute each decision from the facts.
 */

import { Schema } from "effect";
import { FailureText, Inputs, Seq, TurnId, StepIndex } from "./names.ts";
import { Received } from "./received.ts";

/** How a turn ended. */
export const Ending = Schema.Union([
  /** The model's last response was its answer (`TurnCompleted`), and no input was given to the turn after it. */
  Schema.TaggedStruct("Completed", {}),
  /**
   * The model's last response was whole, with no tool calls, and held only thinking or commentary,
   * no answer text (`TurnIncomplete`). No input was given to the turn after it.
   */
  Schema.TaggedStruct("Incomplete", {}),
  /**
   * The model's last response had no tool calls and an ending other than `Complete` or `Unfinished`
   * (for example, a length limit cut it short, or the provider refused it). No input was given to
   * the turn after it.
   */
  Schema.TaggedStruct("CutShort", {}),
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
   * The model answered `turn`: its response had answer text and no tool calls. The turn ends
   * (`TurnEnded`) unless the layers around the core give it more input first (`BeforeTurnEnded`).
   */
  Schema.TaggedStruct("TurnCompleted", { turn: TurnId }),
  /**
   * The model's response to `turn` was whole, with no tool calls and no answer text. The turn ends
   * as it does after `TurnCompleted`, unless a turn-end hook gives it more input.
   */
  Schema.TaggedStruct("TurnIncomplete", { turn: TurnId }),
  /**
   * Inputs were given to `turn`: when the turn opened, or between steps (after a tool batch
   * settled, or after a response with no tool calls).
   */
  Schema.TaggedStruct("InputDelivered", { turn: TurnId, inputs: Inputs }),
  /**
   * The core asks the model for `turn`'s first step, with a request that carries the turn's input.
   * The layers around the core make the request from the facts recorded before this decision; the
   * conversation view decides which of those facts the request sends.
   */
  Schema.TaggedStruct("AskModel", { turn: TurnId }),
  /**
   * The core tells the model the outcome of `turn`'s previous step (its tool calls' results, and
   * input given between steps) and asks it for `step`, the turn's next step. The request is made as
   * for `AskModel`.
   */
  Schema.TaggedStruct("TellModel", { turn: TurnId, step: StepIndex }),
  /** Inputs waiting in `turn`'s mailbox were discarded, because the turn ended other than by an answer. */
  Schema.TaggedStruct("InputDropped", { turn: TurnId, inputs: Inputs }),
  /**
   * The window of the compaction recorded at `compaction` is in effect: requests to the model from
   * here on are made in the window. The core takes a window at once while no turn runs; while a
   * turn runs, the core takes it between steps or when the turn ends.
   */
  Schema.TaggedStruct("WindowOpened", { compaction: Seq }),
  /**
   * The change of model recorded at `change` is in effect: requests from here on go to the model
   * that the change names. The core takes a change at once while no turn runs; while a turn runs,
   * the core takes it between steps or when the turn ends.
   */
  Schema.TaggedStruct("ModelChangeTaken", { change: Seq }),
  /** The turn ended. No turn runs until the next input arrives. */
  Schema.TaggedStruct("TurnEnded", { turn: TurnId, ending: Ending }),
  /**
   * The observation recorded at `observation` reached a machine whose state does not act on it. The
   * observation stays recorded, and no machine changes state.
   */
  Schema.TaggedStruct("ObservationNotExpected", { observation: Seq }),
  /**
   * The observation recorded at `observation` names a turn or a call that no machine exists for.
   * The observation stays recorded, and no machine changes state.
   */
  Schema.TaggedStruct("ObservationUndelivered", { observation: Seq }),
]);
export type Decision = typeof Decision.Type;
