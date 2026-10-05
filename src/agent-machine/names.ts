/**
 * Every string and number that the core holds, each branded with what it is. A value of one brand
 * cannot be passed where another brand is expected.
 */

import { Schema } from "effect";

/** Identifies one session. */
export const SessionId = Schema.String.pipe(Schema.brand("agent-machine/SessionId"));
export type SessionId = typeof SessionId.Type;

/** Identifies one turn: from the input that started it to the model's final answer. */
export const TurnId = Schema.String.pipe(Schema.brand("agent-machine/TurnId"));
export type TurnId = typeof TurnId.Type;

/** The identifier of a tool call. The model assigns it when it proposes the call; the harness does not. */
export const CallId = Schema.String.pipe(Schema.brand("agent-machine/CallId"));
export type CallId = typeof CallId.Type;

/** The name of a tool, as the model uses it in a call. */
export const ToolName = Schema.String.pipe(Schema.brand("agent-machine/ToolName"));
export type ToolName = typeof ToolName.Type;

/** The name of an MCP server that a session keeps, as the host's configuration names it. */
export const McpServerName = Schema.String.pipe(Schema.brand("agent-machine/McpServerName"));
export type McpServerName = typeof McpServerName.Type;

/**
 * What a tool does, in ACP's names: reads, edits, deletes or moves files, searches, runs a command,
 * thinks, fetches, or something else. Whoever defines a tool declares its kind; a permission policy
 * reads it.
 */
export const ToolKind = Schema.Literals(["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "other"]);
export type ToolKind = typeof ToolKind.Type;

/**
 * What running a tool does to the world. Whoever defines a tool declares its replay.
 *
 * - `safe`: the tool changes nothing.
 * - `idempotent`: running the tool again leaves the world as running it once does.
 * - `unsafe`: neither.
 *
 * When a session continues a turn whose process ended, a call with no outcome runs again only when
 * its tool is `safe`. An `idempotent` or `unsafe` call does not run, because what it would change
 * may have changed since the model asked for it.
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

/** The name of a test, or of another run of the code, such as a probe. */
export const TestName = Schema.String.pipe(Schema.brand("agent-machine/TestName"));
export type TestName = typeof TestName.Type;

/** The text of an input to a session, from whichever source sent it. */
export const InputText = Schema.String.pipe(Schema.brand("agent-machine/InputText"));
export type InputText = typeof InputText.Type;

/** Text that a model wrote: its answer, or commentary. */
export const ModelText = Schema.String.pipe(Schema.brand("agent-machine/ModelText"));
export type ModelText = typeof ModelText.Type;

/** The readable text of a model's thinking, as the provider returned it. */
export const ThinkingText = Schema.String.pipe(Schema.brand("agent-machine/ThinkingText"));
export type ThinkingText = typeof ThinkingText.Type;

/** Text that the harness gives the model as a notice: timely context, such as the current time. */
export const NoticeText = Schema.String.pipe(Schema.brand("agent-machine/NoticeText"));
export type NoticeText = typeof NoticeText.Type;

/** The provider's reason for ending a response, in the provider's own words. */
export const StopReason = Schema.String.pipe(Schema.brand("agent-machine/StopReason"));
export type StopReason = typeof StopReason.Type;

/** A description of a failure, as the failing party gave it. */
export const FailureText = Schema.String.pipe(Schema.brand("agent-machine/FailureText"));
export type FailureText = typeof FailureText.Type;

/** A number of tokens. */
export const TokenCount = Schema.Int.pipe(Schema.brand("agent-machine/TokenCount"));
export type TokenCount = typeof TokenCount.Type;

/** Why a setting was not applied as asked, in the words of the adapter that adjusted it. */
export const AdjustmentReason = Schema.String.pipe(Schema.brand("agent-machine/AdjustmentReason"));
export type AdjustmentReason = typeof AdjustmentReason.Type;

/**
 * What decided that a compaction was due: a compaction policy's name, the user, or the harness a
 * session was imported from and how it says it was triggered.
 */
export const PolicyName = Schema.String.pipe(Schema.brand("agent-machine/PolicyName"));
export type PolicyName = typeof PolicyName.Type;

/** Identifies one compaction window. The policy or party that compacted assigns it. */
export const WindowId = Schema.String.pipe(Schema.brand("agent-machine/WindowId"));
export type WindowId = typeof WindowId.Type;

/** The position of a fact in its session's journal, starting at 1. */
export const Seq = Schema.Int.pipe(Schema.brand("agent-machine/Seq"));
export type Seq = typeof Seq.Type;

/** The positions of one or more inputs in the journal, oldest first. */
export const Inputs = Schema.NonEmptyArray(Seq);
export type Inputs = typeof Inputs.Type;

/** A step's place in its turn, starting at 1. */
export const StepIndex = Schema.Int.pipe(Schema.brand("agent-machine/StepIndex"));
export type StepIndex = typeof StepIndex.Type;

/** A time in milliseconds, from a clock the caller chooses. */
export const Millis = Schema.Finite.pipe(Schema.brand("agent-machine/Millis"));
export type Millis = typeof Millis.Type;
