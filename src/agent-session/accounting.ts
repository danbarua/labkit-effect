/**
 * What a session has used, read from its facts: the context gauge that a host shows (ACP's
 * `usage_update`) and counts against its limits, and the session's totals. Every count is the
 * provider's figure, from the provider's tokenizer, as the provider reported it.
 *
 * A response's cost comes from the prices of the well-known models (`capabilitiesOf`), the one
 * owner of prices. A response is priced when its model has a price there and the response reported
 * its usage; any other response has no cost, which is not the same as costing nothing. A local
 * model is not priced: what the local server lists (`KnownModels`) gives it a price of zero, which
 * is not a price.
 *
 * `contextGauge` returns:
 * - `used`: the visible tokens of the last request and its response: everything the request
 *   carried, plus what the response returned without its thinking. After a compaction, `used` stays
 *   at the last response's figure until the next response reports a new one.
 * - `size`: the context window of the model that the session asks now (from the well-known models).
 *   There is no gauge when the window is not known.
 * - `cost`: the session's cost so far, in US dollars: the cost of the priced responses. An
 *   interrupted response, an unobserved one, or one from a model that is not well known (a local
 *   model) adds nothing. A summarizer's requests are not in the facts, so their cost is not included.
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

/** What one response cost, in US dollars, by component, and in total. `input` is the input not read from or written to the cache. */
export interface CostByComponent {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly total: number;
}

/**
 * Returns what one response cost, in US dollars, at `price`, by component. When the input exceeds
 * `price.above.context`, the whole request is priced at the higher tier. Cache writes kept for one
 * hour (`cacheWrite1h`) are priced at their own rate, and are part of `cacheWrite`.
 */
export function costByComponent(usage: Usage, price: Capabilities["price"]): CostByComponent {
  const at: Price = price.above !== undefined && usage.input > price.above.context ? price.above : price;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  const hour = usage.cacheWrite1h ?? 0;
  const uncached = usage.input - cacheRead - cacheWrite;
  const parts = {
    input: (uncached * at.input) / 1_000_000,
    output: (usage.output * at.output) / 1_000_000,
    cacheRead: (cacheRead * (at.cacheRead ?? at.input)) / 1_000_000,
    cacheWrite: ((cacheWrite - hour) * (at.cacheWrite ?? at.input) + hour * (at.cacheWrite1h ?? at.cacheWrite ?? at.input)) / 1_000_000,
  };
  return { ...parts, total: parts.input + parts.output + parts.cacheRead + parts.cacheWrite };
}

/** Returns what one response cost, in US dollars, at `price` (`costByComponent`'s total). */
export function costOf(usage: Usage, price: Capabilities["price"]): number {
  return costByComponent(usage, price).total;
}

/** Returns what `response` cost, by component, or undefined when it is not priced: its model has no price, or it reported no usage. */
export function responseCost(response: Responded): CostByComponent | undefined {
  const known = capabilitiesOf(response.provider, response.model);
  return response.usage === undefined || known === undefined ? undefined : costByComponent(response.usage, known.price);
}

/** Returns the session's cost so far, in US dollars: the priced responses' cost. */
export function costIn(facts: ReadonlyArray<Fact>): number {
  return responses(facts).reduce((total, response) => total + (responseCost(response)?.total ?? 0), 0);
}

/**
 * A session's totals, from its facts:
 * - `requests`: the model requests that have an outcome (a response or a failure); `failedRequests`
 *   those that failed.
 * - `turns`: the turns started.
 * - `toolCalls`: the tool calls that ended; `failedToolCalls` those that ended failed.
 * - the responses' tokens, as reported: `inputTokens` (all the input, cache reads and writes
 *   included), `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`.
 * - `cost`: the priced responses' cost, in US dollars, or undefined when no response was priced.
 * - `unpricedRequests`: the responses that are not priced.
 * - `models`: each `provider/model` that a request was sent to, in the order first sent.
 */
export interface SessionTotals {
  readonly requests: number;
  readonly failedRequests: number;
  readonly turns: number;
  readonly toolCalls: number;
  readonly failedToolCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly cost: number | undefined;
  readonly unpricedRequests: number;
  readonly models: ReadonlyArray<string>;
}

const noTotals: SessionTotals = {
  requests: 0,
  failedRequests: 0,
  turns: 0,
  toolCalls: 0,
  failedToolCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cost: undefined,
  unpricedRequests: 0,
  models: [],
};

/** Returns the session's totals (`SessionTotals`) from its facts. */
export function sessionTotals(facts: ReadonlyArray<Fact>): SessionTotals {
  return facts.reduce((totals, fact): SessionTotals => {
    if (fact._tag !== "Observed") return totals;
    const observation = fact.observation;
    if (observation._tag === "TurnStarted") return { ...totals, turns: totals.turns + 1 };
    if (observation._tag === "ModelRequestDispatched") {
      const model = `${observation.provider}/${observation.model}`;
      return totals.models.includes(model) ? totals : { ...totals, models: [...totals.models, model] };
    }
    if (observation._tag === "ModelFailed") return { ...totals, requests: totals.requests + 1, failedRequests: totals.failedRequests + 1 };
    if (observation._tag === "ToolEnded")
      return { ...totals, toolCalls: totals.toolCalls + 1, failedToolCalls: totals.failedToolCalls + (observation.outcome._tag === "Failed" ? 1 : 0) };
    if (observation._tag !== "ModelResponded") return totals;
    const usage = observation.usage;
    const cost = responseCost(observation);
    return {
      ...totals,
      requests: totals.requests + 1,
      inputTokens: totals.inputTokens + (usage?.input ?? 0),
      outputTokens: totals.outputTokens + (usage?.output ?? 0),
      cacheReadTokens: totals.cacheReadTokens + (usage?.cacheRead ?? 0),
      cacheWriteTokens: totals.cacheWriteTokens + (usage?.cacheWrite ?? 0),
      cost: cost === undefined ? totals.cost : (totals.cost ?? 0) + cost.total,
      unpricedRequests: totals.unpricedRequests + (cost === undefined ? 1 : 0),
    };
  }, noTotals);
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
