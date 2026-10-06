/**
 * The session's model and its settings as the CLI reads them (`--effort`, `--thinking`, `/settings`)
 * and shows them (`inForce`).
 */

import { Effect, Layer, Schema } from "effect";
import { CacheFor, changed, Effort, Observe, SettingsChange, ThinkingMode } from "../../agent-machine/settings.ts";
import { KnownWithLocalServer, SettlingWithLocalServer } from "../../agent-host/local-server.ts";
import type { Target } from "../../agent-session/contracts.ts";
import { optionsFor, type Options } from "../../agent-session/configuration/options.ts";
import type { Session } from "../../agent-session/loop.ts";
import { modelOf } from "../../agent-session/configuration/session-setup.ts";
import { effortsTaken, knownCapabilities, type ModelOverride, ModelOverrides } from "../../agent-session/configuration/well-known-models.ts";
import { invalid } from "./invalid.ts";

/** The settings shown after the model's name: those sent; when none are, `default settings`, unless some are not sent to this model. */
const settingsShown = (sent: ReadonlyArray<string>, notSent: number): string => {
  if (sent.length > 0) return ` · ${sent.join(" ")}`;
  return notSent === 0 ? " · default settings" : "";
};

/**
 * The model and settings the session's next request goes with, in a line (`openai/gpt-5.5 ·
 * effort=low`); then the settings that were given and that this model is not sent, each with the
 * adapter's reason, so that they are not taken for never given; then the efforts the model takes.
 */
export const inForce = (session: Session) =>
  Effect.gen(function* () {
    const facts = yield* session.facts;
    const target = yield* modelOf(facts);
    const sent = Object.entries(target.settings ?? {}).map(([name, value]) => `${name}=${String(value)}`);
    const notSent = new Map(
      facts.flatMap((fact) => {
        if (fact._tag !== "Observed" || fact.observation._tag !== "SettingAdjusted") return [];
        const { provider, model, adjusted, reason } = fact.observation;
        const name = adjusted._tag.charAt(0).toLowerCase() + adjusted._tag.slice(1);
        return provider === target.provider && model === target.model && adjusted.used === undefined && adjusted.asked !== undefined && !(name in (target.settings ?? {}))
          ? [[name, `${name}=${String(adjusted.asked)} (${reason})`] as const]
          : [];
      }),
    );
    const known = yield* knownCapabilities(target.provider, target.model);
    const efforts = effortsTaken(known) ?? [];
    return [
      `${target.provider}/${target.model}${settingsShown(sent, notSent.size)}`,
      ...(notSent.size === 0 ? [] : [`Not sent to this model: ${[...notSent.values()].join(", ")}`]),
      ...(efforts.length === 0 ? [] : [`Efforts: ${efforts.join(", ")}`]),
    ].join("\n");
  });

/** The settings `name=value …` names, as `settingsGiven` reads them. */
export const settingsFrom = (words: ReadonlyArray<string>) =>
  settingsGiven(
    Object.fromEntries(
      words.map((word) => {
        const [name = "", value = ""] = word.split("=");
        return [name, /^\d+$/.test(value) ? Number(value) : value];
      }),
    ),
  );

/** The values each of the model's settings takes, `default` first: a list, or a number of tokens. */
const settingValues: Readonly<Record<keyof SettingsChange, ReadonlyArray<string> | "tokens">> = {
  effort: ["default", ...Effort.literals],
  thinking: ["default", ...ThinkingMode.literals],
  observe: ["default", ...Observe.literals],
  cache: ["default", ...CacheFor.literals],
  maxOutputTokens: "tokens",
};

/** The names of every setting the CLI takes: the model's, then the user's `userSettings`. */
export const settingNames = (userSettings: ReadonlyArray<string>): string => [...Object.keys(settingValues), ...userSettings].join(", ");

const isSetting = (name: string): name is keyof SettingsChange => name in settingValues;

/** The mistake in `name=value` as the model's settings read it: a name that is no setting, or a value the setting does not take; undefined when there is none. */
const mistakeIn = (name: string, value: unknown) => {
  if (!isSetting(name)) return invalid(`Unknown setting: ${name}.`, `The settings are ${settingNames(["view.thinking"])}.`);
  const values = settingValues[name];
  const shown = typeof value === "string" || typeof value === "number" ? String(value) : JSON.stringify(value);
  if (values === "tokens") return value === "default" || (typeof value === "number" && Number.isInteger(value) && value > 0) ? undefined : invalid(`Invalid value for ${name}: ${shown}.`, "Use default, or a number of tokens.");
  return typeof value === "string" && values.includes(value) ? undefined : invalid(`Invalid value for ${name}: ${shown}.`, `Use one of: ${values.join(", ")}.`);
};

/**
 * Settings as the CLI takes them (`/settings`, `/effort`, `--effort`, `--thinking`), read as a change
 * of settings by the core's grammar (`SettingsChange`); a name that is no setting, or a value the
 * setting does not take, is refused, naming it and what the setting takes. `default` returns a
 * setting to the provider's default.
 */
export const settingsGiven = (given: Readonly<Record<string, unknown>>) =>
  Effect.gen(function* () {
    const mistake = Object.entries(given).flatMap(([name, value]) => {
      const found = mistakeIn(name, value);
      return found === undefined ? [] : [found];
    })[0];
    if (mistake !== undefined) return yield* mistake;
    return yield* Schema.decodeEffect(SettingsChange)(given, { onExcessProperty: "error" }).pipe(Effect.mapError((error) => invalid(`Invalid settings: ${error.message}`)));
  });

/**
 * Why the model offered `options` does not take `name=value`: it has no such setting, or the hint of
 * what it takes instead; undefined when it takes the value.
 */
type NotTaken = { readonly _tag: "NoSetting" } | { readonly _tag: "Value"; readonly hint: string };

const notTaken = (options: Options, name: string, value: SettingsChange[keyof SettingsChange]): NotTaken | undefined => {
  if (value === "default" || value === undefined) return undefined;
  const option = options.offered.find((each) => each.name === name);
  if (option === undefined) return { _tag: "NoSetting" };
  if (option._tag === "OneOf") return option.values.includes(String(value)) ? undefined : { _tag: "Value", hint: `Supported: ${option.values.join(", ")}.` };
  const below = option.min !== undefined && Number(value) < option.min;
  const above = option.max !== undefined && Number(value) > option.max;
  if (!below && !above) return undefined;
  const range = [option.min === undefined ? [] : [`from ${option.min}`], option.max === undefined ? [] : [`up to ${option.max}`]].flat().join(" ");
  return { _tag: "Value", hint: `Use default, or a number of tokens ${range}.` };
};

/**
 * Returns `change` when the model of `target` takes each value it names, as `optionsFor` offers them
 * for the target with the change applied, so that values that depend on each other are read together;
 * fails otherwise, saying which value the model does not take and the values it does, or, where the
 * model takes the value alone, the other settings named that it is not taken with. `default` is taken
 * for every setting. The CLI takes only what the model takes, as it offers only that. `from`, when
 * given, names where the settings came from (`the command line`), and the error names it too, with
 * `hints` after its own.
 */
export const takenBy = (target: Target, change: SettingsChange, from?: string, ...hints: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const applying = (named: SettingsChange) => optionsFor({ provider: target.provider, model: target.model, settings: changed(target.settings ?? {}, named) });
    const together = yield* applying(change);
    const entries = Object.entries(change);
    const refusals = yield* Effect.forEach(entries, ([name, value]) =>
      Effect.gen(function* () {
        const found = notTaken(together, name, value);
        if (found === undefined) return [];
        const model = `${target.provider}/${target.model}`;
        const source = from === undefined ? "" : ` (from ${from})`;
        const others = entries.flatMap(([other, given]) => (other === name ? [] : [`${other}=${String(given)}`]));
        // Taken alone, the value is refused only for the other settings named with it.
        const alone = others.length === 0 ? found : notTaken(yield* applying({ [name]: value }), name, value);
        if (alone === undefined) return [invalid(`${model} does not support ${name}=${String(value)}${source}.`, `${name}=${String(value)} cannot be combined with ${others.join(" ")}.`, ...hints)];
        if (alone._tag === "NoSetting") return [invalid(`${model} has no ${name} setting${source}.`, ...hints)];
        return [invalid(`${model} does not support ${name}=${String(value)}${source}.`, alone.hint, ...hints)];
      }),
    );
    const refused = refusals.flat()[0];
    if (refused !== undefined) return yield* refused;
    return change;
  });

/**
 * What the CLI knows of models and their adapters outside a session, as a session knows it
 * (`SessionServices`): the local server's and the well-known models, with the configuration's
 * `overrides` over them.
 */
export const knowledgeWith = (overrides: ReadonlyMap<string, ModelOverride>) =>
  Layer.mergeAll(KnownWithLocalServer, SettlingWithLocalServer).pipe(Layer.provide(Layer.succeed(ModelOverrides, overrides)));

