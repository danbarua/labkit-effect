/**
 * What a host shows of a session's configuration, and offers to change: the model being asked, and
 * each setting with its value now and the values to offer for it. It is read from the session's
 * facts, so it follows every change of model or setting taken. A host renders it as it likes (a
 * picker, a completion, a protocol's list of options); a change is reported to the session as
 * `ModelChangeArrived`.
 *
 * The values offered are the ones the provider's adapter applies as asked (`choicesFor`). Which
 * adapter's settings function answers for a provider is `Settling`: by default the three providers
 * with well-known models; a host that reaches another provider says which answers for it.
 */

import { Context, Effect } from "effect";
import type { Fact } from "../../agent-machine/fact.ts";
import type { ModelName, ProviderName } from "../../agent-machine/names.ts";
import type { ModelSettings } from "../../agent-machine/settings.ts";
import type { Target } from "../contracts.ts";
import { anthropicSettle } from "../providers/anthropic-settings.ts";
import { openAiSettle } from "../providers/openai-settings.ts";
import { xAiSettle } from "../providers/xai-settings.ts";
import { modelOf } from "./session-setup.ts";
import { choicesFor, type Settled } from "./settings.ts";
import { KnownModels } from "./well-known-models.ts";

export type Settle = (target: Target) => Settled;

const settling: Readonly<Record<string, Settle>> = { anthropic: anthropicSettle, openai: openAiSettle, xai: xAiSettle };

/** The settings function of the adapter that reaches `provider`, when one is known. */
export const Settling = Context.Reference<(provider: ProviderName) => Settle | undefined>("agent-session/Settling", {
  defaultValue: () => (provider) => settling[provider],
});

/** A setting to offer: its value now, when one is in force, and for a setting with a set of values, the ones to offer. */
export type SettingOption =
  | { readonly _tag: "OneOf"; readonly name: keyof ModelSettings; readonly now?: string; readonly values: ReadonlyArray<string> }
  | { readonly _tag: "Number"; readonly name: keyof ModelSettings; readonly now?: number };

export interface Options {
  readonly provider: ProviderName;
  readonly model: ModelName;
  /** The settings in force, as the next request goes with them. */
  readonly settings: ModelSettings;
  /** The settings to offer. One the provider's adapter applies no value of is left out. */
  readonly offered: ReadonlyArray<SettingOption>;
}

/**
 * The session's configuration as `facts` have it. For a provider with no settings function known,
 * every value of every setting is offered.
 */
export const optionsOf = (facts: ReadonlyArray<Fact>) =>
  Effect.gen(function* () {
    const now = yield* modelOf(facts);
    const capabilities = yield* (yield* KnownModels)(now.provider, now.model);
    const settle = (yield* Settling)(now.provider) ?? (() => ({ fields: {}, headers: {}, adjusted: [] }));
    const { maxOutputTokens, ...listed } = choicesFor({ ...now, ...(capabilities === undefined ? {} : { capabilities }) }, settle);
    const settings = now.settings ?? {};
    const oneOf = (name: "effort" | "thinking" | "observe" | "cache"): ReadonlyArray<SettingOption> => {
      const value = settings[name];
      return listed[name].length === 0 ? [] : [{ _tag: "OneOf", name, values: listed[name], ...(value === undefined ? {} : { now: value }) }];
    };
    const limit = settings.maxOutputTokens;
    const options: Options = {
      provider: now.provider,
      model: now.model,
      settings,
      offered: [
        ...oneOf("effort"),
        ...oneOf("thinking"),
        ...oneOf("observe"),
        ...oneOf("cache"),
        ...(maxOutputTokens ? [{ _tag: "Number" as const, name: "maxOutputTokens" as const, ...(limit === undefined ? {} : { now: limit }) }] : []),
      ],
    };
    return options;
  });
