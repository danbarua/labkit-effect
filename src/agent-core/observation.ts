/**
 * Observations: what reaches the harness from outside, recorded as received.
 */

import { Schema } from "effect";
import {
  CallId,
  FailureText,
  ModelName,
  ModelText,
  ProviderName,
  SessionId,
  StopReason,
  ThinkingSignature,
  ThinkingText,
  ToolName,
  TurnId,
  UserText,
} from "./names.ts";

/** Whether a tool call waits for the user's permission. */
export const PermissionMode = Schema.Literals(["ask", "allow"]);
export type PermissionMode = typeof PermissionMode.Type;

export const Configuration = Schema.Struct({ permission: PermissionMode });
export type Configuration = typeof Configuration.Type;

/** One part of a model's response. */
export const ModelPart = Schema.Union([
  Schema.TaggedStruct("Text", { text: ModelText }),
  Schema.TaggedStruct("Thinking", { text: ThinkingText, signature: ThinkingSignature }),
  Schema.TaggedStruct("ToolCall", { call: CallId, tool: ToolName, input: Schema.Json }),
  /** A part the decoder does not recognise, holding what was received. */
  Schema.TaggedStruct("Unrecognised", { received: Schema.Json }),
]);
export type ModelPart = typeof ModelPart.Type;

/** How a tool call ended, as the tool reported it. */
export const ToolOutcome = Schema.Union([
  Schema.TaggedStruct("Succeeded", { output: Schema.Json }),
  Schema.TaggedStruct("Failed", { failure: FailureText }),
]);
export type ToolOutcome = typeof ToolOutcome.Type;

export const Observation = Schema.Union([
  /** A user opened a session with a configuration. */
  Schema.TaggedStruct("SessionOpened", { session: SessionId, configuration: Configuration }),
  /** A user wrote a message. */
  Schema.TaggedStruct("UserWrote", { text: UserText }),
  /**
   * A model responded. `parts` are the response's parts in the order received; `metadata` is
   * everything else the provider sent with it (usage, identifiers), as received.
   */
  Schema.TaggedStruct("ModelResponded", {
    turn: TurnId,
    provider: ProviderName,
    model: ModelName,
    parts: Schema.Array(ModelPart),
    stop: StopReason,
    metadata: Schema.Json,
  }),
  /** A request for a model response failed. */
  Schema.TaggedStruct("ModelFailed", { turn: TurnId, failure: FailureText }),
  /** The user answered a permission question about one tool call. */
  Schema.TaggedStruct("PermissionAnswered", {
    call: CallId,
    answer: Schema.Literals(["allow", "refuse"]),
  }),
  /** A tool call ended. */
  Schema.TaggedStruct("ToolEnded", { call: CallId, outcome: ToolOutcome }),
]);
export type Observation = typeof Observation.Type;
