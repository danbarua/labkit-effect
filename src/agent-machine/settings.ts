/**
 * How a model is to process a request, in the core's own terms. A setting is the intent of whoever
 * set it: a person, or a policy.
 *
 * - Each setting is optional. A setting that is not given is left to the provider: its default.
 * - A change of settings (`SettingsChange`) names each setting it changes. `default` returns a
 *   setting to the provider's default.
 * - A provider's adapter writes the settings in the provider's wire format. Where a model does not
 *   take the value given, the adapter sends the nearest value that the model takes, or nothing when
 *   the model has no counterpart, and reports `SettingAdjusted`.
 */

import { Schema } from "effect";
import { TokenCount } from "./names.ts";

/**
 * How the model thinks, other than as the provider decides by default: not at all (`disabled`), or
 * only between its tool calls (`between_tools`).
 */
export const ThinkingMode = Schema.Literals(["disabled", "between_tools"]);
export type ThinkingMode = typeof ThinkingMode.Type;

/**
 * How much of the model's thinking the provider is asked to return, so that the session can record
 * it: all of it, only its progress notes, or none. Whatever reads the record decides whether a
 * person sees any of it.
 */
export const Observe = Schema.Literals(["all", "progress_only", "off"]);
export type Observe = typeof Observe.Type;

/**
 * How much effort the model puts into a response, least first. A provider's adapter sends it in the
 * provider's terms: as an effort, or as a number of tokens to think for (a thinking budget). A model
 * that is to do no reasoning at all is given `thinking: disabled`, which a provider may send as an
 * effort of its own (`none`).
 */
export const Effort = Schema.Literals(["minimal", "low", "medium", "high", "xhigh", "max"]);
export type Effort = typeof Effort.Type;

/**
 * The minimum time for which the provider is asked to cache what a request carried, so that later
 * requests that begin with the same content read it from the cache instead of paying for it again:
 * not at all (`off`), five minutes, or one hour.
 */
export const CacheFor = Schema.Literals(["off", "5m", "1h"]);
export type CacheFor = typeof CacheFor.Type;

export const ModelSettings = Schema.Struct({
  thinking: Schema.optionalKey(ThinkingMode),
  observe: Schema.optionalKey(Observe),
  effort: Schema.optionalKey(Effort),
  /** The maximum number of tokens that a response may use, thinking and answer together. */
  maxOutputTokens: Schema.optionalKey(TokenCount),
  cache: Schema.optionalKey(CacheFor),
});
export type ModelSettings = typeof ModelSettings.Type;

/** A setting's value, or `default`: the provider's default, which sends nothing for the setting. */
const orDefault = <S extends Schema.Top>(schema: S) => Schema.Union([schema, Schema.Literal("default")]);

/** A change of the settings: each setting named, with its new value or `default`. A setting not named keeps its value. */
export const SettingsChange = Schema.Struct({
  thinking: Schema.optionalKey(orDefault(ThinkingMode)),
  observe: Schema.optionalKey(orDefault(Observe)),
  effort: Schema.optionalKey(orDefault(Effort)),
  maxOutputTokens: Schema.optionalKey(orDefault(TokenCount)),
  cache: Schema.optionalKey(orDefault(CacheFor)),
});
export type SettingsChange = typeof SettingsChange.Type;

/** Returns `settings` with `change` applied: each setting it names takes its value, and a setting it names as `default` is removed. */
export const changed = (settings: ModelSettings, change: SettingsChange): ModelSettings =>
  Object.entries(change).reduce<ModelSettings>((now, [name, value]) => {
    const { [name as keyof ModelSettings]: _, ...rest } = now;
    return value === "default" || value === undefined ? rest : { ...rest, [name]: value };
  }, settings);

/**
 * A setting that was not sent as given. `asked` is the value given, and `used` the value sent; when
 * `used` is absent, nothing was sent for the setting. An effort can be sent where none was given,
 * when the model requires one.
 */
export const Adjusted = Schema.Union([
  Schema.TaggedStruct("Thinking", { asked: ThinkingMode, used: Schema.optionalKey(ThinkingMode) }),
  Schema.TaggedStruct("Observe", { asked: Observe, used: Schema.optionalKey(Observe) }),
  Schema.TaggedStruct("Effort", { asked: Schema.optionalKey(Effort), used: Schema.optionalKey(Effort) }),
  Schema.TaggedStruct("MaxOutputTokens", { asked: TokenCount, used: Schema.optionalKey(TokenCount) }),
  Schema.TaggedStruct("Cache", { asked: CacheFor, used: Schema.optionalKey(CacheFor) }),
]);
export type Adjusted = typeof Adjusted.Type;
