/**
 * Effect requests: messages the core sends asking for an action on the outside world. An adapter
 * carries each one out; its result arrives as an Observation.
 */

import { Schema } from "effect";
import { CallId, Inputs, ToolName, TurnId } from "./names.ts";

export const EffectRequest = Schema.Union([
  /** Start a turn with the inputs recorded at `inputs`. The adapter chooses the turn's identity. */
  Schema.TaggedStruct("StartTurn", { inputs: Inputs }),
  /** Ask the model for its next response in `turn`, given the conversation so far. */
  Schema.TaggedStruct("RequestModelResponse", { turn: TurnId }),
  /** Ask the user whether one tool call may run. */
  Schema.TaggedStruct("AskPermission", { call: CallId, tool: ToolName, input: Schema.Json }),
  /** Run one tool call. */
  Schema.TaggedStruct("RunTool", { call: CallId, tool: ToolName, input: Schema.Json }),
]);
export type EffectRequest = typeof EffectRequest.Type;
