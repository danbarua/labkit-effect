/**
 * Observations: what reaches the harness from outside it.
 *
 * - A session records each `Observation` as a fact, unchanged.
 * - A session publishes each `CapturedObservation` to whoever follows it, for display, and does not
 *   record it.
 */

import { BlobRef } from "./blob.ts";
import { Schema } from "effect";
import { Received } from "./received.ts";
import { Adjusted, ModelSettings, SettingsChange } from "./settings.ts";
import {
  AgentName,
  CallId,
  AdjustmentReason,
  ByteCount,
  FailureText,
  FolderPath,
  FullPath,
  InputText,
  McpServerName,
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
   * Text that the model wrote for whoever watches the session, about what it found or is about to
   * do. A provider may call it commentary or a progress update. It is not the model's answer.
   */
  Schema.TaggedStruct("Commentary", { text: ModelText }),
  /**
   * The model's thinking. `text` is the readable part: a summary, a progress note, or empty.
   * `received` is the provider's block or item as received; later requests send it back to the
   * provider unchanged.
   */
  Schema.TaggedStruct("Thinking", { text: ThinkingText, received: Received }),
  Schema.TaggedStruct("ToolCall", { call: CallId, tool: ToolName, input: Received }),
  /** A part that the decoder does not recognise, as received. */
  Schema.TaggedStruct("Unrecognised", { received: Received }),
]);
export type ModelPart = typeof ModelPart.Type;

/** Why a tool call failed. Code that needs only success or failure matches `ToolOutcome` and ignores the reason. */
export const ToolFailure = Schema.Union([
  /** The tool ran and reported an error. */
  Schema.TaggedStruct("Reported", { error: Received }),
  /** No tool has the name the model called. */
  Schema.TaggedStruct("NotFound", {}),
  /** The tool did not accept the input it was given. */
  Schema.TaggedStruct("InputRejected", { problem: FailureText }),
  /** A policy vetoed the call before it ran, for the reason it gave. */
  Schema.TaggedStruct("Vetoed", { reason: Received }),
  /** The tool began to run, and how it ended was not observed. The tool may have had effects. */
  Schema.TaggedStruct("Indeterminate", {}),
  /** The call was not run. */
  Schema.TaggedStruct("NotRun", {}),
]);
export type ToolFailure = typeof ToolFailure.Type;

/**
 * What a tool call did, for the harness and its displays. The model is never sent it. Each variant
 * is one kind of thing a call does, so a display branches on what happened, not on which tool ran.
 *
 * - `FileChanged`: the call created the text file at `path` (`patch` is the file's whole text), or
 *   updated it (`patch` is a unified diff of the change, with three lines of context). A patch over
 *   32 KiB is cut at the end of a line: `cut` is the number of bytes left out after it.
 * - `FileMoved`: the call moved the file or folder at `from` to `to`, as the disk showed before and
 *   after it ran. `replaced` when something was at `to` before, which the move replaced. A move is
 *   recorded as a line, not as the moved file's text.
 * - `FileWritten`: the call wrote the file at `path`, which git ignores (a log, build output), so it
 *   is recorded by its size, not its text: `bytes` once the call ran, and `before`, its size before
 *   (absent when it did not exist).
 */
export const ToolDetail = Schema.Union([
  Schema.TaggedStruct("FileChanged", { path: FullPath, change: Schema.Literals(["created", "updated"]), patch: Received, cut: Schema.optionalKey(ByteCount) }),
  Schema.TaggedStruct("FileMoved", { from: FullPath, to: FullPath, replaced: Schema.optionalKey(Schema.Literal(true)) }),
  Schema.TaggedStruct("FileWritten", { path: FullPath, bytes: ByteCount, before: Schema.optionalKey(ByteCount) }),
]);
export type ToolDetail = typeof ToolDetail.Type;

/**
 * How a tool call ended: `Succeeded` with the tool's output, the text the model is sent, and the
 * details of what it did when the tool gives them; or `Failed` with the reason. A failed call has no
 * details: nothing changed, or what changed is not known.
 */
export const ToolOutcome = Schema.Union([
  Schema.TaggedStruct("Succeeded", { output: Received, details: Schema.optionalKey(Schema.Array(ToolDetail)) }),
  Schema.TaggedStruct("Failed", { reason: ToolFailure }),
]);
export type ToolOutcome = typeof ToolOutcome.Type;

/**
 * Why a model's response stopped, as the provider's adapter classifies the provider's own reason.
 * `ModelResponded.stop` keeps the provider's reason.
 *
 * - `Complete`: the response is complete, with or without tool calls. A stop sequence that the
 *   request named also ends a response as complete.
 * - `CutShort`: a length limit (the output limit or the context window) cut the response short.
 * - `Unfinished`: the response is whole but is not yet an answer.
 * - `Refused`: the provider refused to respond.
 * - `Interrupted`: the harness stopped the response.
 * - `Indeterminate`: no response was observed.
 * - `Unclassified`: the adapter does not recognise the provider's reason.
 */
export const ResponseEnding = Schema.Union([
  Schema.TaggedStruct("Complete", {}),
  Schema.TaggedStruct("CutShort", {}),
  /**
   * The response is whole and calls no tool, and its provider marks it as not the end of the
   * model's turn (Anthropic's `pause_turn`). The turn asks the model again.
   */
  Schema.TaggedStruct("Unfinished", {}),
  Schema.TaggedStruct("Refused", {}),
  /** The harness stopped the response while it was arriving. The response holds the parts that were complete by then. */
  Schema.TaggedStruct("Interrupted", {}),
  /**
   * No response was observed: the request was made, and its outcome is not known. The response
   * holds the parts that are known to have arrived.
   */
  Schema.TaggedStruct("Indeterminate", {}),
  Schema.TaggedStruct("Unclassified", {}),
]);
export type ResponseEnding = typeof ResponseEnding.Type;

/**
 * The tokens that a request and its response used, as the provider reported them, in the same
 * terms for every provider. A count that the provider did not report is absent.
 *
 * - `input`: every token the request carried, including `cacheRead` and `cacheWrite`.
 * - `cacheRead`: input tokens read from the provider's cache.
 * - `cacheWrite`: input tokens written to the provider's cache.
 * - `cacheWrite1h`: the part of `cacheWrite` kept for one hour rather than five minutes, where the
 *   provider prices the two differently.
 * - `output`: every token of the response, including `thinking`.
 * - `thinking`: the output tokens of the model's thinking.
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

/** A model, the provider that serves it, and the model's settings when any are given. */
export const ModelTarget = Schema.Struct({
  provider: ProviderName,
  model: ModelName,
  settings: Schema.optionalKey(ModelSettings),
});
export type ModelTarget = typeof ModelTarget.Type;

/** Observations recorded as facts. */
export const Observation = Schema.Union([
  /**
   * The session was opened. `model` is the model that the first turn asks. `system` and `tools` are
   * the system prompt and the tool catalog, when the session has them. A later change to any of
   * these is recorded as a fact of its own. A session cannot be opened without a model.
   */
  Schema.TaggedStruct("SessionOpened", {
    session: SessionId,
    model: ModelTarget,
    system: Schema.optionalKey(Received),
    tools: Schema.optionalKey(Received),
  }),
  /** An input arrived. Input can arrive at any time, including while a turn runs. */
  Schema.TaggedStruct("InputArrived", {
    from: InputSource,
    text: InputText,
    /** References to the files attached to the input. The blob store holds their bytes. */
    attachments: Schema.optionalKey(Schema.Array(BlobRef)),
  }),
  /**
   * A span of the conversation was chosen for compaction: the facts up to and including `through`,
   * except the facts at `kept`.
   *
   * - `decidedBy` names the policy that decided the compaction was due.
   * - `previous` is the window that this window follows, when there is one.
   * - Once the core takes the window (`WindowOpened`), each request is made in the window: a summary
   *   of the span replaces the span, and the facts at `kept` are sent unchanged.
   * - The summary is not a fact of the session. It is kept apart from the facts, so it can be
   *   revised, replaced, or kept beside other summaries.
   * - The window states that a summary of the span should exist. It does not state that one exists
   *   for any provider.
   */
  Schema.TaggedStruct("CompactionWindow", {
    window: WindowId,
    decidedBy: PolicyName,
    previous: Schema.optionalKey(WindowId),
    through: Seq,
    kept: Schema.Array(Seq),
  }),
  /**
   * The session is to ask `model` through `provider` from now on, with the `settings` given. A
   * setting that is not given keeps its value, and a setting given as `default` returns to the
   * provider's default. Once the core takes the change (`ModelChangeTaken`), the requests that
   * follow go to the new model.
   */
  Schema.TaggedStruct("ModelChangeArrived", {
    provider: ProviderName,
    model: ModelName,
    settings: Schema.optionalKey(SettingsChange),
  }),
  /** A turn started. The turn takes every input waiting in the agent's mailbox. */
  Schema.TaggedStruct("TurnStarted", { turn: TurnId }),
  /** The sender cancelled the input recorded at `input` while it was still waiting in a mailbox. */
  Schema.TaggedStruct("InputCancelled", { input: Seq }),
  /**
   * An MCP server that the session keeps changed state. The session records the change for its
   * record and its host; no machine acts on it.
   *
   * - `Ready`: the server is connected; `tools` are the names its tools are offered under.
   * - `Failed`: the server could not be started, did not connect, or refused the credentials given.
   * - `NeedsAuth`: the server requires authorization that the client cannot give.
   * - `Exited`: the server's process exited.
   * - `Stopped`: the session stopped the server.
   */
  Schema.TaggedStruct("McpServerChanged", {
    server: McpServerName,
    state: Schema.Union([
      Schema.TaggedStruct("Ready", { tools: Schema.Array(ToolName) }),
      Schema.TaggedStruct("Failed", { reason: FailureText }),
      Schema.TaggedStruct("NeedsAuth", { reason: FailureText }),
      Schema.TaggedStruct("Exited", { reason: FailureText }),
      Schema.TaggedStruct("Stopped", {}),
    ]),
  }),
  /**
   * The user added `folder`, an absolute path, to the session's folders. From then on, a path in it
   * counts as inside the working folder for the permission policy, and the model is told so at this
   * place in the conversation. No machine acts on it.
   */
  Schema.TaggedStruct("FolderAdded", { folder: FolderPath }),
  /**
   * A request for a model response was sent to `provider` for `model`. `sent` is what the request
   * carried (the system prompt, the tools and the conversation), as the layer that assembled them
   * wrote them. The outcome is a later observation (`ModelResponded`, `ModelFailed` or
   * `ModelVetoed`); when none is recorded, the outcome is not known.
   */
  Schema.TaggedStruct("ModelRequestDispatched", { turn: TurnId, provider: ProviderName, model: ModelName, sent: Received }),
  /**
   * A model responded.
   *
   * - `parts`: the response's parts, in the order received.
   * - `stop`: the provider's reason for stopping, in the provider's words, when the record has it.
   * - `ending`: the reason for stopping, classified.
   * - `metadata`: everything else the provider sent with the response (usage, identifiers), as
   *   received.
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
   * A request for a model response failed.
   *
   * - `failure`: why the request failed, in words.
   * - `error`: the error as the failing adapter encoded it.
   * - `request`: the request as the adapter made it, when the record has it. For an adapter that
   *   posts over HTTP: the path, the headers it set, and the body.
   */
  Schema.TaggedStruct("ModelFailed", {
    turn: TurnId,
    failure: FailureText,
    error: Received,
    request: Schema.optionalKey(Received),
  }),
  /**
   * One attempt at a request for a model response failed, and the request continues (for example,
   * with another provider). The turn does not end, because the request's outcome is still to come.
   * `error` and `request` are as for `ModelFailed`.
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
   * The layers around the core appended a notice to a request for a model response, after
   * everything else the request carried. Later requests carry the notice in the same position. A
   * notice is timely context, such as the current time; a compaction may drop it.
   */
  Schema.TaggedStruct("NoticeInserted", { turn: TurnId, text: NoticeText }),
  /**
   * A request for a model response was sent with a setting other than the one given, because the
   * model does not take the value given: the nearest value it takes, or nothing. From then on, the
   * value sent is the session's setting for that model.
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
   * A tool call in a response that is still arriving is complete. The call runs without waiting for
   * the rest of the response; the recorded response holds the call as one of its parts.
   */
  Schema.TaggedStruct("ToolCallArrived", { turn: TurnId, call: CallId, tool: ToolName, input: Received }),
  /**
   * Before a call runs, a policy asks for an answer, such as a person's permission. `asks` is the
   * question as the policy states it. The call waits for `PermissionAnswered` or `PermissionFailed`.
   */
  Schema.TaggedStruct("PermissionAsked", { call: CallId, asks: Received }),
  /** The answer to the question asked before `call` runs, as the answerer gave it. */
  Schema.TaggedStruct("PermissionAnswered", { call: CallId, answer: Received }),
  /**
   * The question asked before `call` runs has no answer, because asking it failed: the client failed
   * the request, or the connection closed. `problem` says what failed. The policy that asked decides
   * whether the call runs.
   */
  Schema.TaggedStruct("PermissionFailed", { call: CallId, problem: FailureText }),
  /** The tool that the call names began to run. */
  Schema.TaggedStruct("ToolCallDispatched", { call: CallId }),
  /** A tool call ended. */
  Schema.TaggedStruct("ToolEnded", { call: CallId, outcome: ToolOutcome }),
  /** The layers around the core have given `turn` any input they had before it ends; this answers `BeforeTurnEnded`. */
  Schema.TaggedStruct("TurnEndReviewed", { turn: TurnId }),
  /**
   * The turn-end hooks have held `turn` open the maximum number of times (`holds`), and would hold
   * it open again with `feedback`. The feedback is not given to the turn, and the review continues
   * without the hooks.
   */
  Schema.TaggedStruct("TurnHoldsExhausted", { turn: TurnId, holds: Schema.Int, feedback: Schema.Array(InputText) }),
  /**
   * The turn was interrupted, by the user or by another party allowed to stop it. The turn stops
   * what is under way for it (a step, or the turn-end review) and ends when each request has
   * reported how far it got. The model is not asked again in the turn.
   */
  Schema.TaggedStruct("TurnInterrupted", { turn: TurnId }),
]);
export type Observation = typeof Observation.Type;

/**
 * Observations published for display and not recorded. For one model request they are published in
 * the order they arrived, and the last is `ModelResponseEnded`, however the request ended.
 */
export const CapturedObservation = Schema.Union([
  /** One stream event of a model response that is still arriving, as received. */
  Schema.TaggedStruct("ModelStreamed", { turn: TurnId, chunk: Received }),
  /**
   * Text that a stream event adds to a part of the response: to an answer (`Text`), to commentary,
   * or to the readable text of thinking. A part's deltas, joined, are the part's text, and are
   * published before the part's `ModelPartArrived`. A response that does not stream, a part with no
   * readable text, and a delta that adds no text publish no delta.
   */
  Schema.TaggedStruct("ModelDelta", { turn: TurnId, kind: Schema.Literals(["Text", "Commentary"]), text: ModelText }),
  Schema.TaggedStruct("ModelDelta", { turn: TurnId, kind: Schema.Literal("Thinking"), text: ThinkingText }),
  /** A part of a model response is complete; the rest of the response may still be arriving. */
  Schema.TaggedStruct("ModelPartArrived", { turn: TurnId, part: ModelPart }),
  /** The model request ended: answered, failed, or stopped. Nothing more is published for the request. */
  Schema.TaggedStruct("ModelResponseEnded", { turn: TurnId }),
]);
export type CapturedObservation = typeof CapturedObservation.Type;
