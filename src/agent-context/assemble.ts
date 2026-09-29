/**
 * Context assembly: produces what the model is sent next. The system prompt and tools are the ones
 * the session's facts record; the system prompt providers and tool catalogs supply them when the
 * session opens (`opening`). The conversation is a view of the facts, and notices come from their
 * providers, in order, for each request. The model is chosen last, because a selector may choose by
 * the size of what was assembled.
 *
 * Each of these is a service; layers supply them.
 */

import { Context, Effect } from "effect";
import type { Fact } from "../agent-core/fact.ts";
import type { ModelName, ProviderName, SessionId } from "../agent-core/names.ts";
import type { ModelTarget, Observation } from "../agent-core/observation.ts";
import type { ContextMessage, ToolSpec } from "../agent-effect/contracts.ts";
import { openedWith, systemOf, toolsOf } from "../agent-effect/session-setup.ts";

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

/** The conversation the model is sent, as a view of the session's facts. */
export class Conversation extends Context.Service<
  Conversation,
  { readonly messages: (facts: ReadonlyArray<Fact>) => Effect.Effect<ReadonlyArray<ContextMessage>> }
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

/**
 * The opening of a session that asks `model`: its system prompt is the system prompt providers'
 * outputs in order, joined by blank lines, and its tools the tool catalogs' in order. What they
 * give is recorded, and every request is sent what was recorded, not what they would give later.
 */
export const opening = (
  session: SessionId,
  model: ModelTarget,
): Effect.Effect<Extract<Observation, { _tag: "SessionOpened" }>, never, SystemPrompts | ToolCatalogs> =>
  Effect.gen(function* () {
    const system = yield* appended((yield* SystemPrompts).map((provider) => provider.system));
    const tools = yield* appended((yield* ToolCatalogs).map((catalog) => catalog.tools));
    return openedWith({ session, model, system: system.length === 0 ? undefined : system.join("\n\n"), tools });
  });

/** Everything but the model, for the session's `facts`: the system prompt and tools as recorded. */
export const assembleContents = (
  facts: ReadonlyArray<Fact>,
): Effect.Effect<Contents, never, Conversation | Notices> =>
  Effect.gen(function* () {
    const system = systemOf(facts);
    return {
      system: system === undefined ? [] : [system],
      tools: yield* toolsOf(facts),
      messages: yield* (yield* Conversation).messages(facts),
      notices: yield* appended((yield* Notices).map((provider) => provider.notices)),
    };
  });

/** The contents for the session's `facts`, and the model they go to. */
export const assemble = (
  facts: ReadonlyArray<Fact>,
): Effect.Effect<AssembledContext, never, Conversation | Notices | ModelSelectors> =>
  Effect.gen(function* () {
    const contents = yield* assembleContents(facts);
    const [first, ...rest] = yield* ModelSelectors;
    const initial = yield* first.select(contents, undefined);
    const model = yield* Effect.reduce(
      rest,
      (): ModelChoice => initial,
      (chosen: ModelChoice, selector: ModelSelector) => selector.select(contents, chosen),
    );
    return { ...contents, model };
  });
