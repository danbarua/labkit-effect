/**
 * `/settings name=value …` changes the settings named; the rest stay as they were. `/settings`
 * alone shows the settings in force and offers each to change. The settings are:
 *
 * - the model's (`thinking`, `observe`, `effort`, `maxOutputTokens`, `cache`), for this session.
 *   What is offered is what the provider's adapter applies as asked, beside the settings in force: a
 *   setting or value it would adjust is not offered. Typed out, it is still taken, and adjusted. The
 *   change is reported to the session (`ModelChangeArrived`), which takes it between turns.
 * - the user's (`view.thinking`, `user-settings.ts`), which apply at once and are written into the
 *   user's configuration folder.
 *
 * Every setting named is read before any is changed, so a line with a mistake changes nothing.
 * Before a model is picked, only the user's settings are shown and changed.
 */

import { Effect, Ref } from "effect";
import { Prompt } from "effect/cli";
import type { Session } from "../../../agent-session/loop.ts";
import { optionsOf } from "../../../agent-session/configuration/options.ts";
import { modelOf } from "../../../agent-session/configuration/session-setup.ts";
import { type CommandContext, type ReplCommand, said } from "../command.ts";
import { invalid } from "../invalid.ts";
import { inForce, settingsFrom } from "../model-settings.ts";
import { applied, isUserWord, userChangeOf, userSettings, userSettingsLine } from "../user-settings.ts";

/** A setting as the picker offers it: its name, its value in force, and its values; a number when it has none listed. */
interface Pickable {
  readonly name: string;
  readonly now?: string | number;
  readonly values?: ReadonlyArray<string>;
}

const leave = "(leave)";

/** Asks which of `settings` to change and to what; undefined when none is to change. */
const picked = (heading: string, settings: ReadonlyArray<Pickable>) =>
  Effect.gen(function* () {
    const option = yield* Prompt.Select<Pickable | typeof leave>({
      message: `${heading}. Change which setting?`,
      choices: [{ title: "Leave them as they are", value: leave }, ...settings.map((each) => ({ title: each.now === undefined ? each.name : `${each.name} (now ${each.now})`, value: each }))],
    });
    if (option === leave) return undefined;
    const value =
      option.values === undefined
        ? String(yield* Prompt.Int({ message: option.name, min: 1 }))
        : yield* Prompt.Select({ message: option.name, choices: option.values.map((each) => ({ title: each, value: each })) });
    return `${option.name}=${value}`;
  });

/** The user's settings, as the picker offers them, with their values in force. */
const userPickable = ({ view }: CommandContext) =>
  Effect.map(Ref.get(view.thinking), (now): ReadonlyArray<Pickable> => [{ name: "view.thinking", now, values: userSettings["view.thinking"] }]);

/** Applies the user's settings that `words` name, and returns what to say of each. */
const appliedAll = (words: ReadonlyArray<string>, context: CommandContext) =>
  Effect.flatMap(
    Effect.forEach(words, userChangeOf),
    (changes) => Effect.forEach(changes, (change) => applied(change, context)),
  );

export const settings: ReplCommand = {
  name: "/settings",
  args: "[name=value …]",
  says: "Change the settings named; with none, show them and pick one to change",
  // A setting not yet named on the line, then one of its values.
  complete: (words, from) => {
    const options = [...from.settings.map((each) => ({ name: each.name, values: each._tag === "OneOf" ? each.values : [] })), ...Object.entries(userSettings).map(([name, values]) => ({ name, values }))];
    const last = words.at(-1) ?? "";
    const equals = last.indexOf("=");
    if (equals >= 0) {
      const option = options.find((each) => each.name === last.slice(0, equals));
      return option === undefined ? [] : option.values.map((value) => `${option.name}=${value}`);
    }
    const named = new Set(words.slice(1, -1).map((word) => word.split("=")[0]));
    return options.flatMap(({ name }) => (named.has(name) ? [] : [`${name}=`]));
  },
  inSession: (session: Session, words, context) =>
    Effect.gen(function* () {
      const shown = `${yield* inForce(session)}\n${yield* userSettingsLine(context)}`;
      const offered = (yield* optionsOf(yield* session.facts)).offered.map((each): Pickable => ({ name: each.name, ...(each.now === undefined ? {} : { now: each.now }), ...(each._tag === "OneOf" ? { values: each.values } : {}) }));
      const change = words.length === 0 ? yield* picked(shown.split("\n")[0] ?? "", [...offered, ...(yield* userPickable(context))]) : undefined;
      if (words.length === 0 && change === undefined) return said(shown);
      const given = change === undefined ? words : [change];
      const modelWords = given.filter((word) => !isUserWord(word));
      // Every setting is read before any is changed.
      const modelSettings = modelWords.length === 0 ? undefined : yield* settingsFrom(modelWords);
      yield* Effect.forEach(given.filter(isUserWord), userChangeOf);
      const asking =
        modelSettings === undefined
          ? []
          : [
              yield* Effect.gen(function* () {
                const now = yield* modelOf(yield* session.facts);
                yield* session.observe({ _tag: "ModelChangeArrived", provider: now.provider, model: now.model, settings: modelSettings });
                yield* session.idle;
                return `Asking ${yield* inForce(session)}`;
              }),
            ];
      return said([...asking, ...(yield* appliedAll(given.filter(isUserWord), context))].join("\n"));
    }),
  withoutModel: (words, context) =>
    Effect.gen(function* () {
      const change = words.length === 0 ? yield* picked(yield* userSettingsLine(context), yield* userPickable(context)) : undefined;
      if (words.length === 0 && change === undefined) return said(yield* userSettingsLine(context));
      const given = change === undefined ? words : [change];
      const modelWords = given.filter((word) => !isUserWord(word));
      if (modelWords.length > 0) return yield* invalid(`${modelWords.join(" ")}: the model's settings can be changed once a model is picked.`, "Pick one with /model.");
      return said((yield* appliedAll(given, context)).join("\n"));
    }),
};
