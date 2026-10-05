/**
 * How a model is to process a request, in the core's own terms.
 *
 * - Each setting is optional. A setting that is not given is left to the provider.
 * - A provider's adapter writes the settings in the provider's wire format.
 * - Where a model does not allow the value asked for, the adapter sends the nearest value that the
 *   model allows and reports `SettingAdjusted`.
 */

import { Schema } from "effect";
import { TokenCount } from "./names.ts";

/**
 * When the model thinks: when it chooses (`auto`), before every answer, only between its tool
 * calls, or never (`off`).
 */
export const ThinkingMode = Schema.Literals(["auto", "before_answer", "between_tools", "off"]);
export type ThinkingMode = typeof ThinkingMode.Type;

/**
 * How much of the model's thinking the provider is asked to return, so that the session can record
 * it: all of it, only its progress notes, or none. Whatever reads the record decides whether a
 * person sees any of it.
 */
export const Observe = Schema.Literals(["all", "progress_only", "off"]);
export type Observe = typeof Observe.Type;

/** How much effort the model puts into a response. */
export const Effort = Schema.Literals(["low", "medium", "high", "xhigh", "max"]);
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

/**
 * A setting that was not applied as asked. `asked` is the value asked for, and `used` the value
 * sent; when `used` is absent, nothing was sent for the setting. An effort can be sent where none
 * was asked for, when the model requires one.
 */
export const Adjusted = Schema.Union([
  Schema.TaggedStruct("Thinking", { asked: ThinkingMode, used: Schema.optionalKey(ThinkingMode) }),
  Schema.TaggedStruct("Observe", { asked: Observe, used: Schema.optionalKey(Observe) }),
  Schema.TaggedStruct("Effort", { asked: Schema.optionalKey(Effort), used: Schema.optionalKey(Effort) }),
  Schema.TaggedStruct("MaxOutputTokens", { asked: TokenCount, used: Schema.optionalKey(TokenCount) }),
  Schema.TaggedStruct("Cache", { asked: CacheFor, used: Schema.optionalKey(CacheFor) }),
]);
export type Adjusted = typeof Adjusted.Type;
