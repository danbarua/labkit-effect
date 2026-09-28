/**
 * Context assembly: produces what the model is sent next. Each kind of content comes from an
 * ordered list of providers, and their outputs are appended in order. The model is chosen last,
 * because a selector may choose by the size of what was assembled.
 *
 * Where each part comes from is a service: the conversation so far, and one ordered list of
 * providers per kind. Layers supply them.
 */

import { Context, Effect } from "effect";
import type { ModelName, ProviderName } from "../agent-core/names.ts";
import type { ContextMessage, ToolSpec } from "../agent-effect/contracts.ts";

/** A model a request can go to, and how much context it takes. */
export interface ModelChoice {
  readonly provider: ProviderName;
  readonly model: ModelName;
  readonly endpoint: URL;
  /** The most tokens of context the model accepts. */
  readonly contextWindow: number;
}

/** Everything assembled except the model. */
export interface Contents {
  readonly system: ReadonlyArray<string>;
  readonly tools: ReadonlyArray<ToolSpec>;
  readonly messages: ReadonlyArray<ContextMessage>;
  readonly notices: ReadonlyArray<string>;
}

/** What assembly produces: the contents and the model they go to. */
export interface AssembledContext extends Contents {
  readonly model: ModelChoice;
}

export interface SystemPromptProvider {
  readonly system: Effect.Effect<ReadonlyArray<string>>;
}

export interface ToolCatalog {
  readonly tools: Effect.Effect<ReadonlyArray<ToolSpec>>;
}

export interface NoticeProvider {
  readonly notices: Effect.Effect<ReadonlyArray<string>>;
}

/**
 * Chooses the model for the assembled contents. Selectors run in order; each is given the choice
 * so far (undefined for the first) and returns the choice it makes.
 */
export interface ModelSelector {
  readonly select: (contents: Contents, chosen: ModelChoice | undefined) => Effect.Effect<ModelChoice>;
}

/** The conversation so far, in order. */
export class Conversation extends Context.Service<
  Conversation,
  { readonly messages: Effect.Effect<ReadonlyArray<ContextMessage>> }
>()("agent-context/Conversation") {}

export class SystemPrompts extends Context.Service<SystemPrompts, ReadonlyArray<SystemPromptProvider>>()(
  "agent-context/SystemPrompts",
) {}

export class ToolCatalogs extends Context.Service<ToolCatalogs, ReadonlyArray<ToolCatalog>>()(
  "agent-context/ToolCatalogs",
) {}

export class Notices extends Context.Service<Notices, ReadonlyArray<NoticeProvider>>()("agent-context/Notices") {}

/** At least one, so there is always a model. */
export class ModelSelectors extends Context.Service<
  ModelSelectors,
  readonly [ModelSelector, ...ReadonlyArray<ModelSelector>]
>()("agent-context/ModelSelectors") {}

const appended = <A>(outputs: ReadonlyArray<Effect.Effect<ReadonlyArray<A>>>): Effect.Effect<ReadonlyArray<A>> =>
  Effect.forEach(outputs, (output) => output).pipe(Effect.map((all) => all.flat()));

export const assemble: Effect.Effect<
  AssembledContext,
  never,
  Conversation | SystemPrompts | ToolCatalogs | Notices | ModelSelectors
> = Effect.gen(function* () {
  const contents: Contents = {
    system: yield* appended((yield* SystemPrompts).map((provider) => provider.system)),
    tools: yield* appended((yield* ToolCatalogs).map((catalog) => catalog.tools)),
    messages: yield* (yield* Conversation).messages,
    notices: yield* appended((yield* Notices).map((provider) => provider.notices)),
  };
  const [first, ...rest] = yield* ModelSelectors;
  const initial = yield* first.select(contents, undefined);
  const model = yield* Effect.reduce(
    rest,
    (): ModelChoice => initial,
    (chosen: ModelChoice, selector: ModelSelector) => selector.select(contents, chosen),
  );
  return { ...contents, model };
});
