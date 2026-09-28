/**
 * Context assembly: takes the conversation so far and produces what the model is sent next, for
 * whatever sends it on. Each kind of content comes from an ordered list of providers, and their
 * outputs are appended in order. The model is chosen last, because a selector may choose by the
 * size of what was assembled.
 */

import { Effect } from "effect";
import type { ContextMessage, ToolSpec } from "../agent-effect/contracts.ts";
import type { ModelName, ProviderName } from "../agent-core/names.ts";

/** What assembly is asked to assemble. */
export interface AssembleContext {
  /** The conversation so far, in order, as the sender gives it. */
  readonly messages: ReadonlyArray<ContextMessage>;
}

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
  readonly system: (request: AssembleContext) => Effect.Effect<ReadonlyArray<string>>;
}

export interface ToolCatalog {
  readonly tools: (request: AssembleContext) => Effect.Effect<ReadonlyArray<ToolSpec>>;
}

export interface NoticeProvider {
  readonly notices: (request: AssembleContext) => Effect.Effect<ReadonlyArray<string>>;
}

/**
 * Chooses the model for the assembled contents. Selectors run in order; each is given the choice
 * so far (undefined for the first) and returns the choice it makes.
 */
export interface ModelSelector {
  readonly select: (contents: Contents, chosen: ModelChoice | undefined) => Effect.Effect<ModelChoice>;
}

export interface Providers {
  readonly systemPrompts: ReadonlyArray<SystemPromptProvider>;
  readonly toolCatalogs: ReadonlyArray<ToolCatalog>;
  readonly notices: ReadonlyArray<NoticeProvider>;
  /** At least one, so there is always a model. */
  readonly modelSelectors: readonly [ModelSelector, ...ReadonlyArray<ModelSelector>];
}

const appended = <A>(
  providers: ReadonlyArray<(request: AssembleContext) => Effect.Effect<ReadonlyArray<A>>>,
  request: AssembleContext,
): Effect.Effect<ReadonlyArray<A>> =>
  Effect.forEach(providers, (provide) => provide(request)).pipe(Effect.map((outputs) => outputs.flat()));

export const assemble = (providers: Providers, request: AssembleContext): Effect.Effect<AssembledContext> =>
  Effect.gen(function* () {
    const contents: Contents = {
      system: yield* appended(
        providers.systemPrompts.map((provider) => provider.system),
        request,
      ),
      tools: yield* appended(
        providers.toolCatalogs.map((catalog) => catalog.tools),
        request,
      ),
      messages: request.messages,
      notices: yield* appended(
        providers.notices.map((provider) => provider.notices),
        request,
      ),
    };
    const [first, ...rest] = providers.modelSelectors;
    const initial = yield* first.select(contents, undefined);
    const model = yield* Effect.reduce(
      rest,
      (): ModelChoice => initial,
      (chosen: ModelChoice, selector: ModelSelector) => selector.select(contents, chosen),
    );
    return { ...contents, model };
  });
