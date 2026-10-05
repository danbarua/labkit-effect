/**
 * Effect requests: messages that the core sends to ask for an action on the outside world.
 *
 * - The layers around the core carry out each request. They may first apply a policy that lets
 *   the request continue, vetoes it, or makes it wait.
 * - The result of a request arrives as an observation.
 * - The core does not request a turn's start: the layers around the core decide when a turn starts
 *   and report it as `TurnStarted`.
 */

import { Schema } from "effect";
import { CallId, ToolName, TurnId } from "./names.ts";
import { Received } from "./received.ts";

export const EffectRequest = Schema.Union([
  /** Ask the model for its next response in `turn`. */
  Schema.TaggedStruct("RequestModelResponse", { turn: TurnId }),
  /**
   * The model gave `turn` a response with no tool calls that is not marked `Unfinished`. Before the
   * turn ends, the layers around the core may give it more input, such as a turn-end hook's
   * feedback. They report `TurnEndReviewed` when they have finished.
   */
  Schema.TaggedStruct("BeforeTurnEnded", { turn: TurnId }),
  /** Run one tool call that the model proposed. */
  Schema.TaggedStruct("RunTool", { call: CallId, tool: ToolName, input: Received }),
  /**
   * Stop every request being carried out for `turn`. Each request under way reports how far it got:
   *
   * - a model request reports the response as far as it had arrived;
   * - a tool call reports how it ended, or that its end was not observed.
   */
  Schema.TaggedStruct("StopTurnWork", { turn: TurnId }),
]);
export type EffectRequest = typeof EffectRequest.Type;
