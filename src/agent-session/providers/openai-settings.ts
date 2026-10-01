/**
 * A session's settings as the Responses API takes them: `reasoning.effort`, `reasoning.summary`,
 * `max_output_tokens` and `prompt_cache_retention`. The API has no setting for when a model thinks,
 * other than not at all (effort `none`). It caches every long enough request, for minutes, in
 * memory; asked to keep it for an hour, it is asked for its longer retention, 24 hours. A setting
 * it cannot take is returned as adjusted.
 *
 * Each model accepts its own reasoning efforts (`efforts`, of the well-known models): gpt-5 takes
 * `minimal` to `high`, the pro models `medium` to `xhigh` (gpt-5-pro only `high`), and some take no
 * `none`. An effort a model does not accept, thinking `off` (effort `none`) included, is sent as
 * the nearest one it does, the higher of two as near, and that is returned as adjusted. A model
 * with no list is sent what was asked.
 */

import type { ModelSettings } from "../../agent-machine/settings.ts";
import { type Adjustment, effortFor, type Settled } from "../settings.ts";

export function openAiSettings(settings: ModelSettings = {}, efforts?: ReadonlyArray<string>): Settled {
  const adjusted: Array<Adjustment> = [];
  const { thinking, observe, maxOutputTokens, cache } = settings;
  if (cache === "off")
    adjusted.push({
      adjusted: { _tag: "Cache", asked: cache, used: "5m" },
      reason: "the Responses API caches every long enough request for minutes, and cannot be asked not to",
    });
  if (thinking === "before_answer" || thinking === "between_tools")
    adjusted.push({
      adjusted: { _tag: "Thinking", asked: thinking, used: "auto" },
      reason: "the Responses API has no setting for when the model thinks",
    });
  const { sent, adjusted: effortAdjusted } = effortFor(settings, efforts);
  adjusted.push(...effortAdjusted);
  const reasoning = {
    ...(sent === undefined ? {} : { effort: sent }),
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
    adjusted,
  };
}
