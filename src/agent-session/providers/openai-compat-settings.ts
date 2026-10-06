/**
 * A session's settings for a Chat Completions provider.
 * - **Reasoning effort** is sent as `reasoning_effort`, the standard Chat Completions parameter: the
 *   effort asked, or `none` when thinking is `disabled` (`reasoningEffortFor`). With neither an
 *   effort nor a thinking setting, nothing is sent and the server uses its default. An effort that
 *   the model is known not to accept (`efforts`) is sent as the nearest accepted effort. For a model
 *   with no list, the effort asked is sent, and a server that does not accept it refuses the request
 *   in its own words.
 * - **Thinking `between_tools`** has no Chat Completions parameter, and is not sent.
 * - **Output limit** is sent as `max_tokens`; the server ends a response that reaches it with
 *   `finish_reason: length`.
 * - **Other settings** are not sent, because each compatible provider accepts them differently;
 *   each one asked for is returned as adjusted.
 *
 * Measured against a local Rapid-MLX server (vLLM-compatible) running Qwen3.5-9B: it accepts `none`,
 * `minimal`, `low`, `medium`, `high` and `xhigh`, and refuses `max` with a 400. Its default is
 * `none`. With any effort except `none`, the response carries `reasoning_content`.
 */

import type { ModelSettings } from "../../agent-machine/settings.ts";
import { type Adjustment, reasoningEffortFor, type Settled } from "../configuration/settings.ts";
import type { Target } from "../contracts.ts";
import { type Capabilities, knownOf } from "../configuration/well-known-models.ts";

const reason = "the Chat Completions adapter does not send this setting";

export function openAiCompatSettings(settings: ModelSettings = {}, capabilities?: Capabilities): Settled {
  const { sent, adjusted: effortAdjusted } = reasoningEffortFor(settings, capabilities);
  const adjusted: ReadonlyArray<Adjustment> = [
    ...(settings.thinking === "between_tools" ? [{ adjusted: { _tag: "Thinking" as const, asked: settings.thinking }, reason: "Chat Completions has no setting for thinking only between tool calls" }] : []),
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

/** The same mapping, for a request's target: its settings, and what is known of its model. */
export const openAiCompatSettle = (target: Target): Settled => openAiCompatSettings(target.settings, knownOf(target));
