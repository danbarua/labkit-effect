/**
 * A session's settings as xAI's Responses endpoint takes them: `reasoning.effort` and
 * `max_output_tokens`, as OpenAI's are named. Where xAI differs from OpenAI:
 *
 * - It returns the reasoning's summary with every response and ignores `reasoning.summary`, so
 *   `observe` short of `all` is returned as adjusted and nothing is sent for it.
 * - `max_output_tokens` limits the answer only: the reasoning is not counted against it, so a
 *   response can take more tokens than `maxOutputTokens` says. It is sent as asked and not recorded
 *   as adjusted, because what is adjusted becomes the setting (agent-machine M3) and the same
 *   number would be adjusted again on every request.
 * - It caches every request, keeps an entry for as long as the server does, and has no setting for
 *   how long; `prompt_cache_retention` is accepted and ignored, so it is not sent.
 *
 * As for OpenAI, each model accepts its own reasoning efforts (`efforts`, of the well-known models:
 * grok-4.5 to 4.7 take `minimal` to `xhigh`, no `none` and no `max`), and an effort a model does
 * not accept, thinking `off` (effort `none`) included, is sent as the nearest it does
 * (`effortFor`), and adjusted.
 */

import type { ModelSettings } from "../../agent-machine/settings.ts";
import { type Adjustment, effortFor, type Settled } from "../configuration/settings.ts";
import type { Target } from "../contracts.ts";
import { knownOf } from "../configuration/well-known-models.ts";

export function xAiSettings(settings: ModelSettings = {}, efforts?: ReadonlyArray<string>): Settled {
  const adjusted: Array<Adjustment> = [];
  const { thinking, observe, maxOutputTokens, cache } = settings;
  if (cache !== undefined)
    adjusted.push({
      adjusted: { _tag: "Cache", asked: cache },
      reason: "xAI caches every request for as long as the server keeps it, and has no setting for how long",
    });
  if (observe === "off" || observe === "progress_only")
    adjusted.push({
      adjusted: { _tag: "Observe", asked: observe, used: "all" },
      reason: "xAI returns the reasoning's summary with every response, and cannot be asked not to",
    });
  if (thinking === "before_answer" || thinking === "between_tools")
    adjusted.push({
      adjusted: { _tag: "Thinking", asked: thinking, used: "auto" },
      reason: "xAI's Responses endpoint has no setting for when the model thinks",
    });
  const { sent: sentEffort, adjusted: effortAdjusted } = effortFor(settings, efforts);
  adjusted.push(...effortAdjusted);
  return {
    fields: {
      ...(sentEffort === undefined ? {} : { reasoning: { effort: sentEffort } }),
      ...(maxOutputTokens === undefined ? {} : { max_output_tokens: maxOutputTokens }),
    },
    headers: {},
    adjusted,
  };
}

/** The same for a request's target: its settings, and the efforts known of its model. */
export const xAiSettle = (target: Target): Settled => xAiSettings(target.settings, knownOf(target)?.efforts);
