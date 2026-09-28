/**
 * Every string the core holds, each branded with what it is. A value of one cannot be passed where
 * another is expected.
 */

import { Schema } from "effect";

/** Identifies one session. */
export const SessionId = Schema.String.pipe(Schema.brand("SessionId"));
export type SessionId = typeof SessionId.Type;

/** Identifies one turn: a user's message and everything the harness does in response. */
export const TurnId = Schema.String.pipe(Schema.brand("TurnId"));
export type TurnId = typeof TurnId.Type;

/** The identifier a model gives a tool call it proposes. Assigned by the model, not the harness. */
export const CallId = Schema.String.pipe(Schema.brand("CallId"));
export type CallId = typeof CallId.Type;

/** The name of a tool, as the model uses it in a call. */
export const ToolName = Schema.String.pipe(Schema.brand("ToolName"));
export type ToolName = typeof ToolName.Type;

/** The name of a model provider. */
export const ProviderName = Schema.String.pipe(Schema.brand("ProviderName"));
export type ProviderName = typeof ProviderName.Type;

/** The name of a model, as its provider names it. */
export const ModelName = Schema.String.pipe(Schema.brand("ModelName"));
export type ModelName = typeof ModelName.Type;

/** Text a user wrote. */
export const UserText = Schema.String.pipe(Schema.brand("UserText"));
export type UserText = typeof UserText.Type;

/** Text a model wrote as its answer. */
export const ModelText = Schema.String.pipe(Schema.brand("ModelText"));
export type ModelText = typeof ModelText.Type;

/** Text a model wrote as its reasoning. */
export const ThinkingText = Schema.String.pipe(Schema.brand("ThinkingText"));
export type ThinkingText = typeof ThinkingText.Type;

/** A provider's signature over a model's reasoning, which the provider requires back unchanged. */
export const ThinkingSignature = Schema.String.pipe(Schema.brand("ThinkingSignature"));
export type ThinkingSignature = typeof ThinkingSignature.Type;

/** Why a provider says a response ended, in the provider's own words. */
export const StopReason = Schema.String.pipe(Schema.brand("StopReason"));
export type StopReason = typeof StopReason.Type;

/** A description of a failure, as the failing party gave it. */
export const FailureText = Schema.String.pipe(Schema.brand("FailureText"));
export type FailureText = typeof FailureText.Type;

/** The position of a fact in its session's journal, starting at 1. */
export const Seq = Schema.Int.pipe(Schema.brand("Seq"));
export type Seq = typeof Seq.Type;
