/**
 * Observations: what reaches the harness from outside. A recorded observation is kept as
 * received; a captured observation is passed on for display and not kept.
 */

import { BlobRef } from "./blob.ts";
import { Schema } from "effect";
import { Received } from "./received.ts";
import { Adjusted, ModelSettings } from "./settings.ts";
import {
  AgentName,
  CallId,
  AdjustmentReason,
  FailureText,
  InputText,
  ModelName,
  ModelText,
  PolicyName,
  NoticeText,
  ProviderName,
  Seq,
  SessionId,
  StopReason,
  ThinkingText,
  ToolName,
  TurnId,
  WindowId, TokenCount } from "./names.ts";

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
  /**
   * Text a model wrote for whoever is watching, saying what it found or is about to do (a provider
   * may call it commentary, or a progress update). It is not the model's answer.
   */
  Schema.TaggedStruct("Commentary", { text: ModelText }),
  /**
   * The model's thinking: `text` is what of it can be read (a summary, a note on its progress, or
   * nothing), and `received` is the provider's block or item as it came, which the provider needs
   * back unchanged.
   */
  Schema.TaggedStruct("Thinking", { text: ThinkingText, received: Received }),
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
  /** The tool began to run and how it ended was not observed. It may have had effects. */
  Schema.TaggedStruct("Indeterminate", {}),
  /** The call was not run. */
  Schema.TaggedStruct("NotRun", {}),
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
 * `stop`): it is complete (with or without tool calls; a stop sequence the request named ends it
 * complete), it was cut short by a length limit (the output limit, or the context window), it is
 * whole but not yet an answer, the provider refused it, the harness stopped it,
 * nothing of it was observed, or the adapter does not know the reason.
 */
export const ResponseEnding = Schema.Union([
  Schema.TaggedStruct("Complete", {}),
  Schema.TaggedStruct("CutShort", {}),
  /**
   * The response is whole, called no tool, and its provider marks it as not the end of the model's
   * turn (a pause). The model is asked again.
   */
  Schema.TaggedStruct("Unfinished", {}),
  Schema.TaggedStruct("Refused", {}),
  /** The response was stopped while it was arriving; it holds the parts that were complete by then. */
  Schema.TaggedStruct("Interrupted", {}),
  /**
   * No response was observed: the request was made, and what came of it is not known. It holds the
   * parts known to have arrived.
   */
  Schema.TaggedStruct("Indeterminate", {}),
  Schema.TaggedStruct("Unclassified", {}),
]);
export type ResponseEnding = typeof ResponseEnding.Type;

/**
 * The tokens a request and its response took, as the provider reported them, in the same terms for
 * every provider. `input` is everything the request carried, what was read from the cache
 * (`cacheRead`) and written to it (`cacheWrite`) included; `cacheWrite1h` is the part of
 * `cacheWrite` kept for an hour rather than five minutes, where the provider prices the two apart.
 * `output` is everything the response took, its thinking (`thinking`) included. A part the
 * provider did not report is absent.
 */
export const Usage = Schema.Struct({
  input: TokenCount,
  output: TokenCount,
  thinking: Schema.optionalKey(TokenCount),
  cacheRead: Schema.optionalKey(TokenCount),
  cacheWrite: Schema.optionalKey(TokenCount),
  cacheWrite1h: Schema.optionalKey(TokenCount),
});
export type Usage = typeof Usage.Type;

/** A model, the provider it is asked through, and how it is to process requests, where that is said. */
export const ModelTarget = Schema.Struct({
  provider: ProviderName,
  model: ModelName,
  settings: Schema.optionalKey(ModelSettings),
});
export type ModelTarget = typeof ModelTarget.Type;

/** Observations recorded as facts. */
export const Observation = Schema.Union([
  /**
   * A session was opened with what its first turn is given: the model it asks, and its system prompt
   * and tools when it has any, as they were set. Changes to any of them later are facts of their
   * own. A session cannot be opened without a model.
   */
  Schema.TaggedStruct("SessionOpened", {
    session: SessionId,
    model: ModelTarget,
    system: Schema.optionalKey(Received),
    tools: Schema.optionalKey(Received),
  }),
  /** An input arrived. It can arrive at any time, including while a turn is under way. */
  Schema.TaggedStruct("InputArrived", {
    from: InputSource,
    text: InputText,
    /** Files that came with the input, by reference; the bytes are in the blob store. */
    attachments: Schema.optionalKey(Schema.Array(BlobRef)),
  }),
  /**
   * A span of the conversation was chosen for compaction: the facts through `through`, except those
   * at `kept`. Once taken (`WindowOpened`), requests are made in the window, where a summary of the
   * span stands in for it and the facts at `kept` are sent as they are. The summary is not a fact of
   * the session: it belongs to a fork over the window, held apart, so it can be revised, replaced or
   * set beside others. `previous` is the window this one follows, when there is one. `decidedBy` is
   * what decided the compaction was due. The window says a summary of the span should exist; it
   * does not say that one does, for any provider.
   */
  Schema.TaggedStruct("CompactionWindow", {
    window: WindowId,
    decidedBy: PolicyName,
    previous: Schema.optionalKey(WindowId),
    through: Seq,
    kept: Schema.Array(Seq),
  }),
  /**
   * The session is to ask `model` of `provider` from now on, with the `settings` named; a setting
   * not named stays as it was. Once taken (`ModelChangeTaken`), the requests that follow go there.
   */
  Schema.TaggedStruct("ModelChangeArrived", {
    provider: ProviderName,
    model: ModelName,
    settings: Schema.optionalKey(ModelSettings),
  }),
  /** A turn started. It takes the input waiting for it. */
  Schema.TaggedStruct("TurnStarted", { turn: TurnId }),
  /** The input recorded at `input`, still queued, was cancelled by its sender. */
  Schema.TaggedStruct("InputCancelled", { input: Seq }),
  /**
   * A request for a model response was made: it was handed to `provider` for `model`, carrying
   * `sent` (the system prompt, the tools and the conversation, as the layer that assembled them
   * wrote them down). What comes of it is observed after: a response, a failure, or nothing, in
   * which case how it ended is not known.
   */
  Schema.TaggedStruct("ModelRequestDispatched", { turn: TurnId, provider: ProviderName, model: ModelName, sent: Received }),
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
    usage: Schema.optionalKey(Usage),
    metadata: Received,
  }),
  /**
   * A request for a model response failed. `failure` says why in words; `error` is the error as the
   * adapter that failed encoded it, as received; `request` is the request as the adapter made it
   * (for one that posts over HTTP, the path, the headers it set and the body), when the record has it.
   */
  Schema.TaggedStruct("ModelFailed", {
    turn: TurnId,
    failure: FailureText,
    error: Received,
    request: Schema.optionalKey(Received),
  }),
  /**
   * One attempt at a request for a model response failed, and the request goes on (to another
   * provider, say). The turn does not end: the request's outcome is still to come. `error` and
   * `request` are as for `ModelFailed`.
   */
  Schema.TaggedStruct("ModelAttemptFailed", {
    turn: TurnId,
    provider: ProviderName,
    model: ModelName,
    failure: FailureText,
    error: Received,
    request: Schema.optionalKey(Received),
  }),
  /**
   * A notice went into a request for a model response, after everything else it carried; later
   * requests carry it in the same place. A notice is disposable: it is timely context, and a
   * compaction may drop it.
   */
  Schema.TaggedStruct("NoticeInserted", { turn: TurnId, text: NoticeText }),
  /**
   * A request for a model response went out with a setting other than the one asked for, because
   * the model does not allow what was asked. From then on what was used is the session's setting
   * for that model.
   */
  Schema.TaggedStruct("SettingAdjusted", {
    turn: TurnId,
    provider: ProviderName,
    model: ModelName,
    adjusted: Adjusted,
    reason: AdjustmentReason,
  }),
  /** A policy vetoed a request for a model response, for the reason it gave. */
  Schema.TaggedStruct("ModelVetoed", { turn: TurnId, reason: Received }),
  /**
   * A tool call in a response that is still arriving is complete: the model asked for it. The call
   * is run without waiting for the rest of the response, which will hold it as one of its parts.
   */
  Schema.TaggedStruct("ToolCallArrived", { turn: TurnId, call: CallId, tool: ToolName, input: Received }),
  /**
   * Before a call runs, a policy asks for an answer (a person's permission): `asks` is what it asks,
   * as the policy states it. The call waits for `PermissionAnswered`.
   */
  Schema.TaggedStruct("PermissionAsked", { call: CallId, asks: Received }),
  /** The answer to what was asked before `call` runs, as the answerer gave it. */
  Schema.TaggedStruct("PermissionAnswered", { call: CallId, answer: Received }),
  /** The tool a call asks for began to run. */
  Schema.TaggedStruct("ToolCallDispatched", { call: CallId }),
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

/**
 * Observations captured for display and not recorded. For one model request they come in the order
 * they arrived, and end with `ModelResponseEnded`, however the request ended.
 */
export const CapturedObservation = Schema.Union([
  /** Part of a model response while it is still arriving, as received. */
  Schema.TaggedStruct("ModelStreamed", { turn: TurnId, chunk: Received }),
  /**
   * Text added to a part of the response while it arrives: an answer's (`Text`), commentary's, or
   * the readable text of thinking. A part's deltas, joined, are its text, and come before the part's
   * `ModelPartArrived`. A response that does not stream, and a part with no readable text, have none.
   */
  Schema.TaggedStruct("ModelDelta", { turn: TurnId, kind: Schema.Literals(["Text", "Commentary"]), text: ModelText }),
  Schema.TaggedStruct("ModelDelta", { turn: TurnId, kind: Schema.Literal("Thinking"), text: ThinkingText }),
  /** A part of a model response is complete, while the rest is still arriving. */
  Schema.TaggedStruct("ModelPartArrived", { turn: TurnId, part: ModelPart }),
  /** The model request ended: answered, failed, or stopped. Nothing more of it follows. */
  Schema.TaggedStruct("ModelResponseEnded", { turn: TurnId }),
]);
export type CapturedObservation = typeof CapturedObservation.Type;
