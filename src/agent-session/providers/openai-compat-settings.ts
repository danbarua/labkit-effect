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
 * The other settings are not sent, because what each compatible provider takes for them differs;
 * each one asked for is returned as enforced.
 */

import type { ModelSettings } from "../../agent-machine/settings.ts";
import { type Enforcement, effortFor, type Settled } from "../settings.ts";

const reason = "the Chat Completions adapter does not send this setting";

export function openAiCompatSettings(settings: ModelSettings = {}, efforts?: ReadonlyArray<string>): Settled {
  const { sent, enforced: effortEnforced } = effortFor(settings, efforts);
  const enforced: ReadonlyArray<Enforcement> = [
    ...(settings.thinking === "before_answer" || settings.thinking === "between_tools"
      ? [{ enforced: { _tag: "Thinking" as const, asked: settings.thinking, used: "auto" as const }, reason: "Chat Completions has no setting for when the model thinks" }]
      : []),
    ...effortEnforced,
    ...(settings.observe === undefined ? [] : [{ enforced: { _tag: "Observe" as const, asked: settings.observe }, reason }]),
    ...(settings.maxOutputTokens === undefined
      ? []
      : [{ enforced: { _tag: "MaxOutputTokens" as const, asked: settings.maxOutputTokens }, reason }]),
    ...(settings.cache === undefined ? [] : [{ enforced: { _tag: "Cache" as const, asked: settings.cache }, reason }]),
  ];
  return { fields: sent === undefined ? {} : { reasoning_effort: sent }, headers: {}, enforced };
}
