/** The services that the loop needs from outside, one per job. Each adapter implements one. */

import type { Capabilities } from "./configuration/well-known-models.ts";
import { BlobRef } from "../agent-machine/blob.ts";
import { Context, Effect, Schema } from "effect";
import type { Policy } from "../agent-policy/policy.ts";
import type { Fact } from "../agent-machine/fact.ts";
import { CallId, ModelName, ProviderName, ThinkingText, ToolKind, ToolName, ToolReplay, TurnId, WindowId } from "../agent-machine/names.ts";
import { type Observation, ToolOutcome } from "../agent-machine/observation.ts";
import { Received } from "../agent-machine/received.ts";
import type { ModelSettings } from "../agent-machine/settings.ts";
import type { RequestFailed } from "./provider-call.ts";

/**
 * The model that a request goes to, and the settings for the request, where they were given. The
 * provider's address is part of its client's configuration, not of the target.
 */
export interface Target {
  readonly provider: ProviderName;
  readonly model: ModelName;
  readonly settings?: ModelSettings;
  /** What is known of the model, which the adapter shapes the request to; when absent, the well-known models' entry is used. */
  readonly capabilities?: Capabilities;
}

/** Chooses the model for a turn's next request, given the session's facts. */
export class ModelProvider extends Context.Service<
  ModelProvider,
  { readonly select: (facts: ReadonlyArray<Fact>, turn: TurnId) => Effect.Effect<Target> }
>()("agent-session/ModelProvider") {}

/**
 * A tool the model may call: its name, what it does, the JSON Schema of its input, its kind
 * (`ToolKind`), and whether it can be run again (`ToolReplay`). Kind and replay are not sent to
 * models.
 *
 * A tool that is `constrained` is sent so that the provider constrains the model, while it writes a
 * call to the tool, to input that the schema accepts (Anthropic's strict tool use). Only the
 * Anthropic adapter sends it; the other adapters log a warning that it was not sent.
 */
export const ToolSpec = Schema.Struct({
  name: ToolName,
  description: Schema.String,
  input: Schema.Json,
  kind: ToolKind,
  replay: ToolReplay,
  constrained: Schema.optionalKey(Schema.Literal(true)),
  /** The names of its inputs that are paths to files or folders, which the permission policy judges. */
  paths: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type ToolSpec = typeof ToolSpec.Type;

/**
 * Where a provider's own part in a context came from: a model's response, in a turn; or the
 * provider's compaction of a window of the conversation.
 */
export const PartSource = Schema.Union([
  Schema.TaggedStruct("Response", { model: ModelName, turn: TurnId }),
  Schema.TaggedStruct("Compaction", { window: WindowId }),
]);
export type PartSource = typeof PartSource.Type;

/**
 * One part of a message that the model is sent. `Commentary` is what a model wrote for whoever is
 * watching, which is not its answer. `Thinking` and `Unrecognised` are parts of a response that only
 * their source provider reads: an adapter sends them back unchanged, in their place, to that
 * provider. To any other provider, thinking is sent as its text and any other part is omitted
 * (`sentBack`). Each part records its source (`PartSource`).
 */
export const ContextPart = Schema.Union([
  Schema.TaggedStruct("Text", { text: Schema.String }),
  Schema.TaggedStruct("Commentary", { text: Schema.String }),
  Schema.TaggedStruct("Thinking", { provider: ProviderName, from: PartSource, text: ThinkingText, received: Received }),
  Schema.TaggedStruct("ToolCall", { call: CallId, tool: ToolName, input: Received }),
  Schema.TaggedStruct("ToolResult", { call: CallId, outcome: ToolOutcome }),
  Schema.TaggedStruct("Unrecognised", { provider: ProviderName, from: PartSource, received: Received }),
  /** A file, by reference: the adapter reads its bytes from the blob store when it makes the request. */
  Schema.TaggedStruct("File", { blob: BlobRef }),
]);
export type ContextPart = typeof ContextPart.Type;

/**
 * One message that the model is sent. An `instruction` is the harness speaking to the model in the
 * middle of the conversation (a notice, a changed rule); each provider adapter sends it in the form
 * that its provider accepts.
 */
export const ContextMessage = Schema.Struct({
  role: Schema.Literals(["user", "assistant", "instruction"]),
  parts: Schema.Array(ContextPart),
});
export type ContextMessage = typeof ContextMessage.Type;

/**
 * What the model is sent for one request, before any provider's wire format. It is recorded with
 * the request (`ModelRequestDispatched.sent`), so the record says what each request carried.
 *
 * With `toolChoice: "required"`, the model must answer with a call to one of `tools`. Without it, the
 * model chooses whether to call one. Only the Anthropic adapter sends it (`tool_choice` `any`); the
 * other adapters log a warning that it was not sent.
 */
export const ModelContext = Schema.Struct({
  system: Schema.UndefinedOr(Schema.String),
  tools: Schema.Array(ToolSpec),
  messages: Schema.Array(ContextMessage),
  toolChoice: Schema.optionalKey(Schema.Literal("required")),
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
 * One request to one provider, as its adapter makes it, retries included. It returns the response,
 * or fails with the `AiError` and the request as it was made (`RequestFailed`). A model client is
 * built from one or more of these and decides what a failure becomes.
 */
export type ProviderRequest = (
  target: Target,
  context: ModelContext,
  turn: TurnId,
) => Effect.Effect<Extract<Observation, { _tag: "ModelResponded" }>, RequestFailed>;

/** Returns the identity of a turn that is starting. */
export class Turns extends Context.Service<Turns, { readonly start: Effect.Effect<TurnId> }>()(
  "agent-session/Turns",
) {}

/**
 * Runs before `turn` may end, as the session's facts stand, and returns feedback for the model. The
 * turn receives the feedback as input, which holds the turn open. No feedback lets the turn end.
 */
export type TurnEndHook = (facts: ReadonlyArray<Fact>, turn: TurnId) => Effect.Effect<ReadonlyArray<string>>;

/** The hooks that run before a turn may end, in order; the turn is given their feedback in that order. None by default. */
export const TurnEndHooks = Context.Reference<ReadonlyArray<TurnEndHook>>("agent-session/TurnEndHooks", { defaultValue: () => [] });

/**
 * How many times the turn-end hooks may hold one turn open. After that, further feedback is not
 * given to the turn, and the turn ends. 0 by default: a host that runs hooks sets it.
 */
export const MaxHolds = Context.Reference<number>("agent-session/MaxHolds", { defaultValue: () => 0 });

/** Runs one tool call and returns how it ended. `call` lets a host show the call while it runs. */
export class ToolRunner extends Context.Service<
  ToolRunner,
  { readonly run: (tool: ToolName, input: Received, call: CallId) => Effect.Effect<ToolOutcome> }
>()("agent-session/ToolRunner") {}

/** Returns a policy as the session's facts stand when the request that it reviews is about to be carried out. */
export type PolicyOfFacts = (facts: ReadonlyArray<Fact>) => Effect.Effect<Policy<unknown>>;

/** A policy in a list, with the name that the list gives it. Its vetoes and questions are recorded as coming from that name. */
export interface NamedPolicy {
  readonly name: string;
  readonly policy: PolicyOfFacts;
}

/**
 * The policies each tool call goes through before it runs, in order (`every`: the first veto is the
 * verdict). None by default, so every call runs. What a waiting policy asks is recorded
 * (`PermissionAsked`), and its answer is whatever is observed for the call (`PermissionAnswered`).
 */
export const ToolCallPolicies = Context.Reference<ReadonlyArray<NamedPolicy>>("agent-session/ToolCallPolicies", {
  defaultValue: () => [],
});

/**
 * The policies each model request goes through before it is made, in order, as `ToolCallPolicies`.
 * None by default. A veto ends the request's turn (`ModelVetoed`). A policy that waits fails the
 * request (`ModelFailed`), telling the user to wait: nothing wakes it.
 */
export const ModelRequestPolicies = Context.Reference<ReadonlyArray<NamedPolicy>>("agent-session/ModelRequestPolicies", {
  defaultValue: () => [],
});
