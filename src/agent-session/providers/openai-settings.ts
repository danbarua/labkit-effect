/**
 * A session's settings as the Responses API takes them: `reasoning.effort`, `reasoning.summary`,
 * `max_output_tokens` and `prompt_cache_retention`. The API has no setting for when a model thinks,
 * other than not at all (effort `none`). It caches every long enough request, for minutes, in
 * memory; asked to keep it for an hour, it is asked for its longer retention, 24 hours. A setting
 * it cannot take is returned as enforced.
 */

import type { ModelSettings } from "../../agent-machine/settings.ts";
import type { Enforcement, Settled } from "../settings.ts";

export function openAiSettings(settings: ModelSettings = {}): Settled {
  const enforced: Array<Enforcement> = [];
  const { thinking, observe, effort, maxOutputTokens, cache } = settings;
  if (cache === "off")
    enforced.push({
      enforced: { _tag: "Cache", asked: cache, used: "5m" },
      reason: "the Responses API caches every long enough request for minutes, and cannot be asked not to",
    });
  if (thinking === "before_answer" || thinking === "between_tools")
    enforced.push({
      enforced: { _tag: "Thinking", asked: thinking, used: "auto" },
      reason: "the Responses API has no setting for when the model thinks",
    });
  if (thinking === "off" && effort !== undefined)
    enforced.push({
      enforced: { _tag: "Effort", asked: effort },
      reason: "thinking is off, which the Responses API takes as reasoning effort none",
    });
  const reasoning = {
    ...(thinking === "off" ? { effort: "none" } : effort === undefined ? {} : { effort }),
    // A summary is the only thinking content the API returns on request; commentary comes unasked.
    ...(observe === "all" ? { summary: "auto" } : {}),
  };
  return {
    fields: {
      ...(Object.keys(reasoning).length === 0 ? {} : { reasoning }),
      ...(maxOutputTokens === undefined ? {} : { max_output_tokens: maxOutputTokens }),
      ...(cache === "1h" ? { prompt_cache_retention: "24h" } : {}),
    },
    headers: {},
    enforced,
  };
}
