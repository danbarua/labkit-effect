/**
 * The REPL's own commands: lines that start with `/` and do not go to the model.
 *
 * - `/model <name>` asks another model from the next turn on: a well-known model, or
 *   `provider/model`. `/model` alone shows the model being asked and offers the known ones to pick.
 * - `/settings name=value …` changes the settings named (`thinking`, `observe`, `effort`,
 *   `maxOutputTokens`, `cache`); the rest stay as they were. `/settings` alone shows the settings
 *   in force and offers each to change. What is offered is what the provider's adapter applies as
 *   asked, beside the settings in force: a setting or value it would adjust is not offered. Typed
 *   out, it is still taken, and adjusted.
 *
 * `completions` gives the prompt what a line that starts with `/` could become: a command, then a
 * model's name or a setting and its values.
 *
 * Both report a change of model to the session (`ModelChangeArrived`), which takes it between
 * turns; what a model does not allow is adjusted, and recorded, when it is next asked.
 */

import { Effect, Schema } from "effect";
import { Prompt } from "effect/cli";
import { ModelSettings } from "../../agent-machine/settings.ts";
import type { Session } from "../../agent-session/loop.ts";
import { KnownModels } from "../../agent-session/configuration/well-known-models.ts";
import { modelOf } from "../../agent-session/configuration/session-setup.ts";
import { optionsOf, type SettingOption } from "../../agent-session/configuration/options.ts";
import { invalid } from "./invalid.ts";
import { keyOf, known, targetOf } from "./models.ts";

/** Each command and what it says of itself in `/help`. */
export const commands: ReadonlyArray<readonly [string, string]> = [
  ["/model [name]", "Ask another model; with no name, pick one"],
  ["/settings [name=value …]", "Change the settings named; with none, show them and pick one to change"],
  ["/help", "Show these commands"],
  ["/exit", "Quit (also /quit)"],
];

export const help = (): string => {
  const width = Math.max(...commands.map(([name]) => name.length)) + 2;
  return [...commands.map(([name, says]) => `${name.padEnd(width)}${says}`), "Anything else goes to the model."].join("\n");
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
    const known = yield* (yield* KnownModels)(target.provider, target.model);
    return [
      `${target.provider}/${target.model}${sent.length === 0 ? (notSent.size === 0 ? " (no settings said)" : "") : ` ${sent.join(" ")}`}`,
      ...(notSent.size === 0 ? [] : [`not sent to this model: ${[...notSent.values()].join(", ")}`]),
      ...(known?.efforts === undefined ? [] : [`this model takes effort: ${known.efforts.join(", ")}`]),
    ].join("\n");
  });

/** The settings `name=value …` names, as the core's grammar reads them; a name or value it does not know is said. */
export const settingsFrom = (words: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    // What was typed is not yet known to be settings: the schema says.
    const given: unknown = Object.fromEntries(
      words.map((word) => {
        const [name = "", value = ""] = word.split("=");
        return [name, /^\d+$/.test(value) ? Number(value) : value];
      }),
    );
    return yield* Schema.decodeUnknownEffect(ModelSettings)(given, { onExcessProperty: "error" }).pipe(
      Effect.mapError((error) => invalid(`Not settings the session takes: ${error.message}`)),
    );
  });

/** The known models whose provider has a key set, for picking. */
const pickable = () =>
  Object.entries(known).flatMap(([provider, models]) =>
    keyOf(provider) === undefined ? [] : Object.keys(models).map((model) => ({ title: `${provider}/${model}`, value: `${provider}/${model}` })),
  );

/** What a line can be completed from: the models that can be asked, and the settings to offer for the model being asked, as it is set now. */
export interface Offered {
  readonly models: ReadonlyArray<string>;
  readonly settings: ReadonlyArray<SettingOption>;
}

export const offered = (session: Session) =>
  Effect.gen(function* () {
    const result: Offered = { models: pickable().map((each) => each.value), settings: (yield* optionsOf(yield* session.facts)).offered };
    return result;
  });

/** A command's name as it is typed: with a space after it when words can follow. */
const typedAs = [...commands.map(([usage]) => (usage.includes(" ") ? `${usage.slice(0, usage.indexOf(" "))} ` : usage)), "/quit"];

/**
 * The lines that `text` could become, when it starts with `/`: its last word completed to a command,
 * to a model after `/model`, or after `/settings` to a setting not yet named on the line and then to
 * one of its values.
 */
export const completions =
  (from: Offered) =>
  (text: string): ReadonlyArray<string> => {
    if (!text.startsWith("/") || text.includes("\n")) return [];
    const words = text.split(" ");
    const last = words.at(-1) ?? "";
    const before = text.slice(0, text.length - last.length);
    const candidates = (): ReadonlyArray<string> => {
      if (words.length === 1) return typedAs;
      if (words[0] === "/model") return words.length === 2 ? from.models : [];
      if (words[0] !== "/settings") return [];
      const equals = last.indexOf("=");
      if (equals >= 0) {
        const option = from.settings.find((each) => each.name === last.slice(0, equals));
        return option?._tag === "OneOf" ? option.values.map((value) => `${option.name}=${value}`) : [];
      }
      const named = new Set(words.slice(1, -1).map((word) => word.split("=")[0]));
      return from.settings.flatMap(({ name }) => (named.has(name) ? [] : [`${name}=`]));
    };
    return candidates().flatMap((each) => (each.startsWith(last) ? [before + each] : []));
  };

const leave = "(leave)";

/** Asks which setting to change and to what, among the ones offered; undefined when none is to change. */
const picked = (session: Session) =>
  Effect.gen(function* () {
    const { offered: settings } = yield* optionsOf(yield* session.facts);
    const option = yield* Prompt.Select<SettingOption | typeof leave>({
      message: `${(yield* inForce(session)).split("\n")[0] ?? ""}. Change which setting?`,
      choices: [
        { title: "Leave them as they are", value: leave },
        ...settings.map((each) => ({ title: each.now === undefined ? each.name : `${each.name} (now ${each.now})`, value: each })),
      ],
    });
    if (option === leave) return undefined;
    const value =
      option._tag === "Number"
        ? String(yield* Prompt.Int({ message: option.name, min: 1 }))
        : yield* Prompt.Select({ message: option.name, choices: option.values.map((each) => ({ title: each, value: each })) });
    return `${option.name}=${value}`;
  });

/** Runs the command `line` names, and returns what to print; undefined when `line` is not one of these commands. */
export const command = (session: Session, line: string) =>
  Effect.gen(function* () {
    const [name, ...words] = line.trim().split(/\s+/);
    switch (name) {
      case "/help":
        return help();
      case "/model": {
        const now = yield* modelOf(yield* session.facts);
        const chosen = words[0] ?? (yield* Prompt.Select({ message: `Asking ${now.provider}/${now.model}. Ask which model?`, choices: pickable() }));
        const target = yield* targetOf(chosen);
        yield* session.observe({ _tag: "ModelChangeArrived", provider: target.provider, model: target.model });
        yield* session.idle;
        return `Asking ${yield* inForce(session)}`;
      }
      case "/settings": {
        const change = words.length === 0 ? yield* picked(session) : undefined;
        if (words.length === 0 && change === undefined) return yield* inForce(session);
        const settings = yield* settingsFrom(change === undefined ? words : [change]);
        const now = yield* modelOf(yield* session.facts);
        yield* session.observe({ _tag: "ModelChangeArrived", provider: now.provider, model: now.model, settings });
        yield* session.idle;
        return `Asking ${yield* inForce(session)}`;
      }
      default:
        return undefined;
    }
  });
