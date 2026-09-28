/**
 * What the loop needs from the outside world, one service per job. Each adapter implements one.
 */

import { Context, type Effect } from "effect";
import type { Fact } from "../agent-core/fact.ts";
import type { Inputs, ModelName, ProviderName, TurnId } from "../agent-core/names.ts";
import type { Observation } from "../agent-core/observation.ts";

/** Where a model request goes: which provider, which model, at which address. */
export interface Target {
  readonly provider: ProviderName;
  readonly model: ModelName;
  readonly endpoint: URL;
}

/** Chooses the model for a turn's next request. */
export class ModelProvider extends Context.Service<
  ModelProvider,
  { readonly select: (turn: TurnId) => Effect.Effect<Target> }
>()("agent-effect/ModelProvider") {}

/** One message of what the model is sent. */
export interface ContextMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
}

/** What the model is sent for one request, before any provider's wire format. */
export interface ModelContext {
  readonly system: string | undefined;
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
export class Turns extends Context.Service<
  Turns,
  { readonly start: (inputs: Inputs) => Effect.Effect<TurnId> }
>()("agent-effect/Turns") {}
