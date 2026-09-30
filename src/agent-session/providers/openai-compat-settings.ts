/**
 * A session's settings for a Chat Completions provider: none is sent, because what each compatible
 * provider takes for them differs. Every setting that was asked for is returned as enforced.
 */

import type { ModelSettings } from "../../agent-machine/settings.ts";
import type { Enforcement, Settled } from "../settings.ts";

const reason = "the Chat Completions adapter sends no settings";

export function openAiCompatSettings(settings: ModelSettings = {}): Settled {
  const enforced: ReadonlyArray<Enforcement> = [
    ...(settings.thinking === undefined ? [] : [{ enforced: { _tag: "Thinking" as const, asked: settings.thinking }, reason }]),
    ...(settings.observe === undefined ? [] : [{ enforced: { _tag: "Observe" as const, asked: settings.observe }, reason }]),
    ...(settings.effort === undefined ? [] : [{ enforced: { _tag: "Effort" as const, asked: settings.effort }, reason }]),
    ...(settings.maxOutputTokens === undefined
      ? []
      : [{ enforced: { _tag: "MaxOutputTokens" as const, asked: settings.maxOutputTokens }, reason }]),
    ...(settings.cache === undefined ? [] : [{ enforced: { _tag: "Cache" as const, asked: settings.cache }, reason }]),
  ];
  return { fields: {}, headers: {}, enforced };
}
