/**
 * Observations: what reaches the harness from outside. A recorded observation is kept as
 * received; a captured observation is passed on for display and not kept.
 */

import { Schema } from "effect";
import {
  AgentName,
  CallId,
  FailureText,
  InputText,
  Inputs,
  ModelName,
  ModelText,
  ProviderName,
  Seq,
  SessionId,
  StopReason,
  ThinkingSignature,
  ThinkingText,
  ToolName,
  TurnId,
} from "./names.ts";

/** Whether a tool call waits for the user's permission. */
export const PermissionMode = Schema.Literals(["ask", "allow"]);
export type PermissionMode = typeof PermissionMode.Type;

export const Configuration = Schema.Struct({ permission: PermissionMode });
export type Configuration = typeof Configuration.Type;

/** Who sent an input: the user, the system (a wake-up, a scheduled prompt), or another agent. */
export const InputSource = Schema.Union([
  Schema.TaggedStruct("User", {}),
  Schema.TaggedStruct("System", {}),
  Schema.TaggedStruct("Agent", { agent: AgentName }),
]);
export type InputSource = typeof InputSource.Type;

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

/** Observations recorded as facts. */
export const Observation = Schema.Union([
  /** A session was opened with a configuration. */
  Schema.TaggedStruct("SessionOpened", { session: SessionId, configuration: Configuration }),
  /** An input arrived. It can arrive at any time, including while a turn is under way. */
  Schema.TaggedStruct("InputArrived", { from: InputSource, text: InputText }),
  /** A turn started, with the inputs recorded at `inputs`, as a `StartTurn` request asked. */
  Schema.TaggedStruct("TurnStarted", { turn: TurnId, inputs: Inputs }),
  /** The input recorded at `input`, still queued, was cancelled by its sender. */
  Schema.TaggedStruct("InputCancelled", { input: Seq }),
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

/** Observations captured for display and not recorded. */
export const CapturedObservation = Schema.Union([
  /** Part of a model response while it is still arriving, as received. */
  Schema.TaggedStruct("ModelStreamed", { turn: TurnId, chunk: Schema.Json }),
]);
export type CapturedObservation = typeof CapturedObservation.Type;
