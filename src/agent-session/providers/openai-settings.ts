/**
 * A session's settings as the Responses API accepts them: `reasoning.effort`, `reasoning.summary`,
 * `max_output_tokens` and `prompt_cache_retention`.
 * - The API has no setting for when a model thinks, other than not at all (effort `none`).
 * - The API caches every long enough request in memory, for minutes. When the session asks for an
 *   hour, the request asks for the API's longer retention, 24 hours.
 * - A setting that the API cannot accept is returned as adjusted.
 *
 * Each model accepts its own reasoning efforts (`efforts`, from the well-known models): gpt-5 accepts
 * `minimal` to `high`, the pro models `medium` to `xhigh` (gpt-5-pro only `high`), and some accept no
 * `none`. An effort that a model does not accept, including thinking `off` (effort `none`), is sent
 * as the nearest accepted effort (the higher one when two are equally near), and returned as
 * adjusted. A model with no list is sent the effort asked.
 */

import type { ModelSettings } from "../../agent-machine/settings.ts";
import { type Adjustment, effortFor, type Settled } from "../configuration/settings.ts";
import type { Target } from "../contracts.ts";
import { knownOf } from "../configuration/well-known-models.ts";

export function openAiSettings(settings: ModelSettings = {}, efforts?: ReadonlyArray<string>): Settled {
  const { thinking, observe, maxOutputTokens, cache } = settings;
  const { sent, adjusted: effortAdjusted } = effortFor(settings, efforts);
  const cacheAdjusted: ReadonlyArray<Adjustment> =
    cache === "off"
      ? [
          {
            adjusted: { _tag: "Cache", asked: cache, used: "5m" },
            reason: "the Responses API caches every long enough request for minutes, and cannot be asked not to",
          },
        ]
      : [];
  const thinkingAdjusted: ReadonlyArray<Adjustment> =
    thinking === "before_answer" || thinking === "between_tools"
      ? [
          {
            adjusted: { _tag: "Thinking", asked: thinking, used: "auto" },
            reason: "the Responses API has no setting for when the model thinks",
          },
        ]
      : [];
  const adjusted = [...cacheAdjusted, ...thinkingAdjusted, ...effortAdjusted];
  const reasoning = {
    ...(sent === undefined ? {} : { effort: sent }),
    // A summary is the only thinking content that the API returns on request; commentary arrives without a request.
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

/** The same mapping, for a request's target: its settings, and the efforts known for its model. */
export const openAiSettle = (target: Target): Settled => openAiSettings(target.settings, knownOf(target)?.efforts);
