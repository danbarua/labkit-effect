/**
 * What a session has used, read from its facts: the context gauge that a host shows (ACP's
 * `usage_update`) and counts against its limits. Every count is the provider's figure, from the
 * provider's tokenizer, as the provider reported it.
 *
 * `contextGauge` returns:
 * - `used`: the visible tokens of the last request and its response: everything the request
 *   carried, plus what the response returned without its thinking. After a compaction, `used` stays
 *   at the last response's figure until the next response reports a new one.
 * - `size`: the context window of the model that the session asks now (from the well-known models).
 *   There is no gauge when the window is not known.
 * - `cost`: the session's cost so far, in US dollars: the cost of the responses that reported usage,
 *   from models with a price. An interrupted response, an unobserved one, or one from a model that
 *   is not well known (a local model) adds nothing. A summarizer's requests are not in the facts, so
 *   their cost is not included.
 */

import { Array as Arr, Option } from "effect";
import type { Fact } from "../agent-machine/fact.ts";
import type { Observation, Usage } from "../agent-machine/observation.ts";
import { type Capabilities, capabilitiesOf, type Price } from "./configuration/well-known-models.ts";

type Responded = Extract<Observation, { _tag: "ModelResponded" }>;

export interface ContextGauge {
  readonly used: number;
  readonly size: number;
  readonly cost: { readonly amount: number; readonly currency: "USD" };
}

const responses = (facts: ReadonlyArray<Fact>): ReadonlyArray<Responded> =>
  facts.flatMap((fact) => (fact._tag === "Observed" && fact.observation._tag === "ModelResponded" ? [fact.observation] : []));

/** Returns what one response cost, in US dollars, at `price`. When the input exceeds `price.above.context`, the whole request is priced at the higher tier. */
export function costOf(usage: Usage, price: Capabilities["price"]): number {
  const at: Price = price.above !== undefined && usage.input > price.above.context ? price.above : price;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  const hour = usage.cacheWrite1h ?? 0;
  const uncached = usage.input - cacheRead - cacheWrite;
  return (
    (uncached * at.input +
      cacheRead * (at.cacheRead ?? at.input) +
      (cacheWrite - hour) * (at.cacheWrite ?? at.input) +
      hour * (at.cacheWrite1h ?? at.cacheWrite ?? at.input) +
      usage.output * at.output) /
    1_000_000
  );
}

/** Returns the session's cost so far, in US dollars: the responses that reported usage, from models with a price. */
export function costIn(facts: ReadonlyArray<Fact>): number {
  return responses(facts).reduce((total, response) => {
    const limits = capabilitiesOf(response.provider, response.model);
    return response.usage === undefined || limits === undefined ? total : total + costOf(response.usage, limits.price);
  }, 0);
}

/**
 * Returns the context gauge for a session that asks `model` of `provider`, or undefined when the
 * model's window is not known. `known` is what is known of the model when it is not a well-known one.
 */
export function contextGauge(facts: ReadonlyArray<Fact>, provider: string, model: string, known?: Capabilities): ContextGauge | undefined {
  const size = (known ?? capabilitiesOf(provider, model))?.context;
  if (size === undefined) return undefined;
  const last = Option.getOrUndefined(Arr.findLast(responses(facts), (response) => response.usage !== undefined))?.usage;
  const used = last === undefined ? 0 : last.input + last.output - (last.thinking ?? 0);
  return { used, size, cost: { amount: costIn(facts), currency: "USD" } };
}
