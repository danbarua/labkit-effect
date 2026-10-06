/**
 * The session's model and its settings as the CLI reads them (`--effort`, `--thinking`, `/settings`)
 * and shows them (`inForce`).
 */

import { Effect, Layer, Schema } from "effect";
import { changed, SettingsChange } from "../../agent-machine/settings.ts";
import { KnownWithLocalServer, SettlingWithLocalServer } from "../../agent-host/local-server.ts";
import type { Target } from "../../agent-session/contracts.ts";
import { optionsFor, type Options } from "../../agent-session/configuration/options.ts";
import type { Session } from "../../agent-session/loop.ts";
import { modelOf } from "../../agent-session/configuration/session-setup.ts";
import { effortsTaken, knownCapabilities, type ModelOverride, ModelOverrides } from "../../agent-session/configuration/well-known-models.ts";
import { invalid } from "./invalid.ts";

/** The settings said after the model's name: those sent; when none are, saying so unless some were not sent to this model. */
const settingsSaid = (sent: ReadonlyArray<string>, notSent: number): string => {
  if (sent.length > 0) return ` ${sent.join(" ")}`;
  return notSent === 0 ? " (no settings said)" : "";
};

/**
 * The model and settings the session's next request goes with, in a line; then the settings that
 * were said and that this model was not sent, with the adapter's reason, so they are not taken for
 * never said.
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
      `${target.provider}/${target.model}${settingsSaid(sent, notSent.size)}`,
      ...(notSent.size === 0 ? [] : [`not sent to this model: ${[...notSent.values()].join(", ")}`]),
      ...(efforts.length === 0 ? [] : [`this model takes effort: ${efforts.join(", ")}`]),
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

/**
 * Settings as the CLI takes them (`/settings`, `/effort`, `--effort`, `--thinking`), read as a change
 * of settings by the core's grammar (`SettingsChange`); a name or value the grammar does not know is
 * refused, saying why. `default` returns a setting to the provider's default.
 */
export const settingsGiven = (given: Readonly<Record<string, unknown>>) =>
  Schema.decodeEffect(SettingsChange)(given, { onExcessProperty: "error" }).pipe(Effect.mapError((error) => invalid(`Not settings the session takes: ${error.message}`)));

/** The hint of why the model offered `options` does not take `name=value`; undefined when it does. */
const notTaken = (options: Options, name: string, value: SettingsChange[keyof SettingsChange]): string | undefined => {
  if (value === "default" || value === undefined) return undefined;
  const option = options.offered.find((each) => each.name === name);
  if (option === undefined) return `${options.provider}/${options.model} takes no ${name} setting.`;
  if (option._tag === "OneOf") return option.values.includes(String(value)) ? undefined : `${name} takes ${option.values.join(", ")}.`;
  const below = option.min !== undefined && Number(value) < option.min;
  const above = option.max !== undefined && Number(value) > option.max;
  if (!below && !above) return undefined;
  const range = [option.min === undefined ? [] : [`at least ${option.min}`], option.max === undefined ? [] : [`at most ${option.max}`]].flat().join(" and ");
  return `${name} takes default, or ${range} tokens.`;
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
        const hint = notTaken(together, name, value);
        if (hint === undefined) return [];
        const others = entries.flatMap(([other, given]) => (other === name ? [] : [`${other}=${String(given)}`]));
        const alone = others.length === 0 ? hint : notTaken(yield* applying({ [name]: value }), name, value);
        const said = alone === undefined ? `${name}=${String(value)} is not taken with ${others.join(" ")}.` : hint;
        return [invalid(`${target.provider}/${target.model} does not take ${name}=${String(value)}${from === undefined ? "" : ` (from ${from})`}.`, said, ...hints)];
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

