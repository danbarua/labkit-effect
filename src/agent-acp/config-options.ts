/**
 * A session's configuration as ACP's config options (`session/new`, `config_option_update`), and a
 * client's `session/set_config_option` as the change it asks. Both read the `Options` that
 * `optionsFor` or `optionsOf` returns, with the models the catalog offers (`askable`) and the
 * model's output limit, so a draft before turn zero and an open session show the same options.
 *
 * Every option is a select with a stable snake_case id:
 *
 * | id | category | values |
 * |---|---|---|
 * | `model` | `model` | `provider/model` of each model offered, and the one asked now |
 * | `effort` | `thought_level` | `default`, and the efforts the model takes |
 * | `thinking` | `model_config` | `default`, and the values the model takes |
 * | `max_output_tokens` | `model_config` | `default`, the presets up to the model's limit, the limit, and the value in force |
 * | `permission_mode` | `mode` | the permission modes (`permissionOption`), which the host keeps, not the model |
 *
 * - A setting that the options do not offer has no option.
 * - `observe` (how much of its thinking the provider returns) and `cache` (how long the provider
 *   caches a request) have no option: the editor shows each option as a select above the prompt,
 *   and a session keeps what it was configured with for those two.
 * - An option's current value is what the model will get (a `SettingOption`'s `now`). Where nothing
 *   is sent for a setting, the value is `default`.
 * - A change of a setting names that setting alone, because a change keeps the settings it does not
 *   name. Choosing `default` returns the setting to the provider's default.
 */

import { Array as Arr, Data, Order, Schema } from "effect";
import type { SessionConfigOption, SessionConfigOptionCategory, SessionConfigSelectOption } from "effective-acp/schema/v1";
import { SessionConfigId, SessionConfigValueId } from "effective-acp/schema/v1";
import { TokenCount } from "../agent-machine/names.ts";
import type { Observation } from "../agent-machine/observation.ts";
import type { ModelSettings, SettingsChange } from "../agent-machine/settings.ts";
import type { Options, SettingOption } from "../agent-session/configuration/options.ts";
import type { Asked } from "../agent-host/catalog.ts";
import { PermissionMode } from "../agent-policy/permissions.ts";

/** What `ModelChangeArrived` carries: the model to ask, and the settings it names. A draft takes the same change. */
export type Change = Omit<Extract<Observation, { _tag: "ModelChangeArrived" }>, "_tag">;

/** A `session/set_config_option` that names no option, or a value the option does not offer; the host answers -32602. */
export class InvalidChange extends Data.TaggedError("InvalidChange")<{ readonly reason: string }> {}

/** The output limits offered, up to the model's own (`vscode-workspace.ts` in labkit-agent's `app-acp`). */
const outputPresets: ReadonlyArray<number> = [4096, 8192, 16384, 32768, 65536, 128000];

/** The value of an option for which nothing is sent: the setting is not given, or the adapter sends nothing for it. */
const unset = "default";

/** The settings shown as options. */
type Shown = Exclude<keyof ModelSettings, "observe" | "cache">;
const isShown = (setting: SettingOption): setting is SettingOption & { readonly name: Shown } => setting.name !== "observe" && setting.name !== "cache";

type Listed = "effort" | "thinking";

const ids: Readonly<Record<Shown, string>> = {
  effort: "effort",
  thinking: "thinking",
  maxOutputTokens: "max_output_tokens",
};

const described: Readonly<Record<Shown, { readonly name: string; readonly description: string; readonly category: SessionConfigOptionCategory }>> = {
  effort: { name: "Reasoning effort", description: "How much effort the model puts into a response.", category: "thought_level" },
  thinking: {
    name: "Thinking",
    description: "Whether the model thinks: as the provider decides, not at all, or only between tool calls.",
    category: "model_config",
  },
  maxOutputTokens: { name: "Maximum output tokens", description: "The most tokens a response may take, thinking and answer together.", category: "model_config" },
};

const valueNames: Readonly<Record<Listed, Readonly<Record<string, string>>>> = {
  effort: { default: "The provider's default", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Maximum" },
  thinking: { default: "As the provider decides", disabled: "Off", between_tools: "Between tool calls" },
};

const value = (id: string, name: string, description?: string): SessionConfigSelectOption => ({
  value: SessionConfigValueId.make(id),
  name,
  ...(description === undefined ? {} : { description }),
});

const unsetValue = value(unset, "Default", "Nothing is sent for this setting: the provider's default applies.");

/** Returns the models to offer, each with its option value: `models`, then the model asked now when `models` does not list it. */
const modelsOffered = (options: Options, models: ReadonlyArray<Asked>): ReadonlyArray<Asked & { readonly value: string }> => {
  const listed = models.map((each) => ({ ...each, value: `${each.provider}/${each.model}` }));
  const now = `${options.provider}/${options.model}`;
  return listed.some((each) => each.value === now) ? listed : [...listed, { provider: options.provider, model: options.model, value: now }];
};

/** Returns the output limits to offer: the presets up to `limit`, `limit` itself, and `now`, smallest first. */
const outputLimits = (limit: number | undefined, now: number | undefined): ReadonlyArray<number> =>
  Arr.sort(new Set([...outputPresets.filter((tokens) => limit === undefined || tokens <= limit), ...(limit === undefined ? [] : [limit]), ...(now === undefined ? [] : [now])]), Order.Number);

/** Returns the values of `setting` to offer, by id and name, `default` first, and the current value. */
const valuesOf = (setting: SettingOption, limit: number | undefined): { readonly values: ReadonlyArray<SessionConfigSelectOption>; readonly now: string } => {
  if (setting._tag === "Number") {
    const values = outputLimits(limit, setting.now).map((tokens) => value(String(tokens), tokens.toLocaleString("en-US"), tokens === limit ? "The model's limit" : undefined));
    return { values: [unsetValue, ...values], now: setting.now === undefined ? unset : String(setting.now) };
  }
  const names = valueNames[setting.name as Listed];
  const listed = setting.now === undefined || setting.values.includes(setting.now) ? setting.values : [...setting.values, setting.now];
  return { values: listed.map((each) => (each === unset ? unsetValue : value(each, names[each] ?? each))), now: setting.now ?? unset };
};

/**
 * Returns the config options of a session configured as `options`, offering `models` to change to,
 * for a model whose output limit is `limit` (when no limit is known, every preset is offered).
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
  const settings = options.offered.filter(isShown).map((setting): SessionConfigOption => {
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
 * Returns the change that `session/set_config_option` asks, setting option `configId` to `value`,
 * for a session configured as `options` that offers `models`: the model, or the one setting, chosen.
 * A value that the option does not offer (`configOptions` with the same arguments) is an
 * `InvalidChange`.
 */
export function changeOf(configId: string, value: string, options: Options, models: ReadonlyArray<Asked>, limit: number | undefined): Change | InvalidChange {
  const unchanged: Change = { provider: options.provider, model: options.model };
  if (configId === "model") {
    // Found among the values offered, not split: a local model's name can hold slashes.
    const found = modelsOffered(options, models).find((each) => each.value === value);
    return found === undefined ? new InvalidChange({ reason: `${value} is not a model offered.` }) : { provider: found.provider, model: found.model };
  }
  const setting = options.offered.filter(isShown).find((each) => ids[each.name] === configId);
  if (setting === undefined) return new InvalidChange({ reason: `No option has the id ${configId}.` });
  const offered = valuesOf(setting, limit).values.some((each) => each.value === value);
  if (!offered) return new InvalidChange({ reason: `${value} is not a value offered for ${described[setting.name].name.toLowerCase()}.` });
  const said: SettingsChange = { [setting.name]: value === unset || setting._tag === "OneOf" ? value : TokenCount.make(Number(value)) };
  return { ...unchanged, settings: said };
}

/** The permission modes, in the order offered, with what each does. */
const modes: ReadonlyArray<{ readonly mode: PermissionMode; readonly name: string; readonly description: string }> = [
  { mode: "default", name: "Ask", description: "Ask before a tool that changes something runs; tools that only read run." },
  { mode: "acceptEdits", name: "Accept edits", description: "Edit files without asking; ask before other changes, such as commands." },
  { mode: "bypassPermissions", name: "Run everything", description: "Run every tool without asking." },
  { mode: "dontAsk", name: "Read only", description: "Run only tools that read; refuse the rest without asking." },
];

/** The id of the permission option. */
export const permissionId = "permission_mode";

/** Returns the permission option with current value `mode`: which tool calls run without asking, from the next turn. */
export const permissionOption = (mode: PermissionMode): SessionConfigOption => ({
  id: SessionConfigId.make(permissionId),
  name: "Permissions",
  description: "Which tool calls run without asking, from the next turn.",
  category: "mode",
  type: "select",
  currentValue: SessionConfigValueId.make(mode),
  options: modes.map((each) => value(each.mode, each.name, each.description)),
});

/** Returns the permission mode that `value` names, or an `InvalidChange` saying why it names none. */
export const permissionModeOf = (value: string): PermissionMode | InvalidChange =>
  Schema.is(PermissionMode)(value) ? value : new InvalidChange({ reason: `${value} is not a permission mode: ${modes.map((each) => each.mode).join(", ")}.` });
