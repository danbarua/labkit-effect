/**
 * `/effort <effort>` sets the effort of this session's requests: `default`, or an effort that the
 * model takes (`takenBy`). `/effort` alone sets the next value offered (`optionsOf`: `default`, then
 * the model's efforts, least first) after the one in force, and from the last goes back to
 * `default`. A model offered no effort is said so.
 *
 * The change is reported to the session (`ModelChangeArrived`), which takes it between turns.
 */

import { Effect } from "effect";
import { optionsOf, type SettingOption } from "../../../agent-session/configuration/options.ts";
import { type ReplCommand, said } from "../command.ts";
import { invalid } from "../invalid.ts";
import { modelOf } from "../../../agent-session/configuration/session-setup.ts";
import { inForce, settingsGiven, takenBy } from "../model-settings.ts";

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
        const at = option.values.indexOf(option.now ?? "default");
        return Effect.succeed(option.values[(at + 1) % option.values.length] ?? "default");
      };
      const settings = yield* takenBy(yield* modelOf(yield* session.facts), yield* settingsGiven({ effort: words[0] ?? (yield* next()) }));
      yield* session.observe({ _tag: "ModelChangeArrived", provider, model, settings });
      yield* session.idle;
      return said(`Asking ${yield* inForce(session)}`);
    }),
};
