/**
 * What the loop needs from the outside world, one service per job. Each adapter implements one.
 */

import { Context, type Effect, type Schema } from "effect";
import type * as AiError from "effect/ai/AiError";
import type { Fact } from "../agent-core/fact.ts";
import type {
  CallId,
  ModelName,
  ProviderName,
  ThinkingSignature,
  ThinkingText,
  ToolName,
  TurnId,
} from "../agent-core/names.ts";
import type { Observation, ToolOutcome } from "../agent-core/observation.ts";
import type { Received } from "../agent-core/received.ts";

/** Which model a request goes to. Where the provider is reached is its client's configuration. */
export interface Target {
  readonly provider: ProviderName;
  readonly model: ModelName;
}

/** Chooses the model for a turn's next request, given the session's facts. */
export class ModelProvider extends Context.Service<
  ModelProvider,
  { readonly select: (facts: ReadonlyArray<Fact>, turn: TurnId) => Effect.Effect<Target> }
>()("agent-effect/ModelProvider") {}

/** A tool the model may call: its name, what it does, and the JSON Schema of its input. */
export interface ToolSpec {
  readonly name: ToolName;
  readonly description: string;
  readonly input: Schema.Json;
}

/**
 * One part of a message the model is sent. `Commentary` is what a model wrote for whoever is
 * watching, which is not its answer. `Thinking` and `Unrecognised` are parts of a response that
 * only the provider that produced it reads: its adapter sends them back unchanged, in their place;
 * any other provider's adapter leaves them out.
 */
export type ContextPart =
  | { readonly _tag: "Text"; readonly text: string }
  | { readonly _tag: "Commentary"; readonly text: string }
  | {
      readonly _tag: "Thinking";
      readonly provider: ProviderName;
      readonly text: ThinkingText;
      readonly signature: ThinkingSignature;
    }
  | { readonly _tag: "ToolCall"; readonly call: CallId; readonly tool: ToolName; readonly input: Received }
  | { readonly _tag: "ToolResult"; readonly call: CallId; readonly outcome: ToolOutcome }
  | { readonly _tag: "Unrecognised"; readonly provider: ProviderName; readonly received: Received };

/**
 * One message of what the model is sent. An `instruction` is the harness speaking to the model in
 * the middle of the conversation (a notice, a changed rule); each provider adapter sends it as its
 * provider takes such messages.
 */
export interface ContextMessage {
  readonly role: "user" | "assistant" | "instruction";
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

/**
 * One request to one provider, as its adapter makes it (retries included): the response, or the
 * `AiError` it failed with. A model client is built from one or more of these, and decides what a
 * failure becomes.
 */
export type ProviderRequest = (
  target: Target,
  context: ModelContext,
  turn: TurnId,
) => Effect.Effect<Extract<Observation, { _tag: "ModelResponded" }>, AiError.AiError>;

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
