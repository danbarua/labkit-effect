/**
 * Every string the core holds, each branded with what it is. A value of one cannot be passed where
 * another is expected.
 */

import { Schema } from "effect";

/** Identifies one session. */
export const SessionId = Schema.String.pipe(Schema.brand("agent-machine/SessionId"));
export type SessionId = typeof SessionId.Type;

/** Identifies one turn: a user's message and everything the harness does in response. */
export const TurnId = Schema.String.pipe(Schema.brand("agent-machine/TurnId"));
export type TurnId = typeof TurnId.Type;

/** The identifier a model gives a tool call it proposes. Assigned by the model, not the harness. */
export const CallId = Schema.String.pipe(Schema.brand("agent-machine/CallId"));
export type CallId = typeof CallId.Type;

/** The name of a tool, as the model uses it in a call. */
export const ToolName = Schema.String.pipe(Schema.brand("agent-machine/ToolName"));
export type ToolName = typeof ToolName.Type;

/**
 * What a tool does, in ACP's names for it: reads, edits, deletes or moves files, searches, runs a
 * command, thinks, fetches, or something else. Whoever defines a tool says which kind it is; a
 * permission policy reads it.
 */
export const ToolKind = Schema.Literals(["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "other"]);
export type ToolKind = typeof ToolKind.Type;

/**
 * What running a tool again does, for a call whose end was not observed (its process ended while
 * it ran): `safe`, it changes nothing, so it is run again; `idempotent`, running it again leaves
 * things as running it once does, but what it changes may have changed since, so it is not run
 * again without looking first; `unsafe`, neither, and it is not run again. Whoever defines a tool
 * says which.
 */
export const ToolReplay = Schema.Literals(["safe", "idempotent", "unsafe"]);
export type ToolReplay = typeof ToolReplay.Type;

/** The name of a model provider. */
export const ProviderName = Schema.String.pipe(Schema.brand("agent-machine/ProviderName"));
export type ProviderName = typeof ProviderName.Type;

/** The name of a model, as its provider names it. */
export const ModelName = Schema.String.pipe(Schema.brand("agent-machine/ModelName"));
export type ModelName = typeof ModelName.Type;

/** The name of an agent that can send input to a session. */
export const AgentName = Schema.String.pipe(Schema.brand("agent-machine/AgentName"));
export type AgentName = typeof AgentName.Type;

/** The surface a person acts through: an editor, a protocol, a terminal. */
export const Via = Schema.String.pipe(Schema.brand("agent-machine/Via"));
export type Via = typeof Via.Type;

/** The name of a part of the harness around the core that reports observations. */
export const HarnessPart = Schema.String.pipe(Schema.brand("agent-machine/HarnessPart"));
export type HarnessPart = typeof HarnessPart.Type;

/** The name of a test, or of any other exercise of the code. */
export const TestName = Schema.String.pipe(Schema.brand("agent-machine/TestName"));
export type TestName = typeof TestName.Type;

/** The text of an input to a session, from whichever source sent it. */
export const InputText = Schema.String.pipe(Schema.brand("agent-machine/InputText"));
export type InputText = typeof InputText.Type;

/** Text a model wrote as its answer. */
export const ModelText = Schema.String.pipe(Schema.brand("agent-machine/ModelText"));
export type ModelText = typeof ModelText.Type;

/** What can be read of a model's thinking, as the provider returned it. */
export const ThinkingText = Schema.String.pipe(Schema.brand("agent-machine/ThinkingText"));
export type ThinkingText = typeof ThinkingText.Type;

/** Text the harness gives the model as a notice: timely context, such as the current time. */
export const NoticeText = Schema.String.pipe(Schema.brand("agent-machine/NoticeText"));
export type NoticeText = typeof NoticeText.Type;

/** Why a provider says a response ended, in the provider's own words. */
export const StopReason = Schema.String.pipe(Schema.brand("agent-machine/StopReason"));
export type StopReason = typeof StopReason.Type;

/** A description of a failure, as the failing party gave it. */
export const FailureText = Schema.String.pipe(Schema.brand("agent-machine/FailureText"));
export type FailureText = typeof FailureText.Type;

/** A number of tokens. */
export const TokenCount = Schema.Int.pipe(Schema.brand("agent-machine/TokenCount"));
export type TokenCount = typeof TokenCount.Type;

/** Why a setting was not applied as asked, in the words of whatever adjusted it. */
export const AdjustmentReason = Schema.String.pipe(Schema.brand("agent-machine/AdjustmentReason"));
export type AdjustmentReason = typeof AdjustmentReason.Type;

/**
 * What decided that a compaction was due: a compaction policy's name, the user, or the harness a
 * session was imported from and how it says it was triggered.
 */
export const PolicyName = Schema.String.pipe(Schema.brand("agent-machine/PolicyName"));
export type PolicyName = typeof PolicyName.Type;

/** Identifies one window: what the model is sent after a compaction. Assigned by whoever compacted. */
export const WindowId = Schema.String.pipe(Schema.brand("agent-machine/WindowId"));
export type WindowId = typeof WindowId.Type;

/** The position of a fact in its session's journal, starting at 1. */
export const Seq = Schema.Int.pipe(Schema.brand("agent-machine/Seq"));
export type Seq = typeof Seq.Type;

/** The positions of inputs in the journal, oldest first. At least one. */
export const Inputs = Schema.NonEmptyArray(Seq);
export type Inputs = typeof Inputs.Type;

/** A step's place in its turn, starting at 1. */
export const StepIndex = Schema.Int.pipe(Schema.brand("agent-machine/StepIndex"));
export type StepIndex = typeof StepIndex.Type;

/** A time in milliseconds, from a clock the caller chooses. */
export const Millis = Schema.Finite.pipe(Schema.brand("agent-machine/Millis"));
export type Millis = typeof Millis.Type;
