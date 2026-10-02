/**
 * A session's settings for a Chat Completions provider. The reasoning effort is sent as
 * `reasoning_effort`, the standard Chat Completions parameter: the effort asked, or `none` for
 * thinking `off`; with no effort and no thinking setting, nothing is sent and the server uses its
 * default. An effort the model is known not to take (`efforts`) is sent as the nearest it does
 * (`effortFor`); for a model with no list, what was asked is sent, and a server that does not take
 * it refuses the request in its own words.
 *
 * Measured against a local Rapid-MLX server (vLLM-compatible) running Qwen3.5-9B: it takes `none`,
 * `minimal`, `low`, `medium`, `high` and `xhigh` and refuses `max` with a 400; its default is
 * `none`; with any effort but `none` the response carries `reasoning_content`.
 *
 * The output limit is sent as `max_tokens`; the server ends a response that reaches it with
 * `finish_reason: length`. The other settings are not sent, because what each compatible provider
 * takes for them differs; each one asked for is returned as adjusted.
 */

import type { ModelSettings } from "../../agent-machine/settings.ts";
import { type Adjustment, effortFor, type Settled } from "../configuration/settings.ts";
import type { Target } from "../contracts.ts";
import { knownOf } from "../configuration/well-known-models.ts";

const reason = "the Chat Completions adapter does not send this setting";

export function openAiCompatSettings(settings: ModelSettings = {}, efforts?: ReadonlyArray<string>): Settled {
  const { sent, adjusted: effortAdjusted } = effortFor(settings, efforts);
  const adjusted: ReadonlyArray<Adjustment> = [
    ...(settings.thinking === "before_answer" || settings.thinking === "between_tools"
      ? [{ adjusted: { _tag: "Thinking" as const, asked: settings.thinking, used: "auto" as const }, reason: "Chat Completions has no setting for when the model thinks" }]
      : []),
    ...effortAdjusted,
    ...(settings.observe === undefined ? [] : [{ adjusted: { _tag: "Observe" as const, asked: settings.observe }, reason }]),
    ...(settings.cache === undefined ? [] : [{ adjusted: { _tag: "Cache" as const, asked: settings.cache }, reason }]),
  ];
  return {
    fields: {
      ...(sent === undefined ? {} : { reasoning_effort: sent }),
      ...(settings.maxOutputTokens === undefined ? {} : { max_tokens: settings.maxOutputTokens }),
    },
    headers: {},
    adjusted,
  };
}

/** The same for a request's target: its settings, and the efforts known of its model. */
export const openAiCompatSettle = (target: Target): Settled => openAiCompatSettings(target.settings, knownOf(target)?.efforts);
