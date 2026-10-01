/**
 * A session's settings as the Responses API takes them: `reasoning.effort`, `reasoning.summary`,
 * `max_output_tokens` and `prompt_cache_retention`. The API has no setting for when a model thinks,
 * other than not at all (effort `none`). It caches every long enough request, for minutes, in
 * memory; asked to keep it for an hour, it is asked for its longer retention, 24 hours. A setting
 * it cannot take is returned as enforced.
 *
 * Each model accepts its own reasoning efforts (`efforts`, from `frontier.json`): gpt-5 takes
 * `minimal` to `high`, the pro models `medium` to `xhigh` (gpt-5-pro only `high`), and some take no
 * `none`. An effort a model does not accept, thinking `off` (effort `none`) included, is sent as
 * the nearest one it does, the higher of two as near, and that is returned as enforced. A model
 * with no list is sent what was asked.
 */

import type { Effort, ModelSettings } from "../../agent-machine/settings.ts";
import type { Enforcement, Settled } from "../settings.ts";

/** The efforts in order, least first. */
const order = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/** The effort in `accepted` nearest `wanted`; the higher of two as near. */
function nearest(wanted: string, accepted: ReadonlyArray<string>): string {
  const at = order.indexOf(wanted);
  const distance = (effort: string) => Math.abs(order.indexOf(effort) - at);
  return [...accepted].sort((a, b) => distance(a) - distance(b) || order.indexOf(b) - order.indexOf(a))[0] ?? wanted;
}

const isEffort = (effort: string): effort is Effort => (["low", "medium", "high", "xhigh", "max"] as const).some((each) => each === effort);

export function openAiSettings(settings: ModelSettings = {}, efforts?: ReadonlyArray<string>): Settled {
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
  const wanted = thinking === "off" ? "none" : effort;
  const sent = wanted === undefined || efforts === undefined || efforts.includes(wanted) ? wanted : nearest(wanted, efforts);
  if (sent !== wanted && wanted !== undefined && sent !== undefined) {
    const reason = `this model's reasoning efforts are ${efforts?.join(", ")}; it is sent ${sent}`;
    if (thinking === "off") enforced.push({ enforced: { _tag: "Thinking", asked: "off", used: "auto" }, reason });
    else if (effort !== undefined) enforced.push({ enforced: { _tag: "Effort", asked: effort, ...(isEffort(sent) ? { used: sent } : {}) }, reason });
  }
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
    enforced,
  };
}
