/**
 * A session's settings as xAI's Responses endpoint takes them: `reasoning.effort` and
 * `max_output_tokens`, as OpenAI's are named. Where xAI differs from OpenAI:
 *
 * - Its efforts go up to `xhigh`; `max` is refused, so `xhigh` is sent.
 * - It returns the reasoning's summary with every response and ignores `reasoning.summary`, so
 *   `observe` short of `all` is returned as enforced and nothing is sent for it.
 * - `max_output_tokens` limits the answer only: the reasoning is not counted against it, so a
 *   response can take more tokens than `maxOutputTokens` says. It is sent as asked and not recorded
 *   as enforced, because what is enforced becomes the setting (agent-machine M3) and the same
 *   number would be enforced again on every request.
 * - It caches every request, keeps an entry for as long as the server does, and has no setting for
 *   how long; `prompt_cache_retention` is accepted and ignored, so it is not sent.
 *
 * Thinking `off` is sent as effort `none`, as for OpenAI, to a model that takes it (grok-4.3). The
 * later models (grok-4.5 to grok-4.7) refuse the request, so for any other model thinking `off` is
 * returned as enforced, `auto` at effort `low`. What each model takes is listed by `GET /v1/models`
 * (`capabilities.reasoning_effort`); the list here is written from it, so that settings stay a
 * function of the model and what was said.
 */

import type { ModelName } from "../../agent-machine/names.ts";
import type { ModelSettings } from "../../agent-machine/settings.ts";
import type { Enforcement, Settled } from "../settings.ts";

/** Whether `model` takes reasoning effort `none`. */
const takesNone = (model: string): boolean => /^grok-4\.3(-|$)/.test(model);

export function xAiSettings(model: ModelName, settings: ModelSettings = {}): Settled {
  const enforced: Array<Enforcement> = [];
  const { thinking, observe, effort, maxOutputTokens, cache } = settings;
  const offAllowed = takesNone(model);
  if (cache !== undefined)
    enforced.push({
      enforced: { _tag: "Cache", asked: cache },
      reason: "xAI caches every request for as long as the server keeps it, and has no setting for how long",
    });
  if (observe === "off" || observe === "progress_only")
    enforced.push({
      enforced: { _tag: "Observe", asked: observe, used: "all" },
      reason: "xAI returns the reasoning's summary with every response, and cannot be asked not to",
    });
  if (thinking === "before_answer" || thinking === "between_tools")
    enforced.push({
      enforced: { _tag: "Thinking", asked: thinking, used: "auto" },
      reason: "xAI's Responses endpoint has no setting for when the model thinks",
    });
  if (thinking === "off" && offAllowed && effort !== undefined)
    enforced.push({
      enforced: { _tag: "Effort", asked: effort },
      reason: "thinking is off, which is sent as reasoning effort none",
    });
  if (thinking === "off" && !offAllowed) {
    enforced.push({
      enforced: { _tag: "Thinking", asked: thinking, used: "auto" },
      reason: "this model does not allow thinking to be turned off (reasoning effort none); it is sent effort low",
    });
    if (effort !== undefined && effort !== "low")
      enforced.push({
        enforced: { _tag: "Effort", asked: effort, used: "low" },
        reason: "this model does not allow thinking to be turned off; the least effort, low, is sent",
      });
  }
  if (thinking !== "off" && effort === "max")
    enforced.push({
      enforced: { _tag: "Effort", asked: effort, used: "xhigh" },
      reason: "xAI's reasoning efforts go up to xhigh",
    });
  const sentEffort = thinking === "off" ? (offAllowed ? "none" : "low") : effort === "max" ? "xhigh" : effort;
  return {
    fields: {
      ...(sentEffort === undefined ? {} : { reasoning: { effort: sentEffort } }),
      ...(maxOutputTokens === undefined ? {} : { max_output_tokens: maxOutputTokens }),
    },
    headers: {},
    enforced,
  };
}
