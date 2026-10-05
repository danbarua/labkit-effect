/**
 * A session's settings as the Messages API accepts them, for one model. The settings are put into:
 * - `thinking` (its `type` and `display`);
 * - `output_config.effort`;
 * - a top-level `cache_control`, which marks the whole request for the cache for five minutes or,
 *   with `ttl`, an hour. Nothing is marked when the cache is off.
 *
 * The adapter sends the output limit itself, as `max_tokens`, which the API requires. Where a class
 * of models does not allow the value asked, the nearest allowed value is sent and the difference is
 * returned as adjusted. A model in no class here is sent the value asked, and the provider decides.
 */

import type { ModelName } from "../../agent-machine/names.ts";
import type { Effort, ModelSettings, Observe, ThinkingMode } from "../../agent-machine/settings.ts";
import type { Target } from "../contracts.ts";
import type { Adjustment, Settled } from "../configuration/settings.ts";
import type { Json } from "../shaping.ts";

interface Allowed {
  readonly used: ThinkingMode;
  /** Why `used` differs from the value asked; absent when it does not. */
  readonly reason?: string;
}

/** Classes of models that allow the same thinking settings. */
interface ModelClass {
  readonly matches: (model: string) => boolean;
  readonly thinking: (asked: ThinkingMode, effort: Effort | undefined) => Allowed;
}

const aboveHigh = (effort: Effort | undefined): boolean => effort === "xhigh" || effort === "max";

const classes: ReadonlyArray<ModelClass> = [
  {
    // Thinking cannot be turned off, and there is no between-tools mode.
    matches: (model) => /^claude-(opus-5-5|fable-5|mythos-5)/.test(model),
    thinking: (asked) => {
      if (asked === "off") return { used: "auto", reason: "this model does not allow thinking to be turned off" };
      if (asked === "between_tools") return { used: "auto", reason: "this model has no between-tools thinking" };
      return { used: asked };
    },
  },
  {
    // Thinking cannot be turned off; between-tools is its lowest setting, accepted at high effort or below.
    matches: (model) => model.startsWith("claude-sonnet-5-5"),
    thinking: (asked, effort) => {
      if (asked !== "off" && asked !== "between_tools") return { used: asked };
      if (aboveHigh(effort)) return { used: "auto", reason: `between-tools thinking is not accepted at ${effort} effort` };
      return asked === "off"
        ? { used: "between_tools", reason: "this model does not allow thinking to be turned off; between tools is its lowest setting" }
        : { used: asked };
    },
  },
];

const types: Record<Exclude<ThinkingMode, "before_answer">, string> = {
  auto: "adaptive",
  between_tools: "between_tools",
  off: "disabled",
};

const displays: Record<Observe, string> = { all: "summarized", progress_only: "updates", off: "omitted" };

/** The beta that `display: "updates"` needs. */
const updatesBeta = "thinking-display-updates-2026-08-18";

type SentThinking = Exclude<ThinkingMode, "before_answer">;

/** Returns the thinking that `model` is sent when `asked` is requested, and what was adjusted. */
const thinkingFor = (
  model: ModelName,
  asked: ThinkingMode | undefined,
  effort: Effort | undefined,
): { readonly thinking: SentThinking | undefined; readonly adjusted: ReadonlyArray<Adjustment> } => {
  if (asked === undefined) return { thinking: undefined, adjusted: [] };
  // The Messages API has no setting that makes a model think before every answer.
  const sayable: Allowed =
    asked === "before_answer"
      ? { used: "auto", reason: "the Messages API has no setting for thinking before every answer" }
      : { used: asked };
  const allowed = classes.find((each) => each.matches(model))?.thinking(sayable.used, effort) ?? { used: sayable.used };
  const reason = allowed.reason ?? sayable.reason;
  return {
    thinking: allowed.used === "before_answer" ? "auto" : allowed.used,
    adjusted: reason === undefined ? [] : [{ adjusted: { _tag: "Thinking", asked, used: allowed.used }, reason }],
  };
};

/** Returns the `display` sent for `observe` when the thinking sent is `thinking`, and what was adjusted. */
const displayFor = (
  observe: Observe | undefined,
  thinking: SentThinking | undefined,
): { readonly display: string | undefined; readonly adjusted: ReadonlyArray<Adjustment> } => {
  if (observe === undefined || thinking === "off") return { display: undefined, adjusted: [] };
  if (thinking !== "between_tools") return { display: displays[observe], adjusted: [] };
  // `between_tools` takes no `display`, and returns its progress updates as text whatever is asked.
  return {
    display: undefined,
    adjusted:
      observe === "off"
        ? [{ adjusted: { _tag: "Observe", asked: observe, used: "progress_only" }, reason: "between-tools thinking returns its progress updates as text" }]
        : [],
  };
};

export function anthropicSettings(model: ModelName, settings: ModelSettings = {}): Settled {
  const { thinking, adjusted: thinkingAdjusted } = thinkingFor(model, settings.thinking, settings.effort);
  const { display, adjusted: displayAdjusted } = displayFor(settings.observe, thinking);

  const thinkingField: Json | undefined =
    thinking === undefined && display === undefined
      ? undefined
      : { type: types[thinking ?? "auto"], ...(display === undefined ? {} : { display }) };
  return {
    fields: {
      ...(thinkingField === undefined ? {} : { thinking: thinkingField }),
      ...(settings.effort === undefined ? {} : { output_config: { effort: settings.effort } }),
      ...(settings.cache === "5m" ? { cache_control: { type: "ephemeral" } } : {}),
      ...(settings.cache === "1h" ? { cache_control: { type: "ephemeral", ttl: "1h" } } : {}),
    },
    headers: display === displays.progress_only ? { "anthropic-beta": updatesBeta } : {},
    adjusted: [...thinkingAdjusted, ...displayAdjusted],
  };
}

/** The same mapping, for a request's target. */
export const anthropicSettle = (target: Target): Settled => anthropicSettings(target.model, target.settings);
