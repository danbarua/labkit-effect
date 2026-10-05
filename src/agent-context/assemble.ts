/**
 * Context assembly: the services that supply what the model is sent next. Layers provide them.
 * - The system prompt and tools are read from the session's facts. The system prompt providers and
 *   the tool sources supply them once, when the session opens (`opening`).
 * - The conversation is a view of the facts (`Conversation`).
 * - Notices come from their providers, in order, for each request (`Notices`).
 * - `assemble` chooses the model last, because a selector may choose by the size of the contents.
 */

import { Context, Effect } from "effect";
import type { Fact } from "../agent-machine/fact.ts";
import type { ModelName, ProviderName, SessionId } from "../agent-machine/names.ts";
import type { ModelTarget, Observation } from "../agent-machine/observation.ts";
import type { ContextMessage, ToolSpec } from "../agent-session/contracts.ts";
import { openedWith, immutableSystemPromptOf, immutableToolCatalogOf } from "../agent-session/configuration/session-setup.ts";
import { offeredTools } from "../agent-session/tool-sources.ts";

/** A model that a request can go to, with its endpoint and context window. */
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

/** The assembled contents and the model chosen for them. */
export interface AssembledContext extends Contents {
  readonly model: ModelChoice;
}

export interface SystemPromptProvider {
  readonly system: Effect.Effect<ReadonlyArray<string>>;
}

export interface NoticeProvider {
  readonly notices: Effect.Effect<ReadonlyArray<string>>;
}

/**
 * Chooses the model for the assembled contents. Selectors run in order. Each receives the choice so
 * far (undefined for the first selector) and returns its own choice.
 */
export interface ModelSelector {
  readonly select: (contents: Contents, chosen: ModelChoice | undefined) => Effect.Effect<ModelChoice>;
}

/** Returns the messages that a request carries, as a view of the session's facts. */
export class Conversation extends Context.Service<
  Conversation,
  { readonly messages: (facts: ReadonlyArray<Fact>) => Effect.Effect<ReadonlyArray<ContextMessage>> }
>()("agent-context/Conversation") {}

export class SystemPrompts extends Context.Service<SystemPrompts, ReadonlyArray<SystemPromptProvider>>()(
  "agent-context/SystemPrompts",
) {}

/**
 * The notice providers, in order; none by default. A host composes the list. Each notice is recorded
 * when it is inserted (`NoticeInserted`), so a provider may read live state, not only the facts.
 */
export const Notices = Context.Reference<ReadonlyArray<NoticeProvider>>("agent-context/Notices", { defaultValue: () => [] });

/** The model selectors, in order. The list holds at least one selector, so a model is always chosen. */
export class ModelSelectors extends Context.Service<
  ModelSelectors,
  readonly [ModelSelector, ...ReadonlyArray<ModelSelector>]
>()("agent-context/ModelSelectors") {}

const appended = <A>(outputs: ReadonlyArray<Effect.Effect<ReadonlyArray<A>>>): Effect.Effect<ReadonlyArray<A>> =>
  Effect.forEach(outputs, (output) => output).pipe(Effect.map((all) => all.flat()));

/**
 * Returns the `SessionOpened` observation for a session that asks `model`.
 * - The system prompt is the system prompt providers' outputs, in order, joined by blank lines.
 * - The tools are those that the tool sources offer (`ToolSources`), in order.
 *
 * Every request is sent what this observation records, not what the providers would give later.
 */
export const opening = (
  session: SessionId,
  model: ModelTarget,
): Effect.Effect<Extract<Observation, { _tag: "SessionOpened" }>, never, SystemPrompts> =>
  Effect.gen(function* () {
    const system = yield* appended((yield* SystemPrompts).map((provider) => provider.system));
    const tools = yield* offeredTools;
    return openedWith({ session, model, system: system.length === 0 ? undefined : system.join("\n\n"), tools });
  });

/** Returns the contents of the next request for the session's `facts`: the system prompt and tools as recorded, the conversation, and the notices. */
export const assembleContents = (
  facts: ReadonlyArray<Fact>,
): Effect.Effect<Contents, never, Conversation> =>
  Effect.gen(function* () {
    const system = immutableSystemPromptOf(facts);
    return {
      system: system === undefined ? [] : [system],
      tools: yield* immutableToolCatalogOf(facts),
      messages: yield* (yield* Conversation).messages(facts),
      notices: yield* appended((yield* Notices).map((provider) => provider.notices)),
    };
  });

/** Returns the contents of the next request, and the model that the selectors choose for them. */
export const assemble = (
  facts: ReadonlyArray<Fact>,
): Effect.Effect<AssembledContext, never, Conversation | ModelSelectors> =>
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
