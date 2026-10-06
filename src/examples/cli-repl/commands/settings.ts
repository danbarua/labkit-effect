/**
 * `/settings name=value …` changes the settings named (`thinking`, `observe`, `effort`,
 * `maxOutputTokens`, `cache`); the rest stay as they were. `/settings` alone shows the settings in
 * force and offers each to change. What is offered is what the provider's adapter applies as asked,
 * beside the settings in force: a setting or value it would adjust is not offered. Typed out, it is
 * still taken, and adjusted.
 *
 * The change is reported to the session (`ModelChangeArrived`), which takes it between turns.
 */

import { Effect } from "effect";
import { Prompt } from "effect/cli";
import type { Session } from "../../../agent-session/loop.ts";
import { optionsOf, type SettingOption } from "../../../agent-session/configuration/options.ts";
import { modelOf } from "../../../agent-session/configuration/session-setup.ts";
import { type ReplCommand, said } from "../command.ts";
import { inForce, settingsFrom } from "../model-settings.ts";

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


export const settings: ReplCommand = {
  name: "/settings",
  args: "[name=value …]",
  says: "Change the settings named; with none, show them and pick one to change",
  // A setting not yet named on the line, then one of its values.
  complete: (words, from) => {
    const last = words.at(-1) ?? "";
    const equals = last.indexOf("=");
    if (equals >= 0) {
      const option = from.settings.find((each) => each.name === last.slice(0, equals));
      return option?._tag === "OneOf" ? option.values.map((value) => `${option.name}=${value}`) : [];
    }
    const named = new Set(words.slice(1, -1).map((word) => word.split("=")[0]));
    return from.settings.flatMap(({ name }) => (named.has(name) ? [] : [`${name}=`]));
  },
  inSession: (session, words) =>
    Effect.gen(function* () {
      const change = words.length === 0 ? yield* picked(session) : undefined;
      if (words.length === 0 && change === undefined) return said(yield* inForce(session));
      const given = yield* settingsFrom(change === undefined ? words : [change]);
      const now = yield* modelOf(yield* session.facts);
      yield* session.observe({ _tag: "ModelChangeArrived", provider: now.provider, model: now.model, settings: given });
      yield* session.idle;
      return said(`Asking ${yield* inForce(session)}`);
    }),
};
