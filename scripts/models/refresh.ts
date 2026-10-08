/**
 * Writes `src/agent-session/configuration/well-known-models.gen.ts`: what is known of each well-known
 * model, as `const` data, so that a model's settings can be typed from it.
 *
 * Two sources are merged. models.dev's catalog (https://models.dev/api.json) gives each model's
 * context window, output limit, kinds of input, price, whether it reasons (`reasoning`), and how its
 * reasoning is set (`reasoning_options`): the efforts it takes, or a budget of thinking tokens.
 * `well-known-models.measured.json` names the models to include, by provider, and for each holds what
 * was measured against the provider and is not in the catalog: the kinds of input it took when sent
 * them, the price of an hour-long cache write, and the thinking modes it takes besides the provider's
 * default and `disabled` (`thinking: ["between_tools"]`), the highest effort at which its thinking can
 * be turned off (`thinkingOffUpTo`), and the `observe` settings it takes where it refuses some
 * (`observe`). It also holds a price that the catalog
 * gives and the provider's own pricing contradicts: Claude Sonnet 5.5's cache reads are $0.20 per
 * million tokens, where models.dev gave $0.10 on 2026-10-08. What was measured wins. A measured
 * difference in efforts is not kept here: a user's configuration overrides it (`models:`, as
 * `src/agent-config/fixtures/user/40_models.yml` shows).
 *
 * An effort that the catalog lists and the core does not name (`none`, then the core's `Effort`)
 * fails the refresh, so that a new effort is named in the core before a model is offered it. A
 * `toggle` option (reasoning that can be switched off) is the effort `none`.
 *
 * It also writes `src/agent-session/configuration/catalog-models.gen.ts`: what models.dev's catalog
 * says of every other model of the same providers, so that a model that is not well-known is asked
 * with what is known of it (`capabilitiesOf`). A model whose reasoning options cannot be read is
 * left out of it, and the refresh names it.
 *
 *   bun run models:refresh              # from models.dev
 *   bun run models:refresh <api.json>   # from a copy of the catalog
 */

import { readFileSync, writeFileSync } from "node:fs";
import { Effort } from "../../src/agent-machine/settings.ts";

type Json = Record<string, unknown>;

const measuredPath = "src/agent-session/configuration/well-known-models.measured.json";
const generatedPath = "src/agent-session/configuration/well-known-models.gen.ts";

const [from] = process.argv.slice(2);
/** One way models.dev says a model's reasoning is set: by effort, by a budget of thinking tokens, or switched on or off. */
type ReasoningOption = { type: "effort"; values: Array<string> } | { type: "budget_tokens"; min: number; max?: number } | { type: "toggle" } | { type: string };

const catalog = (from === undefined ? await fetch("https://models.dev/api.json").then((response) => response.json()) : JSON.parse(readFileSync(from, "utf8"))) as Record<
  string,
  {
    models: Record<
      string,
      { limit: { context: number; output: number }; modalities: { input: Array<string> }; cost: Json; reasoning?: boolean; reasoning_options?: Array<ReasoningOption> }
    >;
  }
>;
const measured = JSON.parse(readFileSync(measuredPath, "utf8")) as Record<
  string,
  Record<string, { input?: Array<string>; price?: Json; thinking?: Array<string>; thinkingOffUpTo?: string; observe?: Array<string> }>
>;

/** The efforts the core names: `none` (thinking disabled, as a provider's effort), then the core's `Effort`. */
const namedEfforts: ReadonlyArray<string> = ["none", ...Effort.literals];

/**
 * The reasoning fields of a catalog entry: whether it reasons, its efforts, its thinking budget. An
 * option of another kind fails the refresh, so that it is not dropped unseen. An empty list of options
 * is a model that takes no setting for its reasoning, so it takes no effort (measured 2026-10-06:
 * grok-build-0.1 refuses `reasoning.effort`).
 */
function reasoningOf(name: string, reasoning: boolean | undefined, options: ReadonlyArray<ReasoningOption> | undefined): Json {
  const efforts = options?.find((option): option is Extract<ReasoningOption, { type: "effort" }> => option.type === "effort")?.values;
  const budget = options?.find((option): option is Extract<ReasoningOption, { type: "budget_tokens" }> => option.type === "budget_tokens");
  const toggles = options?.some((option) => option.type === "toggle") ?? false;
  const unknown = options?.filter((option) => option.type !== "effort" && option.type !== "budget_tokens" && option.type !== "toggle") ?? [];
  if (unknown.length > 0) throw new Error(`${name}: reasoning options of a kind this script does not read: ${unknown.map((option) => option.type).join(", ")}`);
  const unnamed = efforts?.filter((effort) => !namedEfforts.includes(effort)) ?? [];
  if (unnamed.length > 0) throw new Error(`${name}: efforts the core does not name: ${unnamed.join(", ")} (it names ${namedEfforts.join(", ")})`);
  const none = options !== undefined && options.length === 0;
  // A toggle switches the reasoning off, which the core names as the effort `none`.
  const withNone = toggles ? ["none", ...(efforts ?? []).filter((effort) => effort !== "none")] : efforts;
  return {
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(withNone === undefined ? (none ? { efforts: [] } : {}) : { efforts: withNone }),
    ...(budget === undefined ? {} : { budget: { min: budget.min, ...(budget.max === undefined ? {} : { max: budget.max }) } }),
  };
}

/** A catalog price in this harness's names; its first tier is the price above that tier's context. */
function price(cost: Json): Json {
  const rate = (from: Json): Json => ({
    input: from["input"],
    output: from["output"],
    ...(from["cache_read"] === undefined ? {} : { cacheRead: from["cache_read"] }),
    ...(from["cache_write"] === undefined ? {} : { cacheWrite: from["cache_write"] }),
  });
  const tier = (cost["tiers"] as Array<Json & { tier: { size: number } }> | undefined)?.[0];
  return { ...rate(cost), ...(tier === undefined ? {} : { above: { context: tier.tier.size, ...rate(tier) } }) };
}

const missing: Array<string> = [];
const models = Object.fromEntries(
  Object.entries(measured).map(([provider, listed]) => [
    provider,
    Object.fromEntries(
      Object.entries(listed).flatMap(([model, ours]) => {
        const theirs = catalog[provider]?.models[model];
        if (theirs === undefined) {
          missing.push(`${provider}/${model}`);
          return [];
        }
        const { above, ...base } = price(theirs.cost) as Json & { above?: Json };
        return [
          [
            model,
            {
              context: theirs.limit.context,
              output: theirs.limit.output,
              input: ours.input ?? theirs.modalities.input,
              ...reasoningOf(`${provider}/${model}`, theirs.reasoning, theirs.reasoning_options),
              ...(ours.thinking === undefined ? {} : { thinking: ours.thinking }),
              ...(ours.thinkingOffUpTo === undefined ? {} : { thinkingOffUpTo: ours.thinkingOffUpTo }),
              ...(ours.observe === undefined ? {} : { observe: ours.observe }),
              price: { ...base, ...ours.price, ...(above === undefined ? {} : { above }) },
            },
          ],
        ];
      }),
    ),
  ]),
);
if (missing.length > 0) throw new Error(`The catalog does not list: ${missing.join(", ")}`);

const counted = Object.entries(models).map(([provider, listed]) => `${provider} ${Object.keys(listed).length}`);

/** Every other model of the same providers, from the catalog alone; a model whose reasoning options cannot be read is left out and named. */
const leftOut: Array<string> = [];
const others = Object.fromEntries(
  Object.keys(measured).map((provider) => [
    provider,
    Object.fromEntries(
      Object.entries(catalog[provider]?.models ?? {}).flatMap(([model, theirs]) => {
        if (model in (measured[provider] ?? {})) return [];
        // A price is what the session's cost is counted from; a model without one is left out rather than counted as free.
        if (theirs.cost === undefined) {
          leftOut.push(`${provider}/${model}: the catalog gives no price`);
          return [];
        }
        try {
          const { above, ...base } = price(theirs.cost) as Json & { above?: Json };
          return [
            [
              model,
              {
                context: theirs.limit.context,
                output: theirs.limit.output,
                input: theirs.modalities.input,
                ...reasoningOf(`${provider}/${model}`, theirs.reasoning, theirs.reasoning_options),
                price: { ...base, ...(above === undefined ? {} : { above }) },
              },
            ],
          ];
        } catch (error) {
          leftOut.push(error instanceof Error ? error.message : String(error));
          return [];
        }
      }),
    ),
  ]),
);
const catalogPath = "src/agent-session/configuration/catalog-models.gen.ts";
writeFileSync(
  catalogPath,
  [
    "// Generated by `bun scripts/models/refresh.ts` from models.dev's catalog. Change that script, not this file.",
    "",
    'import type { Capabilities } from "./well-known-models.ts";',
    "",
    "/** What models.dev's catalog says of each model that is not well-known, by provider. */",
    `export const catalogModels: Readonly<Record<string, Readonly<Record<string, Capabilities>>>> = ${JSON.stringify(others, null, 2)};`,
    "",
  ].join("\n"),
);
const catalogued = Object.entries(others).map(([provider, listed]) => `${provider} ${Object.keys(listed).length}`);
console.log(`wrote ${catalogPath}: ${catalogued.join(", ")}`);
for (const reason of leftOut) console.log(`left out of ${catalogPath}: ${reason}`);
writeFileSync(
  generatedPath,
  [
    "// Generated by `bun scripts/models/refresh.ts` from models.dev's catalog and",
    "// `well-known-models.measured.json`. Change those, not this file.",
    "",
    `export const wellKnownModels = ${JSON.stringify(models, null, 2)} as const;`,
    "",
  ].join("\n"),
);
console.log(`wrote ${generatedPath}: ${counted.join(", ")}`);
