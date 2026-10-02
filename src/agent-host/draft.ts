/**
 * The draft a session is before turn zero: the model it will ask, its settings as said, its system
 * prompt and its tools. No session exists yet and nothing is recorded; a host holds the draft until
 * the first input, shows its options, changes it, then opens the session with it (`opening`) and
 * gives the session that input. A record and pure functions: a host keeps the draft where it likes.
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
  /** The settings as said. The adapter adjusts them on the request; the options show what each comes to. */
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
 * The draft with another model. The settings stay as said, even one the new model does not take:
 * the adapter sends the nearest it takes, and the options show that value.
 */
export const chooseModel = (draft: Draft, model: Asked): Draft => ({ ...draft, model });

/** The draft with the settings named in `settings` said anew; a setting not named stays as it was. */
export const saySettings = (draft: Draft, settings: ModelSettings): Draft => ({ ...draft, settings: { ...draft.settings, ...settings } });

/** The model the draft asks and its settings, as `optionsFor` and the loop take them. No settings said is none. */
export const targetOfDraft = (draft: Draft): Target => ({
  provider: draft.model.provider,
  model: draft.model.model,
  ...(Object.keys(draft.settings).length === 0 ? {} : { settings: draft.settings }),
});

/** What a host shows of the draft: its model, its settings, and each setting to offer with the value the model will get. */
export const optionsOfDraft = (draft: Draft): Effect.Effect<Options> => optionsFor(targetOfDraft(draft));

/** The `SessionOpened` observation that opens `session` with the draft's model, settings, system prompt and tools. */
export const opening = (draft: Draft, session: SessionId): Observation =>
  openedWith({ session, model: targetOfDraft(draft), system: draft.system, tools: draft.tools });

/** The output limit a draft that says none is given by `withDefaults`, where the model's own is not lower. */
const defaultOutputLimit = 32768;

/**
 * The draft with an output limit when it says none: 32768 tokens, or the model's own limit
 * (`capabilities.output`) when that is known and lower. What was said stays as said. A host that
 * leaves the limit to the provider does not apply it.
 */
export const withDefaults = (draft: Draft, capabilities: Capabilities | undefined): Draft =>
  draft.settings.maxOutputTokens !== undefined
    ? draft
    : saySettings(draft, { maxOutputTokens: TokenCount.make(Math.min(defaultOutputLimit, capabilities?.output ?? defaultOutputLimit)) });

/** The model a draft starts with: the first the catalog lists, or none when it lists none, and a host has nothing to ask. */
export const defaultModel: Effect.Effect<Asked | undefined, never, ModelCatalog> = Effect.map(askable, (models) => models[0]);
