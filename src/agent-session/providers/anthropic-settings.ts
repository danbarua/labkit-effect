/**
 * A session's settings as the Messages API accepts them, for one model with `capabilities` (from
 * models.dev, the measured entries and the user's overrides). The settings are put into:
 * - `thinking` (its `type`, `budget_tokens` and `display`);
 * - `output_config.effort`;
 * - a top-level `cache_control`, which marks the whole request for the cache for five minutes or,
 *   with `ttl`, an hour. Nothing is marked when the cache is off.
 *
 * The client sends the output limit, as `max_tokens`, which the API requires. A value that the model
 * does not take is sent as the nearest value it takes, or not sent, and returned as adjusted:
 *
 * - **maxOutputTokens**: a limit above the model's output limit, which the API refuses (measured with
 *   Claude Haiku 4.5, whose limit is 64,000), is sent as that limit, in this adapter's `max_tokens`.
 * - **effort**: the efforts the model takes (`effortsTaken`). A model that takes a thinking budget in
 *   place of an effort (Claude Haiku 4.5) is sent the effort as `thinking: { type: "enabled",
 *   budget_tokens }`, the budget for the effort in `budgets`, and no `output_config`.
 * - **thinking `disabled`**: sent as `type: "disabled"` to a model that can turn its thinking off
 *   (`turnsThinkingOff`: one that takes a budget); to any other, not sent.
 * - **thinking `between_tools`**: sent to a model measured to take it (Claude Sonnet 5.5), at `high`
 *   effort or below; otherwise not sent.
 * - **observe**: sent as the thinking's `display`. With thinking disabled there is nothing to return.
 *   Between-tools thinking takes no `display` and returns its progress updates as text, so `off` is
 *   sent as `progress_only`. A model that takes a budget thinks only when an effort is given: without
 *   one, it is sent no `display`. Any other model is sent `type: "adaptive"` with the `display`, as it
 *   thinks by default.
 *
 * A model of which nothing is known is sent each value as given, and the provider decides.
 */

import type { Effort, ModelSettings, Observe } from "../../agent-machine/settings.ts";
import { TokenCount } from "../../agent-machine/names.ts";
import type { Target } from "../contracts.ts";
import { type Adjustment, effortFor, type Settled } from "../configuration/settings.ts";
import { type Capabilities, effortsTaken, knownOf, turnsThinkingOff } from "../configuration/well-known-models.ts";
import type { Json } from "../shaping.ts";

const displays: Record<Observe, string> = { all: "summarized", progress_only: "updates", off: "omitted" };

/** The beta that `display: "updates"` needs. */
const updatesBeta = "thinking-display-updates-2026-08-18";

/**
 * The thinking budget sent for each effort to a model that takes a budget, as a multiple of the
 * least budget it takes (1,024 tokens for Claude Haiku 4.5): `low` is the least, then four, sixteen
 * and thirty-two times it. `max` is the largest budget the request allows. Each budget is below
 * `max_tokens`, which the API requires.
 */
const budgets: Readonly<Record<Exclude<Effort, "minimal">, number>> = { low: 1, medium: 4, high: 16, xhigh: 32, max: Number.POSITIVE_INFINITY };

/** The thinking sent, before its `display`: its `type`, and its `budget_tokens` when it is `enabled`. */
type Thinking = { readonly type: "disabled" | "between_tools" | "adaptive" } | { readonly type: "enabled"; readonly budget_tokens: TokenCount };

/** Returns the output limit sent for `asked` to a model with `capabilities`: the model's own limit when `asked` is above it. */
const limitFor = (asked: TokenCount | undefined, capabilities: Capabilities | undefined): { readonly sent: TokenCount | undefined; readonly adjusted: ReadonlyArray<Adjustment> } => {
  const output = capabilities?.output;
  if (asked === undefined || output === undefined || asked <= output) return { sent: asked, adjusted: [] };
  const used = TokenCount.make(output);
  return { sent: used, adjusted: [{ adjusted: { _tag: "MaxOutputTokens", asked, used }, reason: `this model's output limit is ${output} tokens` }] };
};

/** Returns the budget sent for `effort` to a model that takes budgets from `least`, at most `most`, and below `limit` (`max_tokens`). */
const budgetFor = (effort: Exclude<Effort, "minimal">, least: number, most: number | undefined, limit: number | undefined): TokenCount => {
  const largest = Math.min(most ?? Number.POSITIVE_INFINITY, limit === undefined ? Number.POSITIVE_INFINITY : limit - 1);
  return TokenCount.make(Math.max(least, Math.min(least * budgets[effort], largest)));
};

/** Returns the thinking sent for `settings` to a model with `capabilities`, when any, and what was adjusted. `effort` is the effort it takes, and `limit` its `max_tokens`. */
const thinkingFor = (
  settings: ModelSettings,
  capabilities: Capabilities | undefined,
  effort: Effort | undefined,
  limit: number | undefined,
): { readonly thinking: Thinking | undefined; readonly adjusted: ReadonlyArray<Adjustment> } => {
  const { thinking } = settings;
  const range = capabilities?.budget;
  if (thinking === "disabled" && turnsThinkingOff(capabilities) !== false) {
    // A budget model's effort is its budget, which thinking off leaves unsent.
    const unsent: ReadonlyArray<Adjustment> = range === undefined || settings.effort === undefined ? [] : [{ adjusted: { _tag: "Effort", asked: settings.effort }, reason: "thinking is disabled" }];
    return { thinking: { type: "disabled" }, adjusted: unsent };
  }
  const notOff: ReadonlyArray<Adjustment> = thinking === "disabled" ? [{ adjusted: { _tag: "Thinking", asked: "disabled" }, reason: "this model cannot turn its thinking off" }] : [];
  if (range !== undefined && effort !== undefined && effort !== "minimal") {
    const between: ReadonlyArray<Adjustment> = thinking === "between_tools" ? [{ adjusted: { _tag: "Thinking", asked: "between_tools" }, reason: "this model does not think only between tool calls" }] : [];
    return { thinking: { type: "enabled", budget_tokens: budgetFor(effort, range.min, range.max, limit) }, adjusted: [...notOff, ...between] };
  }
  if (thinking === "between_tools") {
    if (capabilities !== undefined && capabilities.thinking?.includes("between_tools") !== true)
      return { thinking: undefined, adjusted: [{ adjusted: { _tag: "Thinking", asked: "between_tools" }, reason: "this model does not think only between tool calls" }] };
    if (effort === "xhigh" || effort === "max")
      return { thinking: undefined, adjusted: [{ adjusted: { _tag: "Thinking", asked: "between_tools" }, reason: `thinking only between tool calls is not taken at ${effort} effort` }] };
    return { thinking: { type: "between_tools" }, adjusted: [] };
  }
  return { thinking: undefined, adjusted: notOff };
};

/** Returns the `display` sent for `observe` with the thinking sent, the thinking it goes with when none was sent for another reason, and what was adjusted. */
const displayFor = (
  observe: Observe | undefined,
  thinking: Thinking | undefined,
  capabilities: Capabilities | undefined,
): { readonly display: string | undefined; readonly thinking: Thinking | undefined; readonly adjusted: ReadonlyArray<Adjustment> } => {
  if (observe === undefined || thinking?.type === "disabled") return { display: undefined, thinking, adjusted: [] };
  if (thinking?.type === "between_tools")
    return {
      display: undefined,
      thinking,
      adjusted: observe === "off" ? [{ adjusted: { _tag: "Observe", asked: observe, used: "progress_only" }, reason: "between-tools thinking returns its progress updates as text" }] : [],
    };
  if (thinking !== undefined) return { display: displays[observe], thinking, adjusted: [] };
  if (capabilities?.budget !== undefined) return { display: undefined, thinking, adjusted: [{ adjusted: { _tag: "Observe", asked: observe }, reason: "this model thinks only when an effort is given, and none is" }] };
  return { display: displays[observe], thinking: { type: "adaptive" }, adjusted: [] };
};

export function anthropicSettings(settings: ModelSettings = {}, capabilities?: Capabilities): Settled {
  const { sent: limit, adjusted: limitAdjusted } = limitFor(settings.maxOutputTokens, capabilities);
  const { sent: effort, adjusted: effortAdjusted } = effortFor(settings.effort, effortsTaken(capabilities));
  const { thinking: asked, adjusted: thinkingAdjusted } = thinkingFor(settings, capabilities, effort, limit ?? capabilities?.output);
  const { display, thinking, adjusted: displayAdjusted } = displayFor(settings.observe, asked, capabilities);
  const thinkingField: Json | undefined = thinking === undefined ? undefined : { ...thinking, ...(display === undefined ? {} : { display }) };
  // A model that takes a budget is sent its effort as the budget, not as an effort.
  const effortSent = capabilities?.budget === undefined ? effort : undefined;
  return {
    fields: {
      ...(limitAdjusted.length === 0 || limit === undefined ? {} : { max_tokens: limit }),
      ...(thinkingField === undefined ? {} : { thinking: thinkingField }),
      ...(effortSent === undefined ? {} : { output_config: { effort: effortSent } }),
      ...(settings.cache === "5m" ? { cache_control: { type: "ephemeral" } } : {}),
      ...(settings.cache === "1h" ? { cache_control: { type: "ephemeral", ttl: "1h" } } : {}),
    },
    headers: display === displays.progress_only ? { "anthropic-beta": updatesBeta } : {},
    adjusted: [...limitAdjusted, ...effortAdjusted, ...thinkingAdjusted, ...displayAdjusted],
  };
}

/** The same mapping, for a request's target: its settings, and what is known of its model. */
export const anthropicSettle = (target: Target): Settled => anthropicSettings(target.settings, knownOf(target));
