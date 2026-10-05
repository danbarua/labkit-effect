/**
 * A session's settings as xAI's Responses endpoint accepts them: `reasoning.effort` and
 * `max_output_tokens`, under OpenAI's names. Where xAI differs from OpenAI:
 *
 * - It returns the reasoning's summary with every response and ignores `reasoning.summary`, so an
 *   `observe` other than `all` is returned as adjusted and nothing is sent for it.
 * - `max_output_tokens` limits the answer only: the reasoning is not counted against it, so a
 *   response can use more tokens than `maxOutputTokens`. The limit is sent as asked and not
 *   recorded as adjusted, because an adjusted value becomes the setting (agent-machine M3) and the
 *   same number would then be adjusted again on every request.
 * - It caches every request for as long as the server keeps the entry, with no setting for how
 *   long. It accepts and ignores `prompt_cache_retention`, so that field is not sent.
 *
 * As for OpenAI, each model accepts its own reasoning efforts (`efforts`, from the well-known models:
 * grok-4.5 to 4.7 accept `minimal` to `xhigh`, with no `none` and no `max`). An effort that a model
 * does not accept, including thinking `off` (effort `none`), is sent as the nearest accepted effort
 * (`effortFor`), and returned as adjusted.
 */

import type { ModelSettings } from "../../agent-machine/settings.ts";
import { type Adjustment, effortFor, type Settled } from "../configuration/settings.ts";
import type { Target } from "../contracts.ts";
import { knownOf } from "../configuration/well-known-models.ts";

export function xAiSettings(settings: ModelSettings = {}, efforts?: ReadonlyArray<string>): Settled {
  const { thinking, observe, maxOutputTokens, cache } = settings;
  const { sent: sentEffort, adjusted: effortAdjusted } = effortFor(settings, efforts);
  const cacheAdjusted: ReadonlyArray<Adjustment> =
    cache === undefined
      ? []
      : [
          {
            adjusted: { _tag: "Cache", asked: cache },
            reason: "xAI caches every request for as long as the server keeps it, and has no setting for how long",
          },
        ];
  const observeAdjusted: ReadonlyArray<Adjustment> =
    observe === "off" || observe === "progress_only"
      ? [
          {
            adjusted: { _tag: "Observe", asked: observe, used: "all" },
            reason: "xAI returns the reasoning's summary with every response, and cannot be asked not to",
          },
        ]
      : [];
  const thinkingAdjusted: ReadonlyArray<Adjustment> =
    thinking === "before_answer" || thinking === "between_tools"
      ? [
          {
            adjusted: { _tag: "Thinking", asked: thinking, used: "auto" },
            reason: "xAI's Responses endpoint has no setting for when the model thinks",
          },
        ]
      : [];
  const adjusted = [...cacheAdjusted, ...observeAdjusted, ...thinkingAdjusted, ...effortAdjusted];
  return {
    fields: {
      ...(sentEffort === undefined ? {} : { reasoning: { effort: sentEffort } }),
      ...(maxOutputTokens === undefined ? {} : { max_output_tokens: maxOutputTokens }),
    },
    headers: {},
    adjusted,
  };
}

/** The same mapping, for a request's target: its settings, and the efforts known for its model. */
export const xAiSettle = (target: Target): Settled => xAiSettings(target.settings, knownOf(target)?.efforts);
