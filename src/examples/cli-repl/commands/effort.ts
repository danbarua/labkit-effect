/**
 * `/effort <effort>` sets the effort of this session's requests. `/effort` alone sets the next of
 * the efforts this model is offered (`optionsOf`), after the effort in force, and from the last goes
 * back to the first; with no effort in force, it sets the first. A model offered no effort is said so.
 *
 * The change is reported to the session (`ModelChangeArrived`), which takes it between turns. Effort
 * `none` is `thinking=off` (`settingsGiven`); it is taken when typed, but it is not among the efforts
 * offered, so `/effort` alone does not set it.
 */

import { Effect } from "effect";
import { optionsOf, type SettingOption } from "../../../agent-session/configuration/options.ts";
import { type ReplCommand, said } from "../command.ts";
import { invalid } from "../invalid.ts";
import { inForce, settingsGiven } from "../model-settings.ts";

/** The effort offered, with its values, among `settings`; undefined when none is offered. */
const effortIn = (settings: ReadonlyArray<SettingOption>) => settings.find((each) => each._tag === "OneOf" && each.name === "effort");

export const effort: ReplCommand = {
  name: "/effort",
  args: "[effort]",
  says: "Set the effort; with none, the next effort this model takes",
  complete: (words, from) => {
    const offered = effortIn(from.settings);
    return words.length === 2 && offered?._tag === "OneOf" ? offered.values : [];
  },
  inSession: (session, words) =>
    Effect.gen(function* () {
      const { provider, model, offered } = yield* optionsOf(yield* session.facts);
      const next = (): Effect.Effect<string, ReturnType<typeof invalid>> => {
        const option = effortIn(offered);
        if (option?._tag !== "OneOf" || option.values.length === 0) return Effect.fail(invalid(`${provider}/${model} is offered no effort.`));
        const at = option.now === undefined ? -1 : option.values.indexOf(option.now);
        return Effect.succeed(option.values[(at + 1) % option.values.length] ?? "");
      };
      const settings = yield* settingsGiven({ effort: words[0] ?? (yield* next()) });
      yield* session.observe({ _tag: "ModelChangeArrived", provider, model, settings });
      yield* session.idle;
      return said(`Asking ${yield* inForce(session)}`);
    }),
};
