/**
 * What a session has used, read from its facts: what a host shows as the context gauge (ACP's
 * `usage_update`) and counts against its limits.
 *
 * - `contextGauge`: `used`, the tokens in context after the last response (what its request carried
 *   and what it returned, as the provider reported them); `size`, the context window of the model
 *   the session asks now (`frontier.json`); and `cost`, the session's cost so far in US dollars.
 *   There is no gauge when the model's window is not known. After a compaction `used` stays the last
 *   response's figure until the next response reports a new one. `cost` is absent when a response
 *   has no usage, or its model no price; the requests a summarizer makes are not among the facts,
 *   so their cost is not in it.
 * - `requestsIn`: how many model requests a turn has made, which is how many steps it has taken
 *   (`AskModel`, `TellModel`). A request a fallback sends to another provider is the same request.
 */

import type { Fact } from "../agent-machine/fact.ts";
import type { TurnId } from "../agent-machine/names.ts";
import type { Observation, Usage } from "../agent-machine/observation.ts";
import { limitsOf, type Price } from "./providers/frontier.ts";

type Responded = Extract<Observation, { _tag: "ModelResponded" }>;

export interface ContextGauge {
  readonly used: number;
  readonly size: number;
  readonly cost?: { readonly amount: number; readonly currency: "USD" };
}

const responses = (facts: ReadonlyArray<Fact>): ReadonlyArray<Responded> =>
  facts.flatMap((fact) => (fact._tag === "Observed" && fact.observation._tag === "ModelResponded" ? [fact.observation] : []));

/** What one response cost, in US dollars, at `price`: its input above `price.above.context` at the higher price. */
export function costOf(usage: Usage, price: Limits["price"]): number {
  const at: Price = price.above !== undefined && usage.input > price.above.context ? price.above : price;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  const uncached = usage.input - cacheRead - cacheWrite;
  return (
    (uncached * at.input + cacheRead * (at.cacheRead ?? at.input) + cacheWrite * (at.cacheWrite ?? at.input) + usage.output * at.output) /
    1_000_000
  );
}

type Limits = NonNullable<ReturnType<typeof limitsOf>>;

/** The session's cost so far, in US dollars; undefined when a response has no usage or no price. */
export function costIn(facts: ReadonlyArray<Fact>): number | undefined {
  let total = 0;
  for (const response of responses(facts)) {
    const limits = limitsOf(response.provider, response.model);
    if (response.usage === undefined || limits === undefined) return undefined;
    total += costOf(response.usage, limits.price);
  }
  return total;
}

/** The context gauge for a session asking `model` of `provider`; undefined when the model's window is not known. */
export function contextGauge(facts: ReadonlyArray<Fact>, provider: string, model: string): ContextGauge | undefined {
  const size = limitsOf(provider, model)?.context;
  if (size === undefined) return undefined;
  const last = [...responses(facts)].reverse().find((response) => response.usage !== undefined)?.usage;
  const cost = costIn(facts);
  return {
    used: last === undefined ? 0 : last.input + last.output,
    size,
    ...(cost === undefined ? {} : { cost: { amount: cost, currency: "USD" as const } }),
  };
}

/** How many model requests `turn` has made: its steps. */
export const requestsIn = (facts: ReadonlyArray<Fact>, turn: TurnId): number =>
  facts.filter((fact) => fact._tag === "Decided" && (fact.decision._tag === "AskModel" || fact.decision._tag === "TellModel") && fact.decision.turn === turn).length;
