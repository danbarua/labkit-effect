/**
 * A session's settings as the Responses API takes them: `reasoning.effort` and
 * `reasoning.summary`. The API has no setting for when a model thinks, other than not at all
 * (effort `none`); a setting it cannot take is returned as enforced.
 */

import type { ModelSettings } from "../../agent-core/settings.ts";
import type { Enforcement, Settled } from "../settings.ts";

export function openAiSettings(settings: ModelSettings = {}): Settled {
  const enforced: Array<Enforcement> = [];
  const { thinking, observe, effort } = settings;
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
  return { fields: Object.keys(reasoning).length === 0 ? {} : { reasoning }, headers: {}, enforced };
}
