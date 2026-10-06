/**
 * The session's model settings: parsing them from `--effort`, `--thinking` and `/settings`, checking
 * them against the model, and showing them (`inForce`).
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

/** The settings shown after the model's name: those set, else `default settings`, unless some are not sent to this model. */
const settingsShown = (sent: ReadonlyArray<string>, notSent: number): string => {
  if (sent.length > 0) return ` · ${sent.join(" ")}`;
  return notSent === 0 ? " · default settings" : "";
};

/**
 * Returns the model and settings for the session's next request on one line (`openai/gpt-5.5 ·
 * effort=low`); then the settings that are set but not sent to this model, each with the adapter's
 * reason; then the efforts the model supports.
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

/** Parses `name=value …` words into settings (`settingsGiven`). */
export const settingsFrom = (words: ReadonlyArray<string>) =>
  settingsGiven(
    Object.fromEntries(
      words.map((word) => {
        const [name = "", value = ""] = word.split("=");
        return [name, /^\d+$/.test(value) ? Number(value) : value];
      }),
    ),
  );

/** The values each model setting accepts, `default` first: a list, or a number of tokens. */
const settingValues: Readonly<Record<keyof SettingsChange, ReadonlyArray<string> | "tokens">> = {
  effort: ["default", ...Effort.literals],
  thinking: ["default", ...ThinkingMode.literals],
  observe: ["default", ...Observe.literals],
  cache: ["default", ...CacheFor.literals],
  maxOutputTokens: "tokens",
};

/** The names of every setting: the model's, then the CLI's own (`userSettings`). */
export const settingNames = (userSettings: ReadonlyArray<string>): string => [...Object.keys(settingValues), ...userSettings].join(", ");

const isSetting = (name: string): name is keyof SettingsChange => name in settingValues;

/** Returns the error for `name=value`: an unknown setting or an invalid value; undefined when it is valid. */
const mistakeIn = (name: string, value: unknown) => {
  if (!isSetting(name)) return invalid(`Unknown setting: ${name}.`, `The settings are ${settingNames(["view.thinking"])}.`);
  const values = settingValues[name];
  const shown = typeof value === "string" || typeof value === "number" ? String(value) : JSON.stringify(value);
  if (values === "tokens") return value === "default" || (typeof value === "number" && Number.isInteger(value) && value > 0) ? undefined : invalid(`Invalid value for ${name}: ${shown}.`, "Use default, or a number of tokens.");
  return typeof value === "string" && values.includes(value) ? undefined : invalid(`Invalid value for ${name}: ${shown}.`, `Use one of: ${values.join(", ")}.`);
};

/**
 * Parses settings given to the CLI (`/settings`, `/effort`, `--effort`, `--thinking`) into a
 * `SettingsChange`. An unknown setting or an invalid value fails, naming it and the valid values.
 * `default` returns a setting to the provider's default.
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

/** Why a model with `options` does not support `name=value`: it has no such setting, or a hint listing what it supports; undefined when it supports the value. */
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
 * Returns `change` when `target`'s model supports every value it names, checked with the whole change
 * applied, since some values depend on others (`optionsFor`). Otherwise it fails, naming the value
 * and either the supported values or, when the value is supported on its own, the other settings it
 * cannot be combined with. `default` is always accepted. `from` names where the settings came from
 * (`the command line`) in the error, and `hints` are added after its own.
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
        // Supported on its own, the value conflicts only with the other settings on the line.
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
 * Model knowledge for checks outside a session, the same as a session's (`SessionServices`): the
 * local server's models and the well-known models, with the configuration's `overrides` applied.
 */
export const knowledgeWith = (overrides: ReadonlyMap<string, ModelOverride>) =>
  Layer.mergeAll(KnownWithLocalServer, SettlingWithLocalServer).pipe(Layer.provide(Layer.succeed(ModelOverrides, overrides)));

