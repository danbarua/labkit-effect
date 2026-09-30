/**
 * Every string the core holds, each branded with what it is. A value of one cannot be passed where
 * another is expected.
 */

import { Schema } from "effect";

/** Identifies one session. */
export const SessionId = Schema.String.pipe(Schema.brand("agent-core/SessionId"));
export type SessionId = typeof SessionId.Type;

/** Identifies one turn: a user's message and everything the harness does in response. */
export const TurnId = Schema.String.pipe(Schema.brand("agent-core/TurnId"));
export type TurnId = typeof TurnId.Type;

/** The identifier a model gives a tool call it proposes. Assigned by the model, not the harness. */
export const CallId = Schema.String.pipe(Schema.brand("agent-core/CallId"));
export type CallId = typeof CallId.Type;

/** The name of a tool, as the model uses it in a call. */
export const ToolName = Schema.String.pipe(Schema.brand("agent-core/ToolName"));
export type ToolName = typeof ToolName.Type;

/** The name of a model provider. */
export const ProviderName = Schema.String.pipe(Schema.brand("agent-core/ProviderName"));
export type ProviderName = typeof ProviderName.Type;

/** The name of a model, as its provider names it. */
export const ModelName = Schema.String.pipe(Schema.brand("agent-core/ModelName"));
export type ModelName = typeof ModelName.Type;

/** The name of an agent that can send input to a session. */
export const AgentName = Schema.String.pipe(Schema.brand("agent-core/AgentName"));
export type AgentName = typeof AgentName.Type;

/** The surface a person acts through: an editor, a protocol, a terminal. */
export const Via = Schema.String.pipe(Schema.brand("agent-core/Via"));
export type Via = typeof Via.Type;

/** The name of a part of the harness around the core that reports observations. */
export const HarnessPart = Schema.String.pipe(Schema.brand("agent-core/HarnessPart"));
export type HarnessPart = typeof HarnessPart.Type;

/** The name of a test, or of any other exercise of the code. */
export const TestName = Schema.String.pipe(Schema.brand("agent-core/TestName"));
export type TestName = typeof TestName.Type;

/** The text of an input to a session, from whichever source sent it. */
export const InputText = Schema.String.pipe(Schema.brand("agent-core/InputText"));
export type InputText = typeof InputText.Type;

/** Text a model wrote as its answer. */
export const ModelText = Schema.String.pipe(Schema.brand("agent-core/ModelText"));
export type ModelText = typeof ModelText.Type;

/** Text a model wrote as its reasoning. */
export const ThinkingText = Schema.String.pipe(Schema.brand("agent-core/ThinkingText"));
export type ThinkingText = typeof ThinkingText.Type;

/** A provider's signature over a model's reasoning, which the provider requires back unchanged. */
export const ThinkingSignature = Schema.String.pipe(Schema.brand("agent-core/ThinkingSignature"));
export type ThinkingSignature = typeof ThinkingSignature.Type;

/** Text the harness gives the model as a notice: timely context, such as the current time. */
export const NoticeText = Schema.String.pipe(Schema.brand("agent-core/NoticeText"));
export type NoticeText = typeof NoticeText.Type;

/** Why a provider says a response ended, in the provider's own words. */
export const StopReason = Schema.String.pipe(Schema.brand("agent-core/StopReason"));
export type StopReason = typeof StopReason.Type;

/** A description of a failure, as the failing party gave it. */
export const FailureText = Schema.String.pipe(Schema.brand("agent-core/FailureText"));
export type FailureText = typeof FailureText.Type;

/** Identifies one window: what the model is sent after a compaction. Assigned by whoever compacted. */
export const WindowId = Schema.String.pipe(Schema.brand("agent-core/WindowId"));
export type WindowId = typeof WindowId.Type;

/** The position of a fact in its session's journal, starting at 1. */
export const Seq = Schema.Int.pipe(Schema.brand("agent-core/Seq"));
export type Seq = typeof Seq.Type;

/** The positions of inputs in the journal, oldest first. At least one. */
export const Inputs = Schema.NonEmptyArray(Seq);
export type Inputs = typeof Inputs.Type;

/** A step's place in its turn, starting at 1. */
export const StepIndex = Schema.Int.pipe(Schema.brand("agent-core/StepIndex"));
export type StepIndex = typeof StepIndex.Type;

/** A time in milliseconds, from a clock the caller chooses. */
export const Millis = Schema.Finite.pipe(Schema.brand("agent-core/Millis"));
export type Millis = typeof Millis.Type;
