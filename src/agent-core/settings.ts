/**
 * How a model is to process a request, in the core's own terms. Each setting is optional: one left
 * unsaid is left to the provider. A provider's adapter puts them into its wire format, and where a
 * model cannot do what was asked it does the nearest thing and reports `SettingEnforced`.
 */

import { Schema } from "effect";
import { TokenCount } from "./names.ts";

/**
 * When the model thinks: as it sees fit, before every answer, only between its tool calls, or not
 * at all.
 */
export const ThinkingMode = Schema.Literals(["auto", "before_answer", "between_tools", "off"]);
export type ThinkingMode = typeof ThinkingMode.Type;

/**
 * What of the model's thinking the provider is asked to return, so that it can be recorded: all of
 * it, only its notes on progress, or none. Whether any of it is shown to a person is decided where
 * the record is read.
 */
export const Observe = Schema.Literals(["all", "progress_only", "off"]);
export type Observe = typeof Observe.Type;

/** How much effort the model puts into a response. */
export const Effort = Schema.Literals(["low", "medium", "high", "xhigh", "max"]);
export type Effort = typeof Effort.Type;

export const ModelSettings = Schema.Struct({
  thinking: Schema.optionalKey(ThinkingMode),
  observe: Schema.optionalKey(Observe),
  effort: Schema.optionalKey(Effort),
  /** The most tokens a response may take, thinking and answer together. */
  maxOutputTokens: Schema.optionalKey(TokenCount),
});
export type ModelSettings = typeof ModelSettings.Type;

/** A setting that was not applied as asked: what was asked, and what was used; `used` absent means nothing was. */
export const Enforced = Schema.Union([
  Schema.TaggedStruct("Thinking", { asked: ThinkingMode, used: Schema.optionalKey(ThinkingMode) }),
  Schema.TaggedStruct("Observe", { asked: Observe, used: Schema.optionalKey(Observe) }),
  Schema.TaggedStruct("Effort", { asked: Effort, used: Schema.optionalKey(Effort) }),
  Schema.TaggedStruct("MaxOutputTokens", { asked: TokenCount, used: Schema.optionalKey(TokenCount) }),
]);
export type Enforced = typeof Enforced.Type;
