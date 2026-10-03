/**
 * What a host shows of a configuration, and offers to change: the model being asked, and each
 * setting with the value the model will get and the values to offer for it. `optionsFor` reads it
 * from a model and its settings alone, so a host can show it before any session is opened;
 * `optionsOf` reads it from a session's facts, so it follows every change of model or setting
 * taken. A host renders it as it likes (a picker, a completion, a protocol's list of options); a
 * change is reported to the session as `ModelChangeArrived`.
 *
 * The values offered are the ones the provider's adapter applies as asked (`choicesFor`). Which
 * adapter's settings function answers for a provider is `Settling`: by default the three providers
 * with well-known models; a host that reaches another provider puts its source in front.
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
import { choicesFor, settingOf, type Settled } from "./settings.ts";
import { firstAnswer } from "../first-answer.ts";
import { knownCapabilities } from "./well-known-models.ts";

export type Settle = (target: Target) => Settled;

const settling: Readonly<Record<string, Settle>> = { anthropic: anthropicSettle, openai: openAiSettle, xai: xAiSettle };

/** What one source knows of how settings are applied for a provider: its adapter's settings function, or `undefined`. */
export type SettlingSource = (provider: ProviderName) => Settle | undefined;

/** The providers with well-known models. */
export const wellKnownSettling: SettlingSource = (provider) => settling[provider];

/**
 * Which adapter's settings function answers for a provider: sources asked in order, the first that
 * knows the provider answering (`firstAnswer`). By default the providers with well-known models; a
 * host that reaches another provider puts its source in front.
 */
export const Settling = Context.Reference<ReadonlyArray<SettlingSource>>("agent-session/Settling", { defaultValue: () => [wellKnownSettling] });

/** The settings function of the adapter that reaches `provider`: the first answer of `Settling`. */
export const settleFor = (provider: ProviderName): Effect.Effect<Settle | undefined> =>
  Effect.gen(function* () {
    const sources = yield* Settling;
    return yield* firstAnswer(sources.map((source) => Effect.sync(() => source(provider))));
  });

/**
 * A setting to offer: the value the model will get (`now`), when one is sent, and for a setting
 * with a set of values, the ones to offer. Where the adapter adjusts what was said, `now` is what it
 * sends instead, so it is among `values` whenever the setting is offered.
 */
export type SettingOption =
  | { readonly _tag: "OneOf"; readonly name: keyof ModelSettings; readonly now?: string; readonly values: ReadonlyArray<string> }
  | { readonly _tag: "Number"; readonly name: keyof ModelSettings; readonly now?: number };

export interface Options {
  readonly provider: ProviderName;
  readonly model: ModelName;
  /** The settings as said; the adapter adjusts them on the request, as each option's `now` shows. */
  readonly settings: ModelSettings;
  /** The settings to offer. One the provider's adapter applies no value of is left out. */
  readonly offered: ReadonlyArray<SettingOption>;
}

/**
 * The configuration of `target`, with no session behind it. A target with no capabilities gets
 * them from `KnownModels` (`knownCapabilities`). For a provider with no settings function known, every value of every
 * setting is offered and taken as said.
 */
export const optionsFor = (target: Target): Effect.Effect<Options> =>
  Effect.gen(function* () {
    const capabilities = target.capabilities ?? (yield* knownCapabilities(target.provider, target.model));
    const settle = (yield* settleFor(target.provider)) ?? (() => ({ fields: {}, headers: {}, adjusted: [] }));
    const full: Target = { ...target, ...(capabilities === undefined ? {} : { capabilities }) };
    const { maxOutputTokens, ...listed } = choicesFor(full, settle);
    const settings = target.settings ?? {};
    const adjusted = settle(full).adjusted.map(({ adjusted }) => adjusted);
    // What the model gets: an adjustment's `used`, none when the adjustment sends nothing, else as said.
    const got = <K extends keyof ModelSettings>(name: K): ModelSettings[K] | undefined => {
      const adjustment = adjusted.find((each) => settingOf[each._tag] === name);
      return adjustment === undefined ? settings[name] : (adjustment.used as ModelSettings[K] | undefined);
    };
    const oneOf = (name: "effort" | "thinking" | "observe" | "cache"): ReadonlyArray<SettingOption> => {
      const value = got(name);
      return listed[name].length === 0 ? [] : [{ _tag: "OneOf", name, values: listed[name], ...(value === undefined ? {} : { now: value }) }];
    };
    const limit = got("maxOutputTokens");
    const options: Options = {
      provider: target.provider,
      model: target.model,
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

/** The session's configuration as `facts` have it: its model now, with the adjustments recorded. */
export const optionsOf = (facts: ReadonlyArray<Fact>) => Effect.flatMap(modelOf(facts), optionsFor);
