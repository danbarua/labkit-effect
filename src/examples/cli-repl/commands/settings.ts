/**
 * `/settings name=value …` changes the settings named and leaves the rest. `/settings` alone shows
 * the current settings and a picker to change one. There are two kinds:
 *
 * - The model's settings (`effort`, `thinking`, `observe`, `cache`, `maxOutputTokens`), for this
 *   session. Only values the model supports with the other current settings are offered and accepted
 *   (`optionsOf`, `takenBy`), plus `default`, which returns a setting to the provider's default. The
 *   output limit is accepted when typed but not offered, since it defaults to the model's own. The
 *   change is reported to the session (`ModelChangeArrived`), which applies it between turns.
 * - The CLI's own settings (`view.thinking`, `user-settings.ts`), which apply at once and are saved
 *   to the user's configuration folder.
 *
 * Every setting on the line is checked before any is changed, so a line with an error changes
 * nothing. Before a model is picked, only the CLI's own settings can be shown and changed.
 */

import { Effect, Ref } from "effect";
import { Prompt } from "effect/cli";
import type { Session } from "../../../agent-session/loop.ts";
import { optionsOf, type SettingOption } from "../../../agent-session/configuration/options.ts";
import { modelOf } from "../../../agent-session/configuration/session-setup.ts";
import { type CommandContext, type ReplCommand, said } from "../command.ts";
import { invalid } from "../invalid.ts";
import { inForce, settingsFrom, takenBy } from "../model-settings.ts";
import { applied, isUserWord, userChangeOf, userSettings, userSettingsLine } from "../user-settings.ts";

/** A setting in the picker: its name, current value, and values; a number from `min` when it has no listed values. */
interface Pickable {
  readonly name: string;
  readonly now?: string | number;
  readonly values?: ReadonlyArray<string>;
  readonly min?: number;
}

/** Whether completion and the picker list a setting: all but the output limit, which defaults to the model's own (typed, it is accepted). */
const listed = (option: SettingOption): boolean => option.name !== "maxOutputTokens";

/** A model setting as the picker shows it. */
const pickableOf = (option: SettingOption): Pickable => {
  const now = option.now === undefined ? {} : { now: option.now };
  if (option._tag === "OneOf") return { name: option.name, ...now, values: option.values };
  return { name: option.name, ...now, ...(option.min === undefined ? {} : { min: option.min }) };
};

const leave = "(leave)";

/** Asks which of `settings` to change and to what; undefined when the user leaves them unchanged. */
const picked = (heading: string, settings: ReadonlyArray<Pickable>) =>
  Effect.gen(function* () {
    const option = yield* Prompt.Select<Pickable | typeof leave>({
      message: `${heading}. Change which setting?`,
      choices: [{ title: "Leave them as they are", value: leave }, ...settings.map((each) => ({ title: each.now === undefined ? each.name : `${each.name} (now ${each.now})`, value: each }))],
    });
    if (option === leave) return undefined;
    const value =
      option.values === undefined
        ? String(yield* Prompt.Int({ message: option.name, min: option.min ?? 1 }))
        : yield* Prompt.Select({ message: option.name, choices: option.values.map((each) => ({ title: each, value: each })) });
    return `${option.name}=${value}`;
  });

/** The CLI's own settings as the picker shows them, with their current values. */
const userPickable = ({ view }: CommandContext) =>
  Effect.map(Ref.get(view.thinking), (now): ReadonlyArray<Pickable> => [{ name: "view.thinking", now, values: userSettings["view.thinking"] }]);

/** Applies the CLI settings `words` name, and returns a line about each. */
const appliedAll = (words: ReadonlyArray<string>, context: CommandContext) =>
  Effect.flatMap(
    Effect.forEach(words, userChangeOf),
    (changes) => Effect.forEach(changes, (change) => applied(change, context)),
  );

export const settings: ReplCommand = {
  name: "/settings",
  args: "[name=value …]",
  says: "Change the settings named; with none, show them and pick one",
  // A setting not already on the line, then one of its values.
  complete: (words, from) => {
    const options = [...from.settings.filter(listed).map((each) => ({ name: each.name, values: each._tag === "OneOf" ? each.values : [] })), ...Object.entries(userSettings).map(([name, values]) => ({ name, values }))];
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
      const offered = (yield* optionsOf(yield* session.facts)).offered.filter(listed).map(pickableOf);
      const change = words.length === 0 ? yield* picked(shown.split("\n")[0] ?? "", [...offered, ...(yield* userPickable(context))]) : undefined;
      if (words.length === 0 && change === undefined) return said(shown);
      const given = change === undefined ? words : [change];
      const modelWords = given.filter((word) => !isUserWord(word));
      // Every setting is checked before any is changed, and model settings only where the model supports them.
      const modelSettings = modelWords.length === 0 ? undefined : yield* takenBy(yield* modelOf(yield* session.facts), yield* settingsFrom(modelWords));
      yield* Effect.forEach(given.filter(isUserWord), userChangeOf);
      const asking =
        modelSettings === undefined
          ? []
          : [
              yield* Effect.gen(function* () {
                const now = yield* modelOf(yield* session.facts);
                yield* session.observe({ _tag: "ModelChangeArrived", provider: now.provider, model: now.model, settings: modelSettings });
                yield* session.idle;
                return `${yield* inForce(session)}`;
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
      if (modelWords.length > 0) return yield* invalid(`${modelWords.join(" ")} needs a model.`, "Pick one with /model.");
      return said((yield* appliedAll(given, context)).join("\n"));
    }),
};
