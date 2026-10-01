/**
 * The frontier models this harness knows: for each provider, the models of its latest three
 * releases, with the most tokens of context each takes, the most it writes in one response, the
 * kinds of file it takes as input (`text`, `image`, `pdf`), the reasoning efforts it accepts, where
 * they were measured (`efforts`, OpenAI's and xAI's models: each was asked every effort on
 * 2026-10-01), and
 * its price in US dollars per million tokens (input not read from or written to the cache, output,
 * cache reads, cache writes, cache writes kept for an hour; `above` is the price of a request whose
 * input is over its `context`). Anthropic's hour-long cache writes are twice the input price
 * (Anthropic's pricing; models.dev lists only the five-minute rate).
 * The input kinds are models.dev's, except where measured: models.dev lists ten GPT-5 models as
 * taking no PDF (gpt-5, -mini, -nano, -pro, 5.1, 5.2, 5.2-pro, 5.4-mini, -nano, -pro), and each read
 * one when sent it (2026-10-01). The numbers are models.dev's catalog (https://models.dev/api.json) as of 2026-10-01. Measured
 * against them: Anthropic refuses `max_tokens` above a model's output (Haiku 4.5: 64,000); OpenAI
 * accepts any `max_output_tokens`, 10,000,000 included, so its limit cannot be read from a refusal.
 *
 * A model is found by its name or by its name with a release date after it
 * (`claude-haiku-4-5-20251001` is `claude-haiku-4-5`; `gpt-5-mini` is not `gpt-5`).
 */

import type { ModelName, ProviderName } from "../../agent-machine/names.ts";
import frontier from "./frontier.json" with { type: "json" };

export interface Price {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly cacheWrite1h?: number;
}

export interface Limits {
  /** The most tokens of context the model takes. */
  readonly context: number;
  /** The most tokens the model writes in one response. */
  readonly output: number;
  readonly input: ReadonlyArray<string>;
  readonly efforts?: ReadonlyArray<string>;
  readonly price: Price & { readonly above?: Price & { readonly context: number } };
}

const known: Readonly<Record<string, Readonly<Record<string, Limits>>>> = frontier;

/** `model` is `name` with its release date after it: `-2025-08-07` (OpenAI) or `-20251001` (Anthropic). */
const datedFrom = (name: string, model: string): boolean =>
  model.startsWith(`${name}-`) && /^(\d{4}-\d{2}-\d{2}|\d{8})$/.test(model.slice(name.length + 1));

/** The limits of `model` of `provider`, when it is one of the frontier models listed, by its name or a dated name. */
export function limitsOf(provider: ProviderName | string, model: ModelName | string): Limits | undefined {
  const models = known[provider] ?? {};
  const name = model in models ? model : Object.keys(models).find((each) => datedFrom(each, model));
  return name === undefined ? undefined : models[name];
}

/**
 * Whether `model` of `provider` takes a file of `mediaType` as input: an image (`image/*`) or a PDF
 * when `frontier.json` lists the kind for it. A model not listed is not known to take either.
 */
export function acceptsFile(provider: ProviderName | string, model: ModelName | string, mediaType: string): boolean {
  const kinds = limitsOf(provider, model)?.input ?? [];
  return (mediaType.startsWith("image/") && kinds.includes("image")) || (mediaType === "application/pdf" && kinds.includes("pdf"));
}
