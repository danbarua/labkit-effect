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

import { Context, Effect } from "effect";
import type { ModelName, ProviderName } from "../../agent-machine/names.ts";
import frontier from "./frontier.json" with { type: "json" };

export interface Price {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly cacheWrite1h?: number;
}

/**
 * What is known of a model: what it takes and what it costs. A request is shaped to it: a setting
 * outside what the model takes is sent as the nearest it does (an effort above its highest, as its
 * highest).
 */
export interface Capabilities {
  /** The most tokens of context the model takes, when known. */
  readonly context?: number;
  /** The most tokens the model writes in one response, when known. */
  readonly output?: number;
  /** The kinds of input it takes: `text`, `image`, `pdf`. */
  readonly input: ReadonlyArray<string>;
  /** The reasoning efforts it takes, least first, when known. */
  readonly efforts?: ReadonlyArray<string>;
  readonly price: Price & { readonly above?: Price & { readonly context: number } };
}

const known: Readonly<Record<string, Readonly<Record<string, Capabilities>>>> = frontier;

/** `model` is `name` with its release date after it: `-2025-08-07` (OpenAI) or `-20251001` (Anthropic). */
const datedFrom = (name: string, model: string): boolean =>
  model.startsWith(`${name}-`) && /^(\d{4}-\d{2}-\d{2}|\d{8})$/.test(model.slice(name.length + 1));

/** What `frontier.json` says of `model` of `provider`, found by its name or a dated name. */
export function capabilitiesOf(provider: ProviderName | string, model: ModelName | string): Capabilities | undefined {
  const models = known[provider] ?? {};
  const name = model in models ? model : Object.keys(models).find((each) => datedFrom(each, model));
  return name === undefined ? undefined : models[name];
}

/**
 * What is known of each model, for whoever chooses the model for a request (`ModelFromFacts` puts
 * it on the request's target). By default it is what `frontier.json` lists; a host that knows more
 * (a local server that says what its models take) provides its own.
 */
export const KnownModels = Context.Reference<(provider: ProviderName, model: ModelName) => Effect.Effect<Capabilities | undefined>>(
  "agent-session/KnownModels",
  { defaultValue: () => (provider, model) => Effect.succeed(capabilitiesOf(provider, model)) },
);

/** What is known of the model a request goes to: what its target carries, or what `frontier.json` lists. */
export const knownOf = (target: { readonly provider: ProviderName; readonly model: ModelName; readonly capabilities?: Capabilities }): Capabilities | undefined =>
  target.capabilities ?? capabilitiesOf(target.provider, target.model);

/**
 * Whether a model with `capabilities` takes a file of `mediaType` as input: an image (`image/*`) or
 * a PDF when it lists the kind. A model nothing is known of is not known to take either.
 */
export function takesFile(capabilities: Capabilities | undefined, mediaType: string): boolean {
  const kinds = capabilities?.input ?? [];
  return (mediaType.startsWith("image/") && kinds.includes("image")) || (mediaType === "application/pdf" && kinds.includes("pdf"));
}
