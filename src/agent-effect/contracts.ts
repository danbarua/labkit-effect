/**
 * What the loop needs from the outside world, one service per job. Each adapter implements one.
 */

import { Context, type Effect, type Schema } from "effect";
import type { Fact } from "../agent-core/fact.ts";
import type { CallId, ModelName, ProviderName, ToolName, TurnId } from "../agent-core/names.ts";
import type { Observation, ToolOutcome } from "../agent-core/observation.ts";
import type { Received } from "../agent-core/received.ts";

/** Which model a request goes to. Where the provider is reached is its client's configuration. */
export interface Target {
  readonly provider: ProviderName;
  readonly model: ModelName;
}

/** Chooses the model for a turn's next request. */
export class ModelProvider extends Context.Service<
  ModelProvider,
  { readonly select: (turn: TurnId) => Effect.Effect<Target> }
>()("agent-effect/ModelProvider") {}

/** A tool the model may call: its name, what it does, and the JSON Schema of its input. */
export interface ToolSpec {
  readonly name: ToolName;
  readonly description: string;
  readonly input: Schema.Json;
}

/** One part of a message the model is sent. */
export type ContextPart =
  | { readonly _tag: "Text"; readonly text: string }
  | { readonly _tag: "ToolCall"; readonly call: CallId; readonly tool: ToolName; readonly input: Received }
  | { readonly _tag: "ToolResult"; readonly call: CallId; readonly outcome: ToolOutcome };

/** One message of what the model is sent. */
export interface ContextMessage {
  readonly role: "user" | "assistant";
  readonly parts: ReadonlyArray<ContextPart>;
}

/** What the model is sent for one request, before any provider's wire format. */
export interface ModelContext {
  readonly system: string | undefined;
  readonly tools: ReadonlyArray<ToolSpec>;
  readonly messages: ReadonlyArray<ContextMessage>;
}

/** Builds what the model is sent for a turn's next request, from the session's facts. */
export class ContextAssembler extends Context.Service<
  ContextAssembler,
  { readonly assemble: (facts: ReadonlyArray<Fact>, turn: TurnId) => Effect.Effect<ModelContext> }
>()("agent-effect/ContextAssembler") {}

/**
 * Sends one request to a model and reports the outcome as the core's observation: `ModelResponded`
 * or `ModelFailed`.
 */
export class ModelClient extends Context.Service<
  ModelClient,
  {
    readonly respond: (
      target: Target,
      context: ModelContext,
      turn: TurnId,
    ) => Effect.Effect<Extract<Observation, { _tag: "ModelResponded" | "ModelFailed" }>>;
  }
>()("agent-effect/ModelClient") {}

/** Starts a turn and chooses its identity. */
export class Turns extends Context.Service<Turns, { readonly start: Effect.Effect<TurnId> }>()(
  "agent-effect/Turns",
) {}

/**
 * What runs before a turn may end. Each hook returns feedback for the model, which the turn is given
 * as input, holding it open; no feedback lets it end. After `maxHolds` holds in one turn the hooks
 * are not run again for it.
 */
export class TurnEndHooks extends Context.Service<
  TurnEndHooks,
  {
    readonly hooks: ReadonlyArray<(turn: TurnId) => Effect.Effect<ReadonlyArray<string>>>;
    readonly maxHolds: number;
  }
>()("agent-effect/TurnEndHooks") {}

/** Runs one tool call and reports how it ended. */
export class ToolRunner extends Context.Service<
  ToolRunner,
  { readonly run: (tool: ToolName, input: Received) => Effect.Effect<ToolOutcome> }
>()("agent-effect/ToolRunner") {}
