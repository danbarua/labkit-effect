/**
 * What a session has used, read from its facts: what a host shows as the context gauge (ACP's
 * `usage_update`) and counts against its limits. Every count is a best guess: the tokenizer is the
 * provider's, and the counts are what it reported.
 *
 * - `contextGauge`: `used`, the visible tokens of the last request and its response: everything the
 *   request carried, and what the response returned less its thinking; `size`, the context window
 *   of the model the session asks now (the well-known models'); and `cost`, the session's cost so far in
 *   US dollars. There is no gauge when the model's window is not known. After a compaction `used`
 *   stays the last response's figure until the next response reports a new one. `cost` is the cost
 *   of the responses that reported their usage to a model with a price: one interrupted, or not
 *   observed, or from a model that is not well-known (a local model) adds nothing. The requests a
 *   summarizer makes are not among the facts, so their cost is not in it.
 * - `requestsIn`: how many model requests a turn has made, which is how many steps it has taken
 *   (`AskModel`, `TellModel`). A request a fallback sends to another provider is the same request.
 */

import type { Fact } from "../agent-machine/fact.ts";
import type { TurnId } from "../agent-machine/names.ts";
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

/** What one response cost, in US dollars, at `price`: its input above `price.above.context` at the higher price. */
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

/** The session's cost so far, in US dollars: the responses with usage, to a model with a price. */
export function costIn(facts: ReadonlyArray<Fact>): number {
  return responses(facts).reduce((total, response) => {
    const limits = capabilitiesOf(response.provider, response.model);
    return response.usage === undefined || limits === undefined ? total : total + costOf(response.usage, limits.price);
  }, 0);
}

/**
 * The context gauge for a session asking `model` of `provider`; undefined when the model's window is
 * not known. `known` is what is known of the model, when it is not a well-known one.
 */
export function contextGauge(facts: ReadonlyArray<Fact>, provider: string, model: string, known?: Capabilities): ContextGauge | undefined {
  const size = (known ?? capabilitiesOf(provider, model))?.context;
  if (size === undefined) return undefined;
  const last = [...responses(facts)].reverse().find((response) => response.usage !== undefined)?.usage;
  const used = last === undefined ? 0 : last.input + last.output - (last.thinking ?? 0);
  return { used, size, cost: { amount: costIn(facts), currency: "USD" } };
}

/** How many model requests `turn` has made: its steps. */
export const requestsIn = (facts: ReadonlyArray<Fact>, turn: TurnId): number =>
  facts.filter((fact) => fact._tag === "Decided" && (fact.decision._tag === "AskModel" || fact.decision._tag === "TellModel") && fact.decision.turn === turn).length;
