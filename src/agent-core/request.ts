/**
 * Effect requests: messages the core sends asking for an action on the outside world. The layers
 * around the core carry each one out, and may first apply a policy that lets it continue, vetoes
 * it, or delays it. Its result arrives as an Observation. When a turn starts is decided by the
 * layers around the core, which report it as `TurnStarted`.
 */

import { Schema } from "effect";
import { CallId, ToolName, TurnId } from "./names.ts";
import { Received } from "./received.ts";

export const EffectRequest = Schema.Union([
  /** Ask the model for its next response in `turn`, given the conversation so far. */
  Schema.TaggedStruct("RequestModelResponse", { turn: TurnId }),
  /**
   * The model answered `turn` and nothing was waiting: before the turn ends, the layers around the
   * core may give it more input (a hook's feedback, say). They report `TurnEndReviewed` when done.
   */
  Schema.TaggedStruct("BeforeTurnEnded", { turn: TurnId }),
  /** Run one tool call the model proposed. */
  Schema.TaggedStruct("RunTool", { call: CallId, tool: ToolName, input: Received }),
]);
export type EffectRequest = typeof EffectRequest.Type;
