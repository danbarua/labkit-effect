/**
 * The players of a live game, named as a person names a model: as `provider/model`, or by its name
 * alone, a well-known model's provider, or `anthropic` for a name that starts with `claude-`,
 * `openai` for one that starts with `gpt-` and `xai` for one that starts with `grok-`. Each player is
 * asked as the CLI asks a model, with its provider's key from the provider's variable
 * (`agent-host/catalog.ts`): `ANTHROPIC_API_KEY` for Claude, `OPENAI_API_KEY` for GPT, `XAI_API_KEY`
 * for Grok. An Adventurer whose model has a customisation (`customisations.ts`) plays with it.
 */
import { known, keyVariables } from "../../agent-host/catalog.ts";
import { ModelName, ProviderName, TokenCount } from "../../agent-machine/names.ts";
import type { ModelSettings } from "../../agent-machine/settings.ts";
import { adventurerCustomisations } from "./customisations.ts";
import type { Adventurer, Player } from "./scenario.ts";

/**
 * The settings each provider's players ask with: short responses, and little thinking. Claude models
 * think at low effort (Haiku 4.5 with a thinking budget of 1,024 tokens), within an output limit that
 * leaves room for it. A GPT model that can turn its reasoning off (gpt-6-luna) does; one that cannot
 * (gpt-6.1-sol, whose adapter records that `disabled` was not sent) reasons at low effort. Grok's
 * models cannot turn their reasoning off, so no thinking setting is given; xAI does not count the
 * reasoning against the output limit.
 */
const settingsOf: Readonly<Record<string, ModelSettings>> = {
  anthropic: { effort: "low", maxOutputTokens: TokenCount.make(4096) },
  openai: { thinking: "disabled", effort: "low", maxOutputTokens: TokenCount.make(4096) },
  xai: { maxOutputTokens: TokenCount.make(1024) },
};

/** The provider of a model that is not well-known, by the start of its name. */
const namePrefixes: Readonly<Record<string, string>> = { "claude-": "anthropic", "gpt-": "openai", "grok-": "xai" };

/** The provider of `named`, and the model's name: as `provider/model`, a well-known model's, or by the name's start. */
const providerOf = (named: string): { readonly provider: string | undefined; readonly model: string } => {
  const slash = named.indexOf("/");
  if (slash > 0) return { provider: named.slice(0, slash), model: named.slice(slash + 1) };
  const wellKnown = Object.keys(settingsOf).find((each) => named in (known[each] ?? {}));
  const byName = Object.entries(namePrefixes).find(([prefix]) => named.startsWith(prefix))?.[1];
  return { provider: wellKnown ?? byName, model: named };
};

/** Why there is no player for a model: its name is not one of a Claude, GPT or Grok model, or its provider's key is not set. */
export type Unavailable =
  | { readonly _tag: "UnknownModel"; readonly named: string }
  | { readonly _tag: "KeyNotSet"; readonly model: string; readonly variable: string };

/** Returns the player for `named`, or why there is none; `env` holds the providers' keys. */
export const playerFor = (named: string, env: Readonly<Record<string, string | undefined>> = process.env): Player | Unavailable => {
  const { provider, model } = providerOf(named);
  const settings = provider === undefined ? undefined : settingsOf[provider];
  const variable = provider === undefined ? undefined : keyVariables[provider];
  if (provider === undefined || settings === undefined || variable === undefined) return { _tag: "UnknownModel", named };
  if ((env[variable] ?? "").trim() === "") return { _tag: "KeyNotSet", model, variable };
  return { target: { provider: ProviderName.make(provider), model: ModelName.make(model), settings } };
};

/** Returns the adventurer for `named`: its player, with the customisation for its model when there is one; or why there is none. */
export const adventurerFor = (named: string, env: Readonly<Record<string, string | undefined>> = process.env): Adventurer | Unavailable => {
  const player = playerFor(named, env);
  if ("_tag" in player) return player;
  const customise = adventurerCustomisations[`${player.target.provider}/${player.target.model}`];
  return customise === undefined ? player : { ...player, customise };
};
