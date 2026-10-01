/**
 * The REPL's own commands: lines that start with `/` and do not go to the model.
 *
 * - `/model <name>` asks another model from the next turn on: a model `models.json` lists, or
 *   `provider/model`. `/model` alone shows the model being asked and offers the known ones to pick.
 * - `/settings` shows the settings in force. `/settings name=value …` changes the ones named
 *   (`thinking`, `observe`, `effort`, `maxOutputTokens`, `cache`); the rest stay as they were.
 *
 * Both report a change of model to the session (`ModelChangeArrived`), which takes it between
 * turns; what a model does not allow is enforced, and recorded, when it is next asked.
 */

import { Effect, Schema } from "effect";
import { Prompt } from "effect/cli";
import { ModelSettings } from "../../agent-machine/settings.ts";
import type { Session } from "../../agent-session/loop.ts";
import { modelOf } from "../../agent-session/session-setup.ts";
import { invalid } from "./invalid.ts";
import { keyOf, known, targetOf } from "./models.ts";

/** Each command and what it says of itself in `/help`. */
export const commands: ReadonlyArray<readonly [string, string]> = [
  ["/model [name]", "Ask another model; with no name, pick one"],
  ["/settings [name=value …]", "Show the settings, or change the ones named"],
  ["/help", "Show these commands"],
  ["/exit", "Quit (also /quit)"],
];

export const help = (): string => {
  const width = Math.max(...commands.map(([name]) => name.length)) + 2;
  return [...commands.map(([name, says]) => `${name.padEnd(width)}${says}`), "Anything else goes to the model."].join("\n");
};

/** The model and settings the session's next request goes with, in a line. */
export const inForce = (session: Session) =>
  Effect.gen(function* () {
    const target = yield* modelOf(yield* session.facts);
    const said = Object.entries(target.settings ?? {}).map(([name, value]) => `${name}=${String(value)}`);
    return `${target.provider}/${target.model}${said.length === 0 ? " (no settings said)" : ` ${said.join(" ")}`}`;
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
        if (words.length === 0) return yield* inForce(session);
        const settings = yield* settingsFrom(words);
        const now = yield* modelOf(yield* session.facts);
        yield* session.observe({ _tag: "ModelChangeArrived", provider: now.provider, model: now.model, settings });
        yield* session.idle;
        return `Asking ${yield* inForce(session)}`;
      }
      default:
        return undefined;
    }
  });
