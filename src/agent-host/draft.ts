/**
 * A draft: a session before its first turn. It holds the model to ask, the settings as given, the
 * system prompt and the tools. No session exists yet and nothing is recorded. A host keeps the draft
 * until the first input, shows its options, changes it, then opens the session with it (`opening`)
 * and gives the session that input. The draft is a plain record with pure functions, so a host keeps
 * it wherever it likes.
 */

import { Effect } from "effect";
import { type SessionId, TokenCount } from "../agent-machine/names.ts";
import type { Observation } from "../agent-machine/observation.ts";
import type { ModelSettings } from "../agent-machine/settings.ts";
import { optionsFor, type Options } from "../agent-session/configuration/options.ts";
import { openedWith } from "../agent-session/configuration/session-setup.ts";
import type { Capabilities } from "../agent-session/configuration/well-known-models.ts";
import type { Target, ToolSpec } from "../agent-session/contracts.ts";
import { type Asked, askable, type ModelCatalog } from "./catalog.ts";

export interface Draft {
  readonly model: Asked;
  /** The settings as given. The adapter adjusts them on the request; the options show the value each setting takes. */
  readonly settings: ModelSettings;
  readonly system: string | undefined;
  readonly tools: ReadonlyArray<ToolSpec>;
}

export const draftOf = (draft: {
  readonly model: Asked;
  readonly settings?: ModelSettings;
  readonly system?: string;
  readonly tools?: ReadonlyArray<ToolSpec>;
}): Draft => ({ model: draft.model, settings: draft.settings ?? {}, system: draft.system, tools: draft.tools ?? [] });

/**
 * Returns the draft with another model. The settings stay as given, even one that the new model does
 * not accept: the adapter sends the nearest accepted value, and the options show that value.
 */
export const chooseModel = (draft: Draft, model: Asked): Draft => ({ ...draft, model });

/** Returns the draft with the settings named in `settings` replaced; a setting not named keeps its value. */
export const saySettings = (draft: Draft, settings: ModelSettings): Draft => ({ ...draft, settings: { ...draft.settings, ...settings } });

/** Returns the model that the draft asks and its settings, in the form `optionsFor` and the loop accept. A draft with no settings has no `settings` field. */
export const targetOfDraft = (draft: Draft): Target => ({
  provider: draft.model.provider,
  model: draft.model.model,
  ...(Object.keys(draft.settings).length === 0 ? {} : { settings: draft.settings }),
});

/** Returns what a host shows of the draft: its model, its settings, and each setting to offer with the value that the model will get. */
export const optionsOfDraft = (draft: Draft): Effect.Effect<Options> => optionsFor(targetOfDraft(draft));

/** Returns the `SessionOpened` observation that opens `session` with the draft's model, settings, system prompt and tools. */
export const opening = (draft: Draft, session: SessionId): Observation =>
  openedWith({ session, model: targetOfDraft(draft), system: draft.system, tools: draft.tools });

/** The output limit that `withDefaults` gives a draft with none, unless the model's own limit is lower. */
const defaultOutputLimit = 32768;

/**
 * Returns the draft with an output limit when it has none: 32768 tokens, or the model's own limit
 * (`capabilities.output`) when that is known and lower. A limit that was given stays. A host that
 * leaves the limit to the provider does not call this.
 */
export const withDefaults = (draft: Draft, capabilities: Capabilities | undefined): Draft =>
  draft.settings.maxOutputTokens !== undefined
    ? draft
    : saySettings(draft, { maxOutputTokens: TokenCount.make(Math.min(defaultOutputLimit, capabilities?.output ?? defaultOutputLimit)) });

/** The model that a draft starts with: the first that the catalog lists, or none when it lists none, in which case a host has nothing to ask. */
export const defaultModel: Effect.Effect<Asked | undefined, never, ModelCatalog> = Effect.map(askable, (models) => models[0]);
