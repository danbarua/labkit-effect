/**
 * A session's configuration as ACP's config options (`session/new`, `config_option_update`), and a
 * client's `session/set_config_option` as the change it asks. Both read what `optionsFor` or
 * `optionsOf` says of the configuration, with the models the catalog offers (`askable`) and the
 * model's output limit, so a draft before turn zero and an open session show the same options.
 *
 * Every option is a select with a stable snake_case id:
 *
 * | id | category | values |
 * |---|---|---|
 * | `model` | `model` | `provider/model` of each model offered, and the one asked now |
 * | `effort` | `thought_level` | the efforts the model takes |
 * | `thinking`, `observe`, `cache` | `model_config` | the values the model takes |
 * | `max_output_tokens` | `model_config` | the presets up to the model's limit, the limit, and the value in force |
 *
 * A setting the options do not offer gives no option. An option's current value is what the model
 * will get (a `SettingOption`'s `now`); where nothing is sent for a setting, it is `not_sent`, which
 * is offered only then. A change of a setting names that setting alone, since a change keeps the
 * settings it does not name; choosing `not_sent` while it is the value now changes nothing.
 */

import { Data } from "effect";
import type { SessionConfigOption, SessionConfigOptionCategory, SessionConfigSelectOption } from "../acp/schema/v1.gen.ts";
import { SessionConfigId, SessionConfigValueId } from "../acp/schema/v1.gen.ts";
import { TokenCount } from "../agent-machine/names.ts";
import type { Observation } from "../agent-machine/observation.ts";
import type { ModelSettings } from "../agent-machine/settings.ts";
import type { Options, SettingOption } from "../agent-session/configuration/options.ts";
import type { Asked } from "../agent-host/catalog.ts";

/** What `ModelChangeArrived` carries: the model to ask, and the settings it names. A draft takes the same. */
export type Change = Omit<Extract<Observation, { _tag: "ModelChangeArrived" }>, "_tag">;

/** A `session/set_config_option` that names no option, or a value the option does not offer; the host answers -32602. */
export class InvalidChange extends Data.TaggedError("InvalidChange")<{ readonly reason: string }> {}

/** The output limits offered, up to the model's own (`vscode-workspace.ts` in labkit-agent's `app-acp`). */
const outputPresets: ReadonlyArray<number> = [4096, 8192, 16384, 32768, 65536, 128000];

/** The value of an option whose setting is sent nothing: the setting is unsaid, or the adapter sends nothing for it. */
const notSent = "not_sent";

type Listed = "effort" | "thinking" | "observe" | "cache";

const ids: Readonly<Record<keyof ModelSettings, string>> = {
  effort: "effort",
  thinking: "thinking",
  observe: "observe",
  cache: "cache",
  maxOutputTokens: "max_output_tokens",
};

const described: Readonly<Record<keyof ModelSettings, { readonly name: string; readonly description: string; readonly category: SessionConfigOptionCategory }>> = {
  effort: { name: "Reasoning effort", description: "How much effort the model puts into a response.", category: "thought_level" },
  thinking: {
    name: "Thinking",
    description: "When the model thinks: as it sees fit, before every answer, only between tool calls, or not at all.",
    category: "model_config",
  },
  observe: { name: "Thinking returned", description: "How much of the model's thinking the provider returns to be recorded.", category: "model_config" },
  cache: {
    name: "Prompt cache",
    description: "How long the provider keeps what a request carried, so that later requests beginning the same way read it back.",
    category: "model_config",
  },
  maxOutputTokens: { name: "Maximum output tokens", description: "The most tokens a response may take, thinking and answer together.", category: "model_config" },
};

const valueNames: Readonly<Record<Listed, Readonly<Record<string, string>>>> = {
  effort: { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Maximum" },
  thinking: { auto: "As the model sees fit", before_answer: "Before every answer", between_tools: "Between tool calls", off: "Off" },
  observe: { all: "All of it", progress_only: "Notes on progress only", off: "None" },
  cache: { off: "Off", "5m": "Five minutes", "1h": "An hour" },
};

const value = (id: string, name: string, description?: string): SessionConfigSelectOption => ({
  value: SessionConfigValueId.make(id),
  name,
  ...(description === undefined ? {} : { description }),
});

const notSentValue = value(notSent, "Not set", "No value of this setting is sent to the model.");

/** The models to offer, each with its option value: `models`, then the one asked now when they do not list it. */
const modelsOffered = (options: Options, models: ReadonlyArray<Asked>): ReadonlyArray<Asked & { readonly value: string }> => {
  const listed = models.map((each) => ({ ...each, value: `${each.provider}/${each.model}` }));
  const now = `${options.provider}/${options.model}`;
  return listed.some((each) => each.value === now) ? listed : [...listed, { provider: options.provider, model: options.model, value: now }];
};

/** The output limits to offer: the presets up to `limit`, `limit`, and `now`, least first. */
const outputLimits = (limit: number | undefined, now: number | undefined): ReadonlyArray<number> =>
  [...new Set([...outputPresets.filter((tokens) => limit === undefined || tokens <= limit), ...(limit === undefined ? [] : [limit]), ...(now === undefined ? [] : [now])])].sort(
    (a, b) => a - b,
  );

/** The values of `setting` to offer, by id and name, and the one now; `not_sent` is among them when nothing is sent. */
const valuesOf = (setting: SettingOption, limit: number | undefined): { readonly values: ReadonlyArray<SessionConfigSelectOption>; readonly now: string } => {
  const unsent = setting.now === undefined ? [notSentValue] : [];
  if (setting._tag === "Number") {
    const values = outputLimits(limit, setting.now).map((tokens) => value(String(tokens), tokens.toLocaleString("en-US"), tokens === limit ? "The model's limit" : undefined));
    return { values: [...unsent, ...values], now: setting.now === undefined ? notSent : String(setting.now) };
  }
  const names = valueNames[setting.name as Listed];
  const listed = setting.now === undefined || setting.values.includes(setting.now) ? setting.values : [...setting.values, setting.now];
  return { values: [...unsent, ...listed.map((each) => value(each, names[each] ?? each))], now: setting.now ?? notSent };
};

/**
 * The config options of a session configured as `options`, offering `models` to change to, for a
 * model whose output limit is `limit` (none known: every preset).
 */
export function configOptions(options: Options, models: ReadonlyArray<Asked>, limit: number | undefined): ReadonlyArray<SessionConfigOption> {
  const model: SessionConfigOption = {
    id: SessionConfigId.make("model"),
    name: "Model",
    description: "The model asked, and the provider it is asked of.",
    category: "model",
    type: "select",
    currentValue: SessionConfigValueId.make(`${options.provider}/${options.model}`),
    options: modelsOffered(options, models).map((each) => value(each.value, `${each.model} (${each.provider})`)),
  };
  const settings = options.offered.map((setting): SessionConfigOption => {
    const { values, now } = valuesOf(setting, limit);
    return {
      id: SessionConfigId.make(ids[setting.name]),
      ...described[setting.name],
      type: "select",
      currentValue: SessionConfigValueId.make(now),
      options: values,
    };
  });
  return [model, ...settings];
}

/**
 * The change `session/set_config_option` asks, setting option `configId` to `value`, for a session
 * configured as `options` that offers `models`: the model, or the one setting, chosen. A value the
 * option does not offer (`configOptions` with the same arguments) is an `InvalidChange`.
 */
export function changeOf(configId: string, value: string, options: Options, models: ReadonlyArray<Asked>, limit: number | undefined): Change | InvalidChange {
  const unchanged: Change = { provider: options.provider, model: options.model };
  if (configId === "model") {
    // Found among the values offered, not split: a local model's name can hold slashes.
    const found = modelsOffered(options, models).find((each) => each.value === value);
    return found === undefined ? new InvalidChange({ reason: `${value} is not a model offered.` }) : { provider: found.provider, model: found.model };
  }
  const setting = options.offered.find((each) => ids[each.name] === configId);
  if (setting === undefined) return new InvalidChange({ reason: `No option has the id ${configId}.` });
  const offered = valuesOf(setting, limit).values.some((each) => each.value === value);
  if (!offered) return new InvalidChange({ reason: `${value} is not a value offered for ${described[setting.name].name.toLowerCase()}.` });
  if (value === notSent) return unchanged;
  const said: ModelSettings = setting._tag === "Number" ? { maxOutputTokens: TokenCount.make(Number(value)) } : { [setting.name]: value };
  return { ...unchanged, settings: said };
}
