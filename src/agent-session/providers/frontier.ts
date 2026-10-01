/**
 * The frontier models this harness knows: for each provider, the models of its latest three
 * releases, with the most tokens of context each takes, the most it writes in one response, and
 * its price in US dollars per million tokens (input not read from or written to the cache, output,
 * cache reads, cache writes; `above` is the price of a request whose input is over its `context`).
 * The numbers are models.dev's catalog (https://models.dev/api.json) as of 2026-10-01. Measured
 * against them: Anthropic refuses `max_tokens` above a model's output (Haiku 4.5: 64,000); OpenAI
 * accepts any `max_output_tokens`, 10,000,000 included, so its limit cannot be read from a refusal.
 *
 * A model is found by its name or by a dated name that begins with it
 * (`claude-haiku-4-5-20251001` is `claude-haiku-4-5`).
 */

import type { ModelName, ProviderName } from "../../agent-machine/names.ts";
import frontier from "./frontier.json" with { type: "json" };

export interface Price {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

export interface Limits {
  /** The most tokens of context the model takes. */
  readonly context: number;
  /** The most tokens the model writes in one response. */
  readonly output: number;
  readonly price: Price & { readonly above?: Price & { readonly context: number } };
}

const known: Readonly<Record<string, Readonly<Record<string, Limits>>>> = frontier;

/** The limits of `model` of `provider`, when it is one of the frontier models listed. */
export function limitsOf(provider: ProviderName | string, model: ModelName | string): Limits | undefined {
  const models = known[provider] ?? {};
  const name = Object.keys(models).find((each) => model === each || model.startsWith(`${each}-`));
  return name === undefined ? undefined : models[name];
}
