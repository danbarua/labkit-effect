/**
 * Observations: what reaches the harness from outside. A recorded observation is kept as
 * received; a captured observation is passed on for display and not kept.
 */

import { Schema } from "effect";
import { Received } from "./received.ts";
import {
  AgentName,
  CallId,
  FailureText,
  InputText,
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
  WindowId,
} from "./names.ts";

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
  Schema.TaggedStruct("ToolCall", { call: CallId, tool: ToolName, input: Received }),
  /** A part the decoder does not recognise, holding what was received. */
  Schema.TaggedStruct("Unrecognised", { received: Received }),
]);
export type ModelPart = typeof ModelPart.Type;

/** Why a tool call failed. Code that only needs to know whether a call succeeded ignores it. */
export const ToolFailure = Schema.Union([
  /** The tool ran and reported an error. */
  Schema.TaggedStruct("Reported", { error: Received }),
  /** No tool has the name the model called. */
  Schema.TaggedStruct("NotFound", {}),
  /** The tool did not accept the input it was given. */
  Schema.TaggedStruct("InputRejected", { problem: FailureText }),
  /** A policy vetoed the call before it ran, for the reason it gave. */
  Schema.TaggedStruct("Vetoed", { reason: Received }),
]);
export type ToolFailure = typeof ToolFailure.Type;

/** How a tool call ended: it succeeded, with the tool's output, or it failed, for a reason. */
export const ToolOutcome = Schema.Union([
  Schema.TaggedStruct("Succeeded", { output: Received }),
  Schema.TaggedStruct("Failed", { reason: ToolFailure }),
]);
export type ToolOutcome = typeof ToolOutcome.Type;

/**
 * Why a model's response stopped, as its adapter classifies the provider's own reason (kept in
 * `stop`): it is complete (with or without tool calls), it was cut short (a length limit, a pause,
 * a stop sequence), the provider refused it, or the adapter does not know the reason.
 */
export const ResponseEnding = Schema.Union([
  Schema.TaggedStruct("Complete", {}),
  Schema.TaggedStruct("CutShort", {}),
  Schema.TaggedStruct("Refused", {}),
  Schema.TaggedStruct("Unclassified", {}),
]);
export type ResponseEnding = typeof ResponseEnding.Type;

/** Observations recorded as facts. */
export const Observation = Schema.Union([
  /** A session was opened. */
  Schema.TaggedStruct("SessionOpened", { session: SessionId }),
  /** An input arrived. It can arrive at any time, including while a turn is under way. */
  Schema.TaggedStruct("InputArrived", { from: InputSource, text: InputText }),
  /**
   * The conversation was compacted into a new window: once taken (`WindowOpened`), the model is sent
   * `summary` in place of the facts through `through`, except those at `kept`, which it is sent as
   * they are. `previous` is the window this one follows, when there is one.
   */
  Schema.TaggedStruct("Compacted", {
    window: WindowId,
    previous: Schema.optionalKey(WindowId),
    summary: Received,
    through: Seq,
    kept: Schema.Array(Seq),
  }),
  /** A turn started. It takes the input waiting for it. */
  Schema.TaggedStruct("TurnStarted", { turn: TurnId }),
  /** The input recorded at `input`, still queued, was cancelled by its sender. */
  Schema.TaggedStruct("InputCancelled", { input: Seq }),
  /**
   * A model responded. `parts` are the response's parts in the order received; `stop` is why it
   * stopped in the provider's words, when the record has them, and `ending` that reason classified; `metadata` is everything
   * else the provider sent with it (usage, identifiers), as received.
   */
  Schema.TaggedStruct("ModelResponded", {
    turn: TurnId,
    provider: ProviderName,
    model: ModelName,
    parts: Schema.Array(ModelPart),
    stop: Schema.optionalKey(StopReason),
    ending: ResponseEnding,
    metadata: Received,
  }),
  /**
   * A request for a model response failed. `failure` says why in words; `error` is the error as the
   * adapter that failed encoded it, as received.
   */
  Schema.TaggedStruct("ModelFailed", { turn: TurnId, failure: FailureText, error: Received }),
  /**
   * One attempt at a request for a model response failed, and the request goes on (to another
   * provider, say). The turn does not end: the request's outcome is still to come.
   */
  Schema.TaggedStruct("ModelAttemptFailed", {
    turn: TurnId,
    provider: ProviderName,
    model: ModelName,
    failure: FailureText,
    error: Received,
  }),
  /** A policy vetoed a request for a model response, for the reason it gave. */
  Schema.TaggedStruct("ModelVetoed", { turn: TurnId, reason: Received }),
  /** A tool call ended. */
  Schema.TaggedStruct("ToolEnded", { call: CallId, outcome: ToolOutcome }),
  /** The layers around the core finished giving `turn` input before it ends (`BeforeTurnEnded`). */
  Schema.TaggedStruct("TurnEndReviewed", { turn: TurnId }),
  /**
   * The layers around the core held `turn` open before it ends as many times as they allow
   * (`holds`), and do not run what holds it open again for this turn; the review goes on without it.
   */
  Schema.TaggedStruct("TurnHoldsExhausted", { turn: TurnId, holds: Schema.Int }),
  /** The turn was interrupted (by the user, or whoever else may stop it). It ends at once. */
  Schema.TaggedStruct("TurnInterrupted", { turn: TurnId }),
]);
export type Observation = typeof Observation.Type;

/** Observations captured for display and not recorded. */
export const CapturedObservation = Schema.Union([
  /** Part of a model response while it is still arriving, as received. */
  Schema.TaggedStruct("ModelStreamed", { turn: TurnId, chunk: Received }),
]);
export type CapturedObservation = typeof CapturedObservation.Type;
