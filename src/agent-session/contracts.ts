/**
 * What the loop needs from the outside world, one service per job. Each adapter implements one.
 */

import { BlobRef } from "../agent-machine/blob.ts";
import { Context, type Effect, Schema } from "effect";
import type { Fact } from "../agent-machine/fact.ts";
import { CallId, type ModelName, ProviderName, ThinkingText, ToolName, type TurnId } from "../agent-machine/names.ts";
import { type Observation, ToolOutcome } from "../agent-machine/observation.ts";
import { Received } from "../agent-machine/received.ts";
import type { ModelSettings } from "../agent-machine/settings.ts";
import type { RequestFailed } from "./provider-call.ts";

/**
 * Which model a request goes to, and how it is to process the request, where that was said. Where
 * the provider is reached is its client's configuration.
 */
export interface Target {
  readonly provider: ProviderName;
  readonly model: ModelName;
  readonly settings?: ModelSettings;
}

/** Chooses the model for a turn's next request, given the session's facts. */
export class ModelProvider extends Context.Service<
  ModelProvider,
  { readonly select: (facts: ReadonlyArray<Fact>, turn: TurnId) => Effect.Effect<Target> }
>()("agent-session/ModelProvider") {}

/** A tool the model may call: its name, what it does, and the JSON Schema of its input. */
export const ToolSpec = Schema.Struct({ name: ToolName, description: Schema.String, input: Schema.Json });
export type ToolSpec = typeof ToolSpec.Type;

/**
 * One part of a message the model is sent. `Commentary` is what a model wrote for whoever is
 * watching, which is not its answer. `Thinking` and `Unrecognised` are parts of a response that
 * only the provider that produced it reads: its adapter sends them back unchanged, in their place;
 * any other provider's adapter leaves them out.
 */
export const ContextPart = Schema.Union([
  Schema.TaggedStruct("Text", { text: Schema.String }),
  Schema.TaggedStruct("Commentary", { text: Schema.String }),
  Schema.TaggedStruct("Thinking", { provider: ProviderName, text: ThinkingText, received: Received }),
  Schema.TaggedStruct("ToolCall", { call: CallId, tool: ToolName, input: Received }),
  Schema.TaggedStruct("ToolResult", { call: CallId, outcome: ToolOutcome }),
  Schema.TaggedStruct("Unrecognised", { provider: ProviderName, received: Received }),
  /** A file, by reference: the adapter reads its bytes from the blob store when it makes the request. */
  Schema.TaggedStruct("File", { blob: BlobRef }),
]);
export type ContextPart = typeof ContextPart.Type;

/**
 * One message of what the model is sent. An `instruction` is the harness speaking to the model in
 * the middle of the conversation (a notice, a changed rule); each provider adapter sends it as its
 * provider takes such messages.
 */
export const ContextMessage = Schema.Struct({
  role: Schema.Literals(["user", "assistant", "instruction"]),
  parts: Schema.Array(ContextPart),
});
export type ContextMessage = typeof ContextMessage.Type;

/**
 * What the model is sent for one request, before any provider's wire format. It is recorded with
 * the request (`ModelRequestDispatched.sent`), so the record says what each request carried.
 */
export const ModelContext = Schema.Struct({
  system: Schema.UndefinedOr(Schema.String),
  tools: Schema.Array(ToolSpec),
  messages: Schema.Array(ContextMessage),
});
export type ModelContext = typeof ModelContext.Type;

/** Builds what the model is sent for a turn's next request, from the session's facts. */
export class ContextAssembler extends Context.Service<
  ContextAssembler,
  { readonly assemble: (facts: ReadonlyArray<Fact>, turn: TurnId) => Effect.Effect<ModelContext> }
>()("agent-session/ContextAssembler") {}

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
>()("agent-session/ModelClient") {}

/**
 * One request to one provider, as its adapter makes it (retries included): the response, or the
 * `AiError` it failed with and the request as it was made (`RequestFailed`). A model client is built from one or more of these, and decides what a
 * failure becomes.
 */
export type ProviderRequest = (
  target: Target,
  context: ModelContext,
  turn: TurnId,
) => Effect.Effect<Extract<Observation, { _tag: "ModelResponded" }>, RequestFailed>;

/** Starts a turn and chooses its identity. */
export class Turns extends Context.Service<Turns, { readonly start: Effect.Effect<TurnId> }>()(
  "agent-session/Turns",
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
>()("agent-session/TurnEndHooks") {}

/** Runs one tool call and reports how it ended. */
export class ToolRunner extends Context.Service<
  ToolRunner,
  { readonly run: (tool: ToolName, input: Received) => Effect.Effect<ToolOutcome> }
>()("agent-session/ToolRunner") {}
